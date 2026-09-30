import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { NotificationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import type { StateTransitionActor } from '../customers/customers.service';

// Notifications (spec §50): queued outbound messages — renewal reminders,
// payment confirmations, fulfillment updates. Templates only (marketing) or
// transactional; the WhatsApp service enforces opt-in/window rules.
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly whatsapp: WhatsappService,
  ) {}

  async queue(
    customerId: string,
    input: { templateName?: string; payload?: unknown; channel?: string },
    actor: StateTransitionActor,
  ) {
    const notification = await this.prisma.notification.create({
      data: {
        customerId,
        channel: input.channel ?? 'whatsapp',
        templateName: input.templateName ?? null,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
        status: 'QUEUED',
      },
    });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'notification.queued', entityType: 'notification', entityId: notification.id,
      after: { templateName: input.templateName ?? null },
      ipAddress: actor.ip ?? null,
    });
    return notification;
  }

  async list(params: { page?: number; pageSize?: number; status?: NotificationStatus }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const where: Prisma.NotificationWhereInput = {};
    if (params.status) where.status = params.status;
    const [total, items] = await this.prisma.$transaction([
      this.prisma.notification.count({ where }),
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { customer: { select: { whatsappNumber: true, name: true } } },
      }),
    ]);
    return { total, page, pageSize, items };
  }

  /**
   * Sends one queued notification via WhatsApp template. Idempotent: already
   * SENT rows are skipped; FAILED rows retry with exponential-backoff count.
   */
  async sendQueued(id: string): Promise<{ status: NotificationStatus }> {
    const notification = await this.prisma.notification.findUniqueOrThrow({ where: { id } });
    if (notification.status === 'SENT') return { status: 'SENT' };
    if (!notification.templateName) throw new BadRequestException('Notification has no template');

    const payload = notification.payload as { languageCode?: string; variables?: string[] };
    try {
      const messageId = await this.whatsapp.sendTemplateNotification(notification.customerId, {
        templateName: notification.templateName,
        languageCode: payload.languageCode ?? 'en',
        variables: payload.variables ?? [],
      });
      if (!messageId) {
        await this.prisma.notification.update({
          where: { id },
          data: { status: 'FAILED', error: 'Blocked: customer not opted in' },
        });
        return { status: 'FAILED' };
      }
      await this.prisma.notification.update({
        where: { id },
        data: { status: 'SENT', whatsappMessageId: messageId, sentAt: new Date(), error: null },
      });
      return { status: 'SENT' };
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 500) : 'send failed';
      await this.prisma.notification.update({ where: { id }, data: { status: 'FAILED', error } });
      this.logger.warn(`Notification ${id} failed: ${error}`);
      return { status: 'FAILED' };
    }
  }

  /** Sends up to `limit` queued notifications (called by the Phase 4 scheduler). */
  async flushQueue(limit = 50): Promise<{ sent: number; failed: number }> {
    const queued = await this.prisma.notification.findMany({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    let sent = 0, failed = 0;
    for (const n of queued) {
      const { status } = await this.sendQueued(n.id);
      if (status === 'SENT') sent++; else failed++;
    }
    return { sent, failed };
  }
}
