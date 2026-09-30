import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { StateTransitionActor } from '../customers/customers.service';

// Refund flow (spec §42/§51):
//   1. requestRefund() — OWNER/FINANCE creates a PENDING Refund + a PENDING
//      REFUND PendingApproval (reason mandatory). The order moves to
//      REFUND_REQUESTED; the previous order status is stored for restoration
//      if the refund is rejected.
//   2. ApprovalsService.decide() — a *different* OWNER/FINANCE admin approves
//      or rejects (OWNER may self-decide when they are the only admin).
//   3. applyApproval() — APPROVED: payment → REFUNDED / PARTIALLY_REFUNDED,
//      order → REFUNDED (full) or restored (partial). REJECTED: refund row
//      marked REJECTED, order restored.
// Day one the money moves by manual bank transfer; the admin records the
// provider reference via markExecuted().
@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async requestRefund(
    paymentId: string,
    adminId: string,
    amountPaisa: number,
    reason: string,
    ip: string | null,
  ) {
    if (!reason?.trim()) throw new BadRequestException('A refund reason is mandatory');
    if (!Number.isInteger(amountPaisa) || amountPaisa <= 0) {
      throw new BadRequestException('amountPaisa must be a positive integer');
    }
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: { order: true, refunds: { where: { status: 'PENDING' } } },
      });
      if (payment.status !== 'PAID') {
        throw new BadRequestException(`Only PAID payments can be refunded (status: ${payment.status})`);
      }
      if (payment.refunds.length > 0) {
        throw new BadRequestException('A refund request is already pending for this payment');
      }
      const alreadyRefunded = await tx.refund.aggregate({
        where: { paymentId, status: 'APPROVED' },
        _sum: { amountPaisa: true },
      });
      const refundedSoFar = alreadyRefunded._sum.amountPaisa ?? 0;
      if (amountPaisa > payment.amountPaisa - refundedSoFar) {
        throw new BadRequestException('Refund amount exceeds the refundable balance');
      }

      const refund = await tx.refund.create({
        data: {
          paymentId,
          amountPaisa,
          reason: reason.trim(),
          status: 'PENDING',
          requestedBy: adminId,
        },
      });

      const previousOrderStatus = payment.order.status;
      if (['PAYMENT_CONFIRMED', 'FULFILLING', 'FULFILLED', 'ACTIVE'].includes(previousOrderStatus)) {
        await tx.order.update({ where: { id: payment.orderId }, data: { status: 'REFUND_REQUESTED' } });
      }

      const approval = await tx.pendingApproval.create({
        data: {
          actionType: 'REFUND',
          entityType: 'refund',
          entityId: refund.id,
          requestedBy: adminId,
          payload: {
            refundId: refund.id,
            paymentId,
            orderId: payment.orderId,
            amountPaisa,
            previousOrderStatus,
          },
          reason: reason.trim(),
        },
      });

      await this.audit.log(
        {
          actorType: 'ADMIN', actorId: adminId,
          action: 'refund.requested', entityType: 'refund', entityId: refund.id,
          after: { amountPaisa, approvalId: approval.id, reason: reason.trim() },
          ipAddress: ip,
        },
        tx,
      );
      return { refund, approvalId: approval.id };
    });
  }

  /** Called by ApprovalsService when a REFUND approval is APPROVED. */
  async applyApproval(approvalId: string, deciderId: string, ip: string | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const approval = await tx.pendingApproval.findUniqueOrThrow({ where: { id: approvalId } });
      const payload = approval.payload as { refundId: string; paymentId: string; orderId: string; amountPaisa: number; previousOrderStatus: string };
      const refund = await tx.refund.findUniqueOrThrow({ where: { id: payload.refundId } });
      // Idempotent: a retry after a partial failure converges instead of throwing.
      if (refund.status === 'APPROVED') return;
      if (refund.status !== 'PENDING') throw new BadRequestException('Refund is not pending');

      const payment = await tx.payment.findUniqueOrThrow({ where: { id: payload.paymentId } });
      const isFull = payload.amountPaisa >= payment.amountPaisa;

      await tx.refund.update({
        where: { id: refund.id },
        data: { status: 'APPROVED', approvedBy: deciderId },
      });
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: isFull ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
      });
      await tx.order.update({
        where: { id: payload.orderId },
        data: { status: isFull ? 'REFUNDED' : (payload.previousOrderStatus as never) },
      });

      await this.audit.log(
        {
          actorType: 'ADMIN', actorId: deciderId,
          action: 'refund.approved', entityType: 'refund', entityId: refund.id,
          after: { amountPaisa: payload.amountPaisa, full: isFull, approvalId },
          ipAddress: ip,
        },
        tx,
      );
    });
  }

  /** Called by ApprovalsService when a REFUND approval is REJECTED. */
  async applyRejection(approvalId: string, deciderId: string, note: string | undefined, ip: string | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const approval = await tx.pendingApproval.findUniqueOrThrow({ where: { id: approvalId } });
      const payload = approval.payload as { refundId: string; orderId: string; previousOrderStatus: string };
      const refund = await tx.refund.findUniqueOrThrow({ where: { id: payload.refundId } });
      // Idempotent: a retry after a partial failure converges instead of throwing.
      if (refund.status === 'REJECTED') return;
      if (refund.status !== 'PENDING') throw new BadRequestException('Refund is not pending');

      await tx.refund.update({ where: { id: refund.id }, data: { status: 'REJECTED', approvedBy: deciderId } });
      const order = await tx.order.findUniqueOrThrow({ where: { id: payload.orderId } });
      if (order.status === 'REFUND_REQUESTED') {
        await tx.order.update({
          where: { id: payload.orderId },
          data: { status: payload.previousOrderStatus as never },
        });
      }
      await this.audit.log(
        {
          actorType: 'ADMIN', actorId: deciderId,
          action: 'refund.rejected', entityType: 'refund', entityId: refund.id,
          after: { approvalId, note: note ?? null },
          ipAddress: ip,
        },
        tx,
      );
    });
  }

  /** Records the provider/bank reference after the money actually moved. */
  async markExecuted(refundId: string, providerRefundId: string, actor: StateTransitionActor) {
    const refund = await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    if (refund.status !== 'APPROVED') throw new BadRequestException('Only approved refunds can be marked executed');
    const updated = await this.prisma.refund.update({
      where: { id: refundId },
      data: { providerRefundId },
    });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'refund.executed', entityType: 'refund', entityId: refundId,
      after: { providerRefundId },
      ipAddress: actor.ip ?? null,
    });
    return updated;
  }

  async listRefunds(params: { page?: number; pageSize?: number }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const [total, items] = await this.prisma.$transaction([
      this.prisma.refund.count(),
      this.prisma.refund.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          payment: { select: { orderId: true, amountPaisa: true } },
          requester: { select: { name: true, email: true } },
        },
      }),
    ]);
    return { total, page, pageSize, items };
  }
}
