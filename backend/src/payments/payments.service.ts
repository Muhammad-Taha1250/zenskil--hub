import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CustomerState, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CustomersService, StateTransitionActor } from '../customers/customers.service';
import { canTransition } from '../customers/state-machine';
import { SettingsService } from '../settings/settings.service';
import {
  CreatePaymentInput,
  ManualTransferProvider,
  PaymentInstructions,
  PaymentProvider,
  ProviderPaymentEvent,
  RefundDescriptor,
  TRANSFER_DETAILS_DRAFT,
} from './providers/payment-provider.interface';

export type ManualDecision = 'APPROVE' | 'REJECT';

export interface WebhookOutcome {
  outcome: 'confirmed' | 'duplicate' | 'manual_review' | 'pending_verification';
  paymentId?: string;
  orderId?: string;
  detail?: string;
}

// Payment state machine (PaymentStatus):
//   PENDING → PROCESSING → PAID | FAILED
//   PENDING → MANUAL_REVIEW_REQUIRED → PAID | PENDING (rejected proof)
//   PAID → REFUNDED | PARTIALLY_REFUNDED   (refunds module)
//
// Invariants (spec §15/§16):
// - Customer claims, screenshots, and button clicks can NEVER set PAID.
//   PAID requires a verified provider webhook OR an authorized admin decision.
// - Webhook claims are re-verified with the provider; amount must match the
//   order total paisa-exact and currency must be PKR, or the payment goes to
//   MANUAL_REVIEW_REQUIRED instead of auto-confirming.
// - All money movement is transactional and idempotent.
@Injectable()
export class PaymentsService {
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
    private readonly settings: SettingsService,
  ) {
    this.registerProvider(new ManualTransferProvider(() => this.transferDetailsText()));
  }

  registerProvider(provider: PaymentProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** Owner-configured receiving account/wallet lines (D6), or the DRAFT placeholder. */
  async transferDetailsText(): Promise<string> {
    const details = await this.settings.getSetting<Record<string, string> | null>(
      'payment.instructions',
      null,
    );
    if (!details || Object.keys(details).length === 0) return TRANSFER_DETAILS_DRAFT;
    return Object.entries(details)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
  }

  /**
   * Customer/admin-facing payment instructions for a payment row. This is the
   * single source the WhatsApp flow and the admin panel read — the transfer
   * details come from the `payment.instructions` setting, never from code.
   */
  async getPaymentInstructions(paymentId: string): Promise<PaymentInstructions> {
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { order: true },
    });
    const provider = this.providers.get(payment.provider);
    if (!provider) throw new BadRequestException(`Unknown payment provider: ${payment.provider}`);
    const input: CreatePaymentInput = {
      orderId: payment.orderId,
      orderNumber: payment.order.orderNumber,
      amountPaisa: payment.amountPaisa,
      currency: payment.currency,
      paymentExpiresAt: payment.order.paymentExpiresAt,
    };
    return provider.createPayment(input);
  }

  /** How a refund is executed for the given payment's provider. */
  async getRefundDescriptor(paymentId: string): Promise<RefundDescriptor> {
    const payment = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const provider = this.providers.get(payment.provider);
    if (!provider) throw new BadRequestException(`Unknown payment provider: ${payment.provider}`);
    return provider.refundPayment(paymentId);
  }

  // ------------------------------------------------------------------ admin

  async listPayments(params: { page?: number; pageSize?: number; status?: PaymentStatus }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const where: Prisma.PaymentWhereInput = {};
    if (params.status) where.status = params.status;
    const [total, items] = await this.prisma.$transaction([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { order: { select: { orderNumber: true, customerId: true } } },
      }),
    ]);
    return { total, page, pageSize, items };
  }

  async getPayment(id: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: { order: true, attempts: true, reviewer: { select: { id: true, name: true, email: true } } },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  /** Customer-facing status lookup (used by the AI get_payment_status tool). */
  async getPaymentStatusForOrder(orderNumber: string, customerId?: string) {    const order = await this.prisma.order.findUnique({
      where: { orderNumber: orderNumber.trim().toUpperCase() },
      include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    if (!order) throw new NotFoundException('Order not found');
    // Ownership check: a customer may only see their own orders' payment status.
    if (customerId && order.customerId !== customerId) {
      throw new NotFoundException('Order not found');
    }
    const payment = order.payments[0] ?? null;
    return {
      orderNumber: order.orderNumber,
      orderStatus: order.status,
      paymentStatus: payment?.status ?? null,
      amountPaisa: payment?.amountPaisa ?? order.totalPaisa,
      currency: order.currency,
    };
  }

  /** Latest non-final payment for an order (used when a customer submits proof). */
  async getActivePaymentForOrder(orderId: string) {
    return this.prisma.payment.findFirst({
      where: { orderId, status: { in: ['PENDING', 'MANUAL_REVIEW_REQUIRED'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ------------------------------------------------------- manual review flow

  /**
   * Customer uploads transfer proof. Payment → MANUAL_REVIEW_REQUIRED,
   * order → PAYMENT_PROCESSING. This NEVER marks anything paid.
   */
  async submitProof(
    paymentId: string,
    input: { storageKey: string; proofHash?: string },
    actor: StateTransitionActor,
  ) {
    if (!input.storageKey || !/^proofs\//.test(input.storageKey)) {
      throw new BadRequestException('storageKey must be a private proof-storage key (proofs/...)');
    }
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      if (payment.status === 'PAID') throw new BadRequestException('Payment is already confirmed');
      if (!['PENDING', 'PROCESSING', 'MANUAL_REVIEW_REQUIRED', 'FAILED'].includes(payment.status)) {
        throw new BadRequestException(`Cannot submit proof in status ${payment.status}`);
      }
      const updatedPayment = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: 'MANUAL_REVIEW_REQUIRED',
          proofUrl: input.storageKey,
          proofHash: input.proofHash ?? null,
          failureReason: null,
        },
      });
      const order = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId } });
      if (order.status === 'AWAITING_PAYMENT') {
        await tx.order.update({ where: { id: order.id }, data: { status: 'PAYMENT_PROCESSING' } });
      }
      await this.audit.log(
        {
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'payment.proof_submitted',
          entityType: 'payment',
          entityId: paymentId,
          before: { status: payment.status },
          after: { status: 'MANUAL_REVIEW_REQUIRED' },
          ipAddress: actor.ip ?? null,
        },
        tx,
      );
      return updatedPayment;
    });
  }

  /**
   * Authorized admin decides a manual payment. Reason is MANDATORY and both
   * the request and the decision are written to pending_approvals + audit.
   * Approve → PAID (full confirmation flow). Reject → back to PENDING so the
   * customer can submit new proof.
   */
  async decideManualPayment(
    paymentId: string,
    adminId: string,
    decision: ManualDecision,
    reason: string,
    ip: string | null,
  ) {
    if (!reason || !reason.trim()) {
      throw new BadRequestException('A decision reason is mandatory for manual payment review');
    }
    const txResult = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: { order: { include: { items: true } } },
      });
      if (payment.status !== 'MANUAL_REVIEW_REQUIRED') {
        throw new BadRequestException(`Payment is not awaiting review (status: ${payment.status})`);
      }

      const approval = await tx.pendingApproval.create({
        data: {
          actionType: 'MANUAL_PAYMENT',
          entityType: 'payment',
          entityId: paymentId,
          requestedBy: adminId,
          payload: {
            paymentId,
            orderId: payment.orderId,
            amountPaisa: payment.amountPaisa,
            decision,
            proofUrl: payment.proofUrl,
          },
          status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          decidedBy: adminId,
          decidedAt: new Date(),
          reason: reason.trim(),
        },
      });

      if (decision === 'APPROVE') {
        await this.confirmPaymentTx(tx, payment.id, { providerPaymentId: null }, { type: 'ADMIN', id: adminId, ip });
      } else {
        await tx.payment.update({
          where: { id: paymentId },
          data: {
            status: 'PENDING',
            reviewedBy: adminId,
            reviewedAt: new Date(),
            failureReason: `Proof rejected: ${reason.trim()}`,
          },
        });
        if (payment.order.status === 'PAYMENT_PROCESSING') {
          await tx.order.update({ where: { id: payment.orderId }, data: { status: 'AWAITING_PAYMENT' } });
        }
      }

      await this.audit.log(
        {
          actorType: 'ADMIN',
          actorId: adminId,
          action: decision === 'APPROVE' ? 'payment.manual_approved' : 'payment.manual_rejected',
          entityType: 'payment',
          entityId: paymentId,
          before: { status: 'MANUAL_REVIEW_REQUIRED' },
          after: { decision, reason: reason.trim(), approvalId: approval.id },
          ipAddress: ip,
        },
        tx,
      );
      return { approval, decision, customerId: payment.order.customerId };
    });
    // NOTE: runs after the transaction commits.
    const result = await txResult;
    if (result.decision === 'APPROVE') {
      await this.moveCustomer(result.customerId, 'PAYMENT_CONFIRMED', { type: 'ADMIN', id: adminId, ip });
      await this.moveCustomer(result.customerId, 'FULFILLMENT_PENDING', { type: 'ADMIN', id: adminId, ip });
    } else {
      await this.moveCustomer(result.customerId, 'AWAITING_PAYMENT', { type: 'ADMIN', id: adminId, ip });
    }
    return { approvalId: result.approval.id, decision: result.decision };
  }

  // ------------------------------------------------------- expiry sweeper

  /**
   * Idempotent payment-window sweeper. PENDING payments whose order
   * `paymentExpiresAt` has passed are marked FAILED and their
   * AWAITING_PAYMENT orders CANCELLED, with audit rows. Payments already
   * under manual review are left alone — a human is handling them.
   * Safe to run on a schedule; re-running changes nothing.
   */
  async runPaymentExpirySweeper(now: Date = new Date()): Promise<{ expired: number }> {
    const due = await this.prisma.payment.findMany({
      where: {
        status: 'PENDING',
        order: { status: 'AWAITING_PAYMENT', paymentExpiresAt: { lt: now } },
      },
      select: { id: true, orderId: true, order: { select: { customerId: true } } },
    });
    let expired = 0;
    for (const p of due) {
      const processed = await this.prisma.$transaction(async (tx) => {
        const fresh = await tx.payment.findUnique({ where: { id: p.id }, select: { status: true } });
        if (!fresh || fresh.status !== 'PENDING') return false; // raced with a proof/approval
        await tx.payment.update({
          where: { id: p.id },
          data: { status: 'FAILED', failureReason: 'Payment window expired without proof' },
        });
        const order = await tx.order.findUniqueOrThrow({ where: { id: p.orderId } });
        if (order.status === 'AWAITING_PAYMENT') {
          await tx.order.update({ where: { id: p.orderId }, data: { status: 'CANCELLED' } });
        }
        await this.audit.log(
          {
            actorType: 'SYSTEM',
            action: 'payment.expired',
            entityType: 'payment',
            entityId: p.id,
            before: { status: 'PENDING', orderStatus: order.status },
            after: { status: 'FAILED', orderStatus: 'CANCELLED' },
          },
          tx,
        );
        return true;
      });
      if (!processed) continue;
      expired++;
      // Move the customer out of AWAITING_PAYMENT when the state machine allows it.
      try {
        const customer = await this.prisma.customer.findUniqueOrThrow({
          where: { id: p.order.customerId },
        });
        if (canTransition(customer.state, 'CANCELLED')) {
          await this.customers.transitionState(customer.id, 'CANCELLED', { type: 'SYSTEM' });
        } else {
          await this.audit.log({
            actorType: 'SYSTEM',
            action: 'payment.expiry_customer_state_skipped',
            entityType: 'customer',
            entityId: customer.id,
            after: { actual: customer.state, target: 'CANCELLED' },
          });
        }
      } catch {
        // Customer move is best-effort; the money state is already final.
      }
    }
    return { expired };
  }

  // ------------------------------------------------------- provider webhooks

  /**
   * Entry point for provider webhooks (spec §16, exactly):
   *  1. verify signature → 401 + log
   *  2. dedupe by event id → acknowledge duplicate
   *  3. look up order by provider reference → 404 + log
   *  4. amount == order total (paisa-exact) else manual review, never auto-confirm
   *  5. currency == PKR else manual review
   *  6. dedupe by provider transaction id (payment_attempts.idempotency_key)
   *  7. re-verify status with the provider — the webhook claim is not trusted
   *  8. tx: payment PAID → order PAYMENT_CONFIRMED → FULFILLING → task + subscription
   */
  async handleProviderWebhook(
    providerName: string,
    eventId: string | undefined,
    signature: string | undefined,
    rawBody: Buffer | string,
    payload: unknown,
  ): Promise<WebhookOutcome> {
    const provider = this.providers.get(providerName);
    if (!provider) throw new BadRequestException(`Unknown payment provider: ${providerName}`);

    const dedupeId = eventId || `${providerName}:unkeyed:${Date.now()}`;

    // 1. signature
    if (!provider.verifyWebhookSignature(rawBody, signature)) {
      await this.recordWebhookEvent(providerName, dedupeId, false, payload);
      await this.audit.log({
        actorType: 'SYSTEM', action: 'webhook.failed',
        entityType: 'webhook_event', entityId: await this.webhookRowId(dedupeId),
        after: { source: providerName, eventId: dedupeId, error: 'Invalid signature' },
      });
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // 2. event dedupe (append-only: the original row is never touched)
    const seen = await this.prisma.webhookEvent.findUnique({ where: { eventId: dedupeId } });
    if (seen) {
      await this.audit.log({
        actorType: 'SYSTEM', action: 'webhook.duplicate_skipped',
        entityType: 'webhook_event', entityId: seen.id,
        after: { source: providerName, eventId: dedupeId },
      });
      return { outcome: 'duplicate', detail: 'Event already processed' };
    }
    try {
      await this.recordWebhookEvent(providerName, dedupeId, true, payload);
    } catch (err) {
      // Concurrent duplicate delivery: both workers passed the `seen` check,
      // the loser's insert hits the unique eventId constraint. The loser
      // reports duplicate — exactly-once processing is preserved.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.webhookEvent.findUnique({ where: { eventId: dedupeId } });
        await this.audit.log({
          actorType: 'SYSTEM', action: 'webhook.duplicate_skipped',
          entityType: 'webhook_event', entityId: winner?.id ?? null,
          after: { source: providerName, eventId: dedupeId, race: 'concurrent_delivery' },
        });
        return { outcome: 'duplicate', detail: 'Event already processed (concurrent delivery)' };
      }
      throw err;
    }

    // 3. parse + order lookup
    let event: ProviderPaymentEvent;
    try {
      event = provider.parseWebhook(payload);
    } catch (err) {
      await this.markWebhookFailed(dedupeId, `Malformed payload: ${err instanceof Error ? err.message : err}`);
      throw new BadRequestException('Malformed webhook payload');
    }
    // Providers reference the human order number (ZSH-...); only probe the
    // UUID id column when the reference is actually UUID-shaped — otherwise
    // Postgres/Prisma throws P2023 instead of simply not matching.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.orderReference);
    const order = await this.prisma.order.findFirst({
      where: isUuid ? { id: event.orderReference } : { orderNumber: event.orderReference },
      include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 }, items: true },
    });
    if (!order) {
      await this.markWebhookFailed(dedupeId, `Unknown order reference: ${event.orderReference}`);
      throw new NotFoundException('Order not found for webhook reference');
    }
    const payment = order.payments[0];
    if (!payment) {
      await this.markWebhookFailed(dedupeId, 'Order has no payment row');
      throw new BadRequestException('Order has no payment row');
    }

    // 6. transaction dedupe
    const idempotencyKey = `webhook:${providerName}:${event.providerPaymentId}`;
    const prior = await this.prisma.paymentAttempt.findUnique({ where: { idempotencyKey } });
    if (prior) {
      await this.markWebhookProcessed(dedupeId);
      return { outcome: 'duplicate', paymentId: payment.id, orderId: order.id, detail: 'Transaction already recorded' };
    }

    // 4+5. amount + currency must match exactly, or manual review
    if (event.currency !== order.currency || event.amountPaisa !== order.totalPaisa) {
      const reason =
        event.currency !== order.currency
          ? `Currency mismatch: got ${event.currency}, expected ${order.currency}`
          : `Amount mismatch: got ${event.amountPaisa}, expected ${order.totalPaisa}`;
      await this.routeToManualReview(payment.id, order.id, reason, dedupeId, event);
      return { outcome: 'manual_review', paymentId: payment.id, orderId: order.id, detail: reason };
    }

    // 7. independent verification — never trust the claim alone
    const verified = await provider.getPaymentStatus(event.providerPaymentId);
    if (verified !== 'SUCCEEDED') {
      await this.prisma.$transaction(async (tx) => {
        await tx.paymentAttempt.create({
          data: {
            paymentId: payment.id,
            idempotencyKey,
            requestPayload: event.rawPayload as Prisma.InputJsonValue,
            status: `UNVERIFIED_${verified}`,
          },
        });
        if (payment.status === 'PENDING') {
          await tx.payment.update({ where: { id: payment.id }, data: { status: 'PROCESSING' } });
        }
        await this.markWebhookProcessed(dedupeId, tx);
      });
      return {
        outcome: 'pending_verification',
        paymentId: payment.id,
        orderId: order.id,
        detail: `Provider reports ${verified}; not confirming yet`,
      };
    }

    // 8. the money is real — confirm transactionally, then advance the customer
    await this.prisma.$transaction(async (tx) => {
      await tx.paymentAttempt.create({
        data: {
          paymentId: payment.id,
          idempotencyKey,
          requestPayload: event.rawPayload as Prisma.InputJsonValue,
          status: 'SUCCEEDED',
        },
      });
      await this.confirmPaymentTx(
        tx,
        payment.id,
        { providerPaymentId: event.providerPaymentId },
        { type: 'SYSTEM' },
      );
      await this.markWebhookProcessed(dedupeId, tx);
    });
    await this.moveCustomer(order.customerId, 'PAYMENT_CONFIRMED', { type: 'SYSTEM' });
    await this.moveCustomer(order.customerId, 'FULFILLMENT_PENDING', { type: 'SYSTEM' });
    return { outcome: 'confirmed', paymentId: payment.id, orderId: order.id };
  }

  // --------------------------------------------------------------- internals

  /**
   * The single confirmation path used by verified webhooks AND approved
   * manual reviews. Payment → PAID, order → PAYMENT_CONFIRMED → FULFILLING,
   * fulfillment task created, subscription created. All in one transaction.
   */
  async confirmPaymentTx(
    tx: Prisma.TransactionClient,
    paymentId: string,
    opts: { providerPaymentId: string | null },
    actor: StateTransitionActor,
  ) {
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { order: { include: { items: { include: { plan: true, product: true } }, customer: true } } },
    });
    if (payment.status === 'PAID') return payment; // idempotent
    if (!['PENDING', 'PROCESSING', 'MANUAL_REVIEW_REQUIRED'].includes(payment.status)) {
      throw new BadRequestException(`Cannot confirm payment from status ${payment.status}`);
    }

    const paid = await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: 'PAID',
        providerPaymentId: opts.providerPaymentId,
        reviewedBy: actor.type === 'ADMIN' ? actor.id ?? undefined : undefined,
        reviewedAt: new Date(),
        failureReason: null,
      },
    });

    await tx.order.update({ where: { id: payment.orderId }, data: { status: 'PAYMENT_CONFIRMED' } });

    const item = payment.order.items[0];
    if (!item) throw new BadRequestException('Order has no items; cannot create fulfillment');

    // Phase 8: snapshot everything the admin needs to deliver — product and
    // plan names, price, and the owner's per-product fulfillment instructions
    // (G-1). The queue never has to guess what the customer must receive.
    const task = await tx.fulfillmentTask.create({
      data: {
        orderId: payment.orderId,
        taskType: 'deliver_service',
        provider: 'manual',
        status: 'PENDING',
        payload: {
          planId: item.planId,
          planName: item.plan?.name ?? null,
          productId: item.productId,
          productName: item.product?.name ?? null,
          customerId: payment.order.customerId,
          customerName: payment.order.customer?.name ?? null,
          durationDays: item.plan.durationDays,
          pricePaisa: item.plan.pricePaisa,
          currency: item.plan.currency,
          fulfillmentNotes: item.product?.fulfillmentNotes ?? null,
        },
      },
    });

    const now = new Date();
    // Renewal: at most one ACTIVE/EXPIRING_SOON subscription per customer+product.
    // If one exists, it is superseded (CANCELLED + audit) and the new
    // subscription is anchored at the later of now and the old expiry, so the
    // customer never loses paid time. Idempotent via the PAID early-return and
    // the unique orderId above.
    const existing = await tx.subscription.findFirst({
      where: {
        customerId: payment.order.customerId,
        productId: item.productId,
        status: { in: ['ACTIVE', 'EXPIRING_SOON'] },
      },
      orderBy: { expiresAt: 'desc' },
    });
    let startsAt = now;
    if (existing) {
      startsAt = existing.expiresAt > now ? existing.expiresAt : now;
      await tx.subscription.update({
        where: { id: existing.id },
        data: { status: 'CANCELLED' },
      });
      await this.audit.log(
        {
          actorType: actor.type, actorId: actor.id ?? null,
          action: 'subscription.superseded_by_renewal',
          entityType: 'subscription', entityId: existing.id,
          before: { status: existing.status, expiresAt: existing.expiresAt },
          after: { status: 'CANCELLED', renewedByOrderId: payment.orderId },
          ipAddress: actor.ip ?? null,
        },
        tx,
      );
    }
    const subscription = await tx.subscription.create({
      data: {
        customerId: payment.order.customerId,
        orderId: payment.orderId,
        productId: item.productId,
        planId: item.planId,
        startsAt,
        expiresAt: new Date(startsAt.getTime() + item.plan.durationDays * 86_400_000),
        status: 'ACTIVE',
      },
    });

    await tx.order.update({ where: { id: payment.orderId }, data: { status: 'FULFILLING' } });

    await this.audit.log(
      {
        actorType: actor.type,
        actorId: actor.id ?? null,
        action: 'payment.confirmed',
        entityType: 'payment',
        entityId: paymentId,
        before: { status: payment.status },
        after: {
          status: 'PAID',
          orderStatus: 'FULFILLING',
          fulfillmentTaskId: task.id,
          subscriptionId: subscription.id,
        },
        ipAddress: actor.ip ?? null,
      },
      tx,
    );
    return { paid, customerId: payment.order.customerId };
  }

  /** Best-effort customer move; walks legal intermediate states, skips (with audit note) otherwise. */
  private async moveCustomer(
    customerId: string,
    to: 'PAYMENT_CONFIRMED' | 'FULFILLMENT_PENDING' | 'AWAITING_PAYMENT',
    actor: StateTransitionActor,
  ): Promise<void> {
    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    if (customer.state === to) return;
    // Legal walk-through paths for each target. A provider confirmation can
    // arrive while the customer-facing state is still AWAITING_PAYMENT (e.g.
    // proof not yet submitted); walk AWAITING_PAYMENT → PAYMENT_PROCESSING →
    // PAYMENT_CONFIRMED rather than skipping the move.
    let steps: CustomerState[] | null = null;
    if (to === 'PAYMENT_CONFIRMED') {
      if (customer.state === 'PAYMENT_PROCESSING') steps = ['PAYMENT_CONFIRMED'];
      else if (customer.state === 'AWAITING_PAYMENT') steps = ['PAYMENT_PROCESSING', 'PAYMENT_CONFIRMED'];
    } else if (to === 'FULFILLMENT_PENDING') {
      if (customer.state === 'PAYMENT_CONFIRMED') steps = ['FULFILLMENT_PENDING'];
    } else if (to === 'AWAITING_PAYMENT') {
      if (customer.state === 'PAYMENT_PROCESSING') steps = ['AWAITING_PAYMENT'];
    }
    if (!steps) {
      await this.audit.log({
        actorType: actor.type,
        actorId: actor.id ?? null,
        action: 'payment.customer_state_skipped',
        entityType: 'customer',
        entityId: customerId,
        after: { actual: customer.state, target: to },
      });
      return;
    }
    for (const state of steps) {
      const current = await this.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
      if (current.state === state) continue;
      await this.customers.transitionState(customerId, state, actor);
    }
  }

  private async routeToManualReview(
    paymentId: string,
    orderId: string,
    reason: string,
    webhookEventId: string,
    event: ProviderPaymentEvent,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: 'MANUAL_REVIEW_REQUIRED',
          providerPaymentId: event.providerPaymentId,
          failureReason: reason,
        },
      });
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      if (['AWAITING_PAYMENT', 'PAYMENT_PROCESSING'].includes(order.status)) {
        await tx.order.update({ where: { id: orderId }, data: { status: 'PAYMENT_PROCESSING' } });
      }
      await this.audit.log(
        {
          actorType: 'SYSTEM',
          action: 'payment.webhook_routed_to_manual_review',
          entityType: 'payment',
          entityId: paymentId,
          after: { reason },
        },
        tx,
      );
      await this.markWebhookProcessed(webhookEventId, tx);
    });
  }

  // webhook_events is append-only (Phase 2 RULEs silently ignore UPDATE/DELETE),
  // so every outcome is a new immutable record: the event row stays RECEIVED
  // and processing outcomes land in the append-only audit log.
  private async recordWebhookEvent(
    source: string,
    eventId: string,
    signatureValid: boolean,
    payload: unknown,
  ): Promise<void> {
    await this.prisma.webhookEvent.create({
      data: {
        source,
        eventId,
        signatureValid,
        payload: (payload ?? {}) as Prisma.InputJsonValue,
        processingStatus: 'RECEIVED',
      },
    });
  }

  private async markWebhookFailed(eventId: string, error: string): Promise<void> {
    await this.audit.log({
      actorType: 'SYSTEM', action: 'webhook.failed',
      entityType: 'webhook_event', entityId: await this.webhookRowId(eventId),
      after: { eventId, error: error.slice(0, 500) },
    });
  }

  private async markWebhookProcessed(eventId: string, tx?: Prisma.TransactionClient): Promise<void> {
    await this.audit.log(
      {
        actorType: 'SYSTEM', action: 'webhook.processed',
        entityType: 'webhook_event', entityId: await this.webhookRowId(eventId),
        after: { eventId },
      },
      tx,
    );
  }

  /**
   * AuditLog.entityId is a UUID column; webhook event ids are opaque provider
   * strings. The audit trail references the immutable webhook_events row id
   * and keeps the provider event id in `after` for traceability.
   */
  private async webhookRowId(eventId: string): Promise<string | null> {
    const row = await this.prisma.webhookEvent.findUnique({ where: { eventId }, select: { id: true } });
    return row?.id ?? null;
  }
}
