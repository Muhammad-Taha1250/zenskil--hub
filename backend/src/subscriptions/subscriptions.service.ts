import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { StateTransitionActor } from '../customers/customers.service';
import { BusinessConfig } from '../config/configuration';

// Subscription lifecycle:
//   created ACTIVE at payment confirmation (expiry anchored to payment)
//   → EXPIRING_SOON (expiringSoonDays before expiry)
//   → EXPIRED (past expiry + grace days)
//   → CANCELLED (admin)
// The sweeper is idempotent: re-running changes nothing when states already
// match. Renewal reminders are emitted by the scheduler (Phase 4) based on
// getRenewalCandidates(); the backend only computes the candidate set.
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private business(): BusinessConfig {
    return this.config.get<BusinessConfig>('business')!;
  }

  async getSubscription(id: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { id },
      include: {
        plan: true,
        order: { select: { orderNumber: true } },
        customer: { select: { whatsappNumber: true, name: true, optedIn: true } },
      },
    });
    if (!sub) throw new BadRequestException('Subscription not found');
    return sub;
  }

  async listSubscriptions(params: { page?: number; pageSize?: number; status?: SubscriptionStatus; customerId?: string }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const where: Prisma.SubscriptionWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.customerId) where.customerId = params.customerId;
    const [total, items] = await this.prisma.$transaction([
      this.prisma.subscription.count({ where }),
      this.prisma.subscription.findMany({
        where,
        orderBy: { expiresAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { plan: { select: { name: true } }, customer: { select: { whatsappNumber: true, name: true } } },
      }),
    ]);
    return { total, page, pageSize, items };
  }

  async getActiveForCustomer(customerId: string) {
    return this.prisma.subscription.findMany({
      where: { customerId, status: { in: ['ACTIVE', 'EXPIRING_SOON'] } },
      include: { plan: true },
      orderBy: { expiresAt: 'asc' },
    });
  }

  async cancelSubscription(id: string, actor: StateTransitionActor, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('A cancellation reason is required');
    const sub = await this.prisma.subscription.findUniqueOrThrow({ where: { id } });
    if (!['ACTIVE', 'EXPIRING_SOON'].includes(sub.status)) {
      throw new BadRequestException(`Cannot cancel subscription in status ${sub.status}`);
    }
    const updated = await this.prisma.subscription.update({ where: { id }, data: { status: 'CANCELLED' } });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'subscription.cancelled', entityType: 'subscription', entityId: id,
      before: { status: sub.status }, after: { status: 'CANCELLED', reason: reason.trim() },
      ipAddress: actor.ip ?? null,
    });
    return updated;
  }

  /**
   * Idempotent expiry sweeper. Safe to run on a schedule; rows already in the
   * correct state are untouched.
   */
  async runExpirySweeper(now: Date = new Date()): Promise<{ expiringSoon: number; expired: number }> {
    const { expiringSoonDays, expiryGraceDays } = this.business();
    const soonThreshold = new Date(now.getTime() + expiringSoonDays * 86_400_000);
    const expiredThreshold = new Date(now.getTime() - expiryGraceDays * 86_400_000);

    const toExpiringSoon = await this.prisma.subscription.updateMany({
      where: { status: 'ACTIVE', expiresAt: { lte: soonThreshold, gt: now } },
      data: { status: 'EXPIRING_SOON' },
    });

    const toExpired = await this.prisma.subscription.updateMany({
      where: {
        status: { in: ['ACTIVE', 'EXPIRING_SOON'] },
        expiresAt: { lte: expiredThreshold },
      },
      data: { status: 'EXPIRED' },
    });

    if (toExpiringSoon.count > 0 || toExpired.count > 0) {
      await this.audit.log({
        actorType: 'SYSTEM',
        action: 'subscription.sweeper_run',
        entityType: 'subscription',
        after: { expiringSoon: toExpiringSoon.count, expired: toExpired.count },
      });
    }
    return { expiringSoon: toExpiringSoon.count, expired: toExpired.count };
  }

  /**
   * Subscriptions expiring within `withinDays` whose customer is opted in —
   * the scheduler turns these into renewal reminders (Phase 4).
   */
  async getRenewalCandidates(withinDays: number, limit = 200) {
    const now = new Date();
    return this.prisma.subscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'EXPIRING_SOON'] },
        expiresAt: { gt: now, lte: new Date(now.getTime() + withinDays * 86_400_000) },
        customer: { optedIn: true },
      },
      take: limit,
      include: {
        plan: { select: { name: true, pricePaisa: true } },
        customer: { select: { id: true, whatsappNumber: true, name: true, language: true } },
      },
      orderBy: { expiresAt: 'asc' },
    });
  }
}
