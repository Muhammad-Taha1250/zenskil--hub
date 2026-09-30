import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CatalogService } from '../catalog/catalog.service';
import { CouponsService } from '../coupons/coupons.service';
import type { StateTransitionActor } from '../customers/customers.service';
import { BusinessConfig } from '../config/configuration';
import { generateOrderNumber } from '../../../database/src/orderNumber';

// Order lifecycle (OrderStatus):
//   DRAFT → AWAITING_PAYMENT → PAYMENT_PROCESSING → PAYMENT_CONFIRMED
//     → FULFILLING → FULFILLED → ACTIVE
//   DRAFT / AWAITING_PAYMENT → CANCELLED
//   PAYMENT_CONFIRMED → REFUND_REQUESTED → REFUNDED  (refunds module)
// Prices are snapshotted from the catalog at creation; later price changes
// never rewrite an existing order. Totals are integer paisa.
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
    private readonly coupons: CouponsService,
    private readonly config: ConfigService,
  ) {}

  private business(): BusinessConfig {
    return this.config.get<BusinessConfig>('business')!;
  }

  /** Create a DRAFT order. The customer must still explicitly confirm it. */
  async createDraftOrder(
    customerId: string,
    input: { planId: string; couponCode?: string },
    actor: StateTransitionActor,
  ) {
    const plan = await this.catalog.getSellablePlan(input.planId);
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const subtotalPaisa = plan.pricePaisa; // quantity is always 1 in v1
      let discountPaisa = 0;
      let couponId: string | null = null;

      if (input.couponCode) {
        const { coupon, discountPaisa: d } = await this.coupons.consumeCoupon(
          input.couponCode,
          subtotalPaisa,
          tx,
          now,
        );
        discountPaisa = d;
        couponId = coupon.id;
      }

      const totalPaisa = subtotalPaisa - discountPaisa;
      if (totalPaisa < 0) throw new BadRequestException('Order total went negative');

      const orderNumber = await generateOrderNumber(tx, now);

      const order = await tx.order.create({
        data: {
          orderNumber,
          customerId,
          status: 'DRAFT',
          currency: plan.currency,
          subtotalPaisa,
          discountPaisa,
          totalPaisa,
          couponId,
          sourceChannel: 'whatsapp',
          items: {
            create: {
              productId: plan.productId,
              planId: plan.id,
              quantity: 1,
              unitPricePaisa: plan.pricePaisa,
              totalPaisa: subtotalPaisa,
            },
          },
        },
        include: { items: { include: { plan: true, product: true } } },
      });

      await this.audit.log(
        {
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'order.draft_created',
          entityType: 'order',
          entityId: order.id,
          after: {
            orderNumber,
            planId: plan.id,
            subtotalPaisa,
            discountPaisa,
            totalPaisa,
            couponId,
          },
          ipAddress: actor.ip ?? null,
        },
        tx,
      );
      return order;
    });
  }

  /**
   * Explicit customer confirmation: DRAFT → AWAITING_PAYMENT.
   * Creates the PENDING manual-transfer payment row and the payment deadline.
   * This is the point of no return for the customer's commitment.
   */
  async confirmOrder(orderId: string, actor: StateTransitionActor) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      if (order.status !== 'DRAFT') {
        throw new BadRequestException(`Only DRAFT orders can be confirmed (status: ${order.status})`);
      }
      const paymentExpiresAt = new Date(
        Date.now() + this.business().paymentWindowHours * 3_600_000,
      );
      const updated = await tx.order.update({
        where: { id: orderId },
        data: { status: 'AWAITING_PAYMENT', paymentExpiresAt },
        include: { items: { include: { plan: true, product: true } } },
      });
      const payment = await tx.payment.create({
        data: {
          orderId,
          provider: 'manual_transfer',
          amountPaisa: order.totalPaisa,
          currency: order.currency,
          status: 'PENDING',
        },
      });
      await this.audit.log(
        {
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'order.confirmed',
          entityType: 'order',
          entityId: orderId,
          before: { status: 'DRAFT' },
          after: { status: 'AWAITING_PAYMENT', paymentId: payment.id, totalPaisa: order.totalPaisa },
          ipAddress: actor.ip ?? null,
        },
        tx,
      );
      return { order: updated, payment };
    });
  }

  async cancelOrder(orderId: string, actor: StateTransitionActor, reason: string) {
    if (!reason || !reason.trim()) throw new BadRequestException('A cancellation reason is required');
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { payments: true },
      });
      if (!['DRAFT', 'AWAITING_PAYMENT'].includes(order.status)) {
        throw new BadRequestException(`Order cannot be cancelled from status ${order.status}`);
      }
      const updated = await tx.order.update({
        where: { id: orderId },
        data: { status: 'CANCELLED' },
      });
      for (const payment of order.payments) {
        if (['PENDING', 'PROCESSING', 'MANUAL_REVIEW_REQUIRED'].includes(payment.status)) {
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: 'EXPIRED', failureReason: `Order cancelled: ${reason}` },
          });
        }
      }
      await this.audit.log(
        {
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'order.cancelled',
          entityType: 'order',
          entityId: orderId,
          before: { status: order.status },
          after: { status: 'CANCELLED', reason },
          ipAddress: actor.ip ?? null,
        },
        tx,
      );
      return updated;
    });
  }

  async getOrder(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        items: { include: { plan: true, product: true } },
        payments: { orderBy: { createdAt: 'desc' } },
        fulfillmentTasks: { orderBy: { createdAt: 'desc' } },
        subscription: true,
        customer: { select: { id: true, whatsappNumber: true, name: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async getOrderByNumber(orderNumber: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderNumber: orderNumber.trim().toUpperCase() },
      include: {
        items: { include: { plan: true, product: true } },
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
        subscription: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async listOrders(params: { page?: number; pageSize?: number; status?: OrderStatus; customerId?: string }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const where: Prisma.OrderWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.customerId) where.customerId = params.customerId;
    const [total, items] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { items: { include: { plan: true } }, customer: { select: { whatsappNumber: true, name: true } } },
      }),
    ]);
    return { total, page, pageSize, items };
  }

  /** Orders past their payment deadline with no completed payment — for the abandonment sweeper. */
  async findExpiredUnpaid(before: Date, limit = 100) {
    return this.prisma.order.findMany({
      where: {
        status: 'AWAITING_PAYMENT',
        paymentExpiresAt: { lt: before },
        payments: { none: { status: { in: ['PAID', 'PROCESSING', 'MANUAL_REVIEW_REQUIRED'] } } },
      },
      take: limit,
      select: { id: true, orderNumber: true, customerId: true, paymentExpiresAt: true },
    });
  }
}
