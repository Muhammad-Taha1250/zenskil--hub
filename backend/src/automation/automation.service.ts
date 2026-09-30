import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { AdminAlertService } from './admin-alert.service';
import { PaymentsService } from '../payments/payments.service';
import { FulfillmentService } from '../fulfillment/fulfillment.service';

// Automation brain behind the n8n scheduled workflows (Phase 5).
//
// Architecture: n8n stays THIN — its workflows only fire on schedule and call
// the /api/v1/automation/* HTTP endpoints below. Every decision (candidate
// selection, reminder stage, opt-in/window policy, template choice) lives here
// in the backend and is covered by tests. The WhatsApp service remains the
// final policy enforcer (24h window, opt-in) for every actual send.
//
// Idempotency: every send advances a stage counter via a conditional
// updateMany (claim). Concurrent workflow runs — or a double-fired schedule —
// can claim a given (entity, stage) exactly once; losers get 'race_lost'.

function languageCode(lang: string): string {
  // Meta template language codes; Roman Urdu has no Meta code → 'en'.
  if (lang === 'URDU') return 'ur';
  return 'en';
}

@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly whatsapp: WhatsappService,
    private readonly notifications: NotificationsService,
    private readonly subs: SubscriptionsService,
    private readonly alerts: AdminAlertService,
    private readonly payments: PaymentsService,
    private readonly fulfillment: FulfillmentService,
  ) {}

  // ---------------------------------------------------------- notifications

  /** Queued notifications due for dispatch (n8n: notification-dispatcher). */
  pendingNotifications(limit = 50) {
    return this.prisma.notification.findMany({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
      take: Math.min(200, Math.max(1, limit)),
      select: { id: true, customerId: true, templateName: true, createdAt: true },
    });
  }

  /** Dispatches one queued notification; the WhatsApp service enforces opt-in. */
  dispatchNotification(id: string) {
    return this.notifications.sendQueued(id);
  }

  // ---------------------------------------------------------------- abandoned

  /**
   * Orders eligible for an abandonment nudge right now.
   * Stage 0 → first reminder due after offsets_hours[0] (default 2h).
   * Stage 1 → final reminder due after offsets_hours[1] (default 24h) AND at
   * least (offsets[1]-offsets[0]) after reminder 1 was sent — a catch-up run
   * can never fire both reminders back-to-back.
   * Opted-out customers are excluded permanently (STOP silences nudges).
   */
  async findAbandonmentCandidates(now: Date = new Date(), limit = 100) {
    const cfg = await this.settings.getSetting('reminders.abandoned', {
      enabled: true, offsets_hours: [2, 24], max_attempts: 2,
    });
    if (!cfg.enabled) return [];
    const [firstH, secondH] = cfg.offsets_hours as number[];
    const gapMs = Math.max(3_600_000, (secondH - firstH) * 3_600_000);
    const due = (stage: number, hours: number) => ({
      abandonmentReminderStage: stage,
      createdAt: { lte: new Date(now.getTime() - hours * 3_600_000) },
    });
    return this.prisma.order.findMany({
      where: {
        status: 'AWAITING_PAYMENT',
        payments: { none: { status: { in: ['PAID', 'PROCESSING', 'MANUAL_REVIEW_REQUIRED'] } } },
        customer: { optedIn: true },
        OR: [
          due(0, firstH),
          {
            ...due(1, secondH),
            abandonmentReminderStageAt: { lte: new Date(now.getTime() - gapMs) },
          },
        ],
      },
      take: Math.min(500, Math.max(1, limit)),
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, orderNumber: true, customerId: true, createdAt: true,
        abandonmentReminderStage: true, abandonmentReminderStageAt: true, totalPaisa: true,
        customer: { select: { name: true, language: true } },
      },
    });
  }

  /**
   * Sends the next abandonment reminder for an order (template only —
   * marketing nudges are never free-form). Atomically claims the stage.
   */
  async sendAbandonmentReminder(orderId: string): Promise<
    { stage: number; messageId?: string | null; skipped?: string }
  > {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { customer: { select: { id: true, name: true, language: true, optedIn: true } } },
    });
    if (order.status !== 'AWAITING_PAYMENT') {
      return { stage: order.abandonmentReminderStage, skipped: 'not_awaiting_payment' };
    }
    if (!order.customer.optedIn) {
      return { stage: order.abandonmentReminderStage, skipped: 'opted_out' };
    }
    const nextStage = order.abandonmentReminderStage + 1;
    if (nextStage > 2) {
      return { stage: order.abandonmentReminderStage, skipped: 'max_stage_reached' };
    }
    // Atomic claim: only the caller that still sees the old stage advances it.
    const claimed = await this.prisma.order.updateMany({
      where: { id: orderId, abandonmentReminderStage: order.abandonmentReminderStage, status: 'AWAITING_PAYMENT' },
      data: { abandonmentReminderStage: nextStage, abandonmentReminderStageAt: new Date() },
    });
    if (claimed.count === 0) {
      const fresh = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      return { stage: fresh.abandonmentReminderStage, skipped: 'race_lost' };
    }
    const templateKey = nextStage === 1 ? 'templates.abandoned_reminder_1' : 'templates.abandoned_reminder_2';
    const templateName = await this.settings.getSetting<string>(
      templateKey, `zenskill_abandoned_reminder_${nextStage}`,
    );
    const totalPkr = (order.totalPaisa / 100).toLocaleString('en-PK');
    const messageId = await this.whatsapp.sendTemplateNotification(order.customerId, {
      templateName,
      languageCode: languageCode(order.customer.language),
      // Template body already contains the "PKR" prefix — pass the raw amount.
      variables: [order.customer.name ?? 'there', order.orderNumber, totalPkr],
    });
    await this.audit.log({
      actorType: 'SYSTEM', actorId: null,
      action: 'automation.abandonment_reminder_sent',
      entityType: 'order', entityId: orderId,
      after: { stage: nextStage, templateName, messageId: messageId ?? 'blocked' },
      ipAddress: null,
    });
    return { stage: nextStage, messageId };
  }

  // ------------------------------------------------------------------ renewal

  /**
   * Subscriptions due for their next renewal reminder.
   * offsets_days (default [7,3,1]): stage 0 → due within 7d, stage 1 → within
   * 3d, stage 2 → within 1d. Later stages additionally wait (offsets[s-1] -
   * offsets[s]) after the previous reminder was sent, so catch-up runs never
   * burst reminders back-to-back. Opted-out customers are excluded permanently.
   */
  async findRenewalCandidates(now: Date = new Date(), limit = 200) {
    const cfg = await this.settings.getSetting('reminders.renewal', {
      enabled: true, offsets_days: [7, 3, 1],
    });
    if (!cfg.enabled) return [];
    const offsets = cfg.offsets_days as number[];
    const out: Array<{ subscriptionId: string; dueStage: number; expiresAt: Date }> = [];
    for (let stage = 0; stage < offsets.length && out.length < limit; stage++) {
      const where: Record<string, unknown> = {
        status: { in: ['ACTIVE', 'EXPIRING_SOON'] },
        renewalReminderStage: stage,
        expiresAt: {
          gt: now,
          lte: new Date(now.getTime() + offsets[stage] * 86_400_000),
        },
        customer: { optedIn: true },
      };
      if (stage > 0) {
        const gapMs = Math.max(86_400_000, (offsets[stage - 1] - offsets[stage]) * 86_400_000);
        (where as Record<string, unknown>).renewalReminderStageAt = { lte: new Date(now.getTime() - gapMs) };
      }
      const rows = await this.prisma.subscription.findMany({
        where: where as never,
        take: limit - out.length,
        orderBy: { expiresAt: 'asc' },
        select: { id: true, expiresAt: true },
      });
      for (const r of rows) out.push({ subscriptionId: r.id, dueStage: stage + 1, expiresAt: r.expiresAt });
    }
    return out;
  }

  /**
   * Sends the next renewal reminder (approved template only) and atomically
   * advances the reminder stage.
   */
  async sendRenewalReminder(subscriptionId: string): Promise<
    { stage: number; messageId?: string | null; skipped?: string }
  > {
    const sub = await this.prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      include: {
        customer: { select: { id: true, name: true, language: true, optedIn: true } },
        plan: { select: { name: true, pricePaisa: true } },
      },
    });
    if (!['ACTIVE', 'EXPIRING_SOON'].includes(sub.status)) {
      return { stage: sub.renewalReminderStage, skipped: 'not_active' };
    }
    if (!sub.customer.optedIn) {
      return { stage: sub.renewalReminderStage, skipped: 'opted_out' };
    }
    const nextStage = sub.renewalReminderStage + 1;
    if (nextStage > 3) {
      return { stage: sub.renewalReminderStage, skipped: 'max_stage_reached' };
    }
    const claimed = await this.prisma.subscription.updateMany({
      where: { id: subscriptionId, renewalReminderStage: sub.renewalReminderStage },
      data: { renewalReminderStage: nextStage, renewalReminderStageAt: new Date() },
    });
    if (claimed.count === 0) {
      const fresh = await this.prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
      return { stage: fresh.renewalReminderStage, skipped: 'race_lost' };
    }
    const templateName = await this.settings.getSetting<string>(
      'templates.renewal_reminder', 'zenskill_renewal_reminder',
    );
    const expiry = sub.expiresAt.toISOString().slice(0, 10);
    const pricePkr = (sub.plan.pricePaisa / 100).toLocaleString('en-PK');
    const messageId = await this.whatsapp.sendTemplateNotification(sub.customerId, {
      templateName,
      languageCode: languageCode(sub.customer.language),
      // Template body already contains the "PKR" prefix — pass the raw amount.
      variables: [sub.customer.name ?? 'there', sub.plan.name, expiry, pricePkr],
    });
    await this.audit.log({
      actorType: 'SYSTEM', actorId: null,
      action: 'automation.renewal_reminder_sent',
      entityType: 'subscription', entityId: subscriptionId,
      after: { stage: nextStage, templateName, messageId: messageId ?? 'blocked' },
      ipAddress: null,
    });
    return { stage: nextStage, messageId };
  }

  // ------------------------------------------------------------------ tickets

  /**
   * Open tickets that need an admin alert: HIGH/URGENT priority, or any
   * unassigned open ticket, that has not been alerted yet.
   */
  findUnalertedTickets(limit = 50) {
    return this.prisma.supportTicket.findMany({
      where: {
        alertedAt: null,
        status: 'OPEN',
        OR: [{ priority: { in: ['HIGH', 'URGENT'] } }, { assignedTo: null }],
      },
      take: Math.min(200, Math.max(1, limit)),
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true, ticketNumber: true, subject: true, priority: true, createdAt: true,
        customer: { select: { name: true, whatsappNumber: true } },
        order: { select: { orderNumber: true } },
      },
    });
  }

  /**
   * Atomically claims a ticket alert so exactly one alerter (workflow run)
   * sends it. Returns claimed=false when another run got there first.
   */
  async claimTicketAlert(ticketId: string): Promise<{ claimed: boolean; enqueued: boolean }> {
    // Phase 6: the alert claim, the outbox enqueue, and the audits are ONE
    // database transaction. A crash between "marked alerted" and "enqueued"
    // is impossible — either the ticket is claimed AND queued, or neither.
    // The UNIQUE(ticket_id) on the outbox keeps a retried claim idempotent.
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.supportTicket.updateMany({
        where: { id: ticketId, alertedAt: null, status: 'OPEN' },
        data: { alertedAt: new Date() },
      });
      if (claimed.count !== 1) return { claimed: false, enqueued: false };
      const ticket = await tx.supportTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: { customer: { select: { name: true, whatsappNumber: true } } },
      });
      const { enqueued } = await this.alerts.enqueue(ticketId, {
        ticketId,
        ticketNumber: ticket.ticketNumber,
        priority: ticket.priority,
        subject: ticket.subject,
        customerName: ticket.customer.name,
        customerWhatsapp: ticket.customer.whatsappNumber,
        createdAt: ticket.createdAt.toISOString(),
      }, tx);
      await this.audit.log({
        actorType: 'SYSTEM', actorId: null,
        action: 'automation.ticket_alert_claimed',
        entityType: 'support_ticket', entityId: ticketId,
        after: { enqueued },
        ipAddress: null,
      }, tx);
      return { claimed: true, enqueued };
    });
  }

  // ------------------------------------------------------------------ sweeper

  /** Delegates to the subscription expiry sweeper (idempotent; safe to run often). */
  runExpirySweeper() {
    return this.subs.runExpirySweeper();
  }

  /** Delegates to the payment-window expiry sweeper (Phase 7). */
  runPaymentExpirySweeper() {
    return this.payments.runPaymentExpirySweeper();
  }

  /** Delegates to the fulfillment worker (Phase 8). Idempotent; safe to run often. */
  processFulfillmentTasks(limit = 25) {
    return this.fulfillment.processPendingTasks(limit);
  }
}
