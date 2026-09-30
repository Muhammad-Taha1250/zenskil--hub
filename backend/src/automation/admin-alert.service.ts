import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';

// Admin alert outbox (Phase 6): durable retry for ticket admin notifications.
//
// Problem it solves: the ticket-alerts workflow used to claim a ticket
// (setting alertedAt) and then POST the admin webhook from n8n — if that POST
// failed, the ticket was marked "alerted" but no human was ever notified.
// Now claiming only ENQUEUES a row; this service POSTs the payload to
// ZENSKILL_ADMIN_ALERT_URL with backoff until SENT or DEAD, so no ticket
// alert is silently lost.
//
// Concurrency: processOutbox() claims each row with one atomic
// UPDATE … FOR UPDATE SKIP LOCKED that sets a delivery lease (locked_until).
// The webhook POST then runs OUTSIDE any database transaction — a slow admin
// endpoint can never hold a transaction or row lock open. Concurrent
// processors skip leased rows, so no alert is delivered twice by two live
// workers. Crash safety: a worker that dies mid-delivery leaves a stale
// lease; the next sweep reclaims it (at-least-once after a crash — the
// receiver should dedupe on ticket_id).

export const ALERT_MAX_ATTEMPTS = 5;
// Backoff between attempts: 1m → 5m → 30m → 2h → 8h (same ladder as the
// WhatsApp outbound retry sweeper).
export const ALERT_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 8 * 3_600_000];
// Delivery lease: comfortably longer than the webhook timeout so a merely
// slow endpoint never triggers a duplicate delivery.
export const ALERT_LEASE_MS = 120_000;
const WEBHOOK_TIMEOUT_MS = 15_000;

export interface AlertPayload {
  ticketId: string;
  ticketNumber: string;
  priority: string;
  subject: string;
  customerName: string | null;
  customerWhatsapp: string;
  createdAt: string;
}

type DbClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class AdminAlertService {
  private readonly logger = new Logger(AdminAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Enqueue one alert per ticket; idempotent (UNIQUE on ticket_id).
   * Accepts an optional transaction so the caller can make
   * claim → enqueue → audit atomic (see AutomationService.claimTicketAlert).
   */
  async enqueue(
    ticketId: string,
    payload: AlertPayload,
    db: DbClient = this.prisma,
  ): Promise<{ enqueued: boolean }> {
    try {
      await db.adminAlertOutbox.create({
        data: { ticketId, payload: payload as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { enqueued: false };
      throw err;
    }
    await this.audit.log({
      actorType: 'SYSTEM', actorId: null,
      action: 'automation.admin_alert_enqueued',
      entityType: 'support_ticket', entityId: ticketId,
      after: { ticketNumber: payload.ticketNumber, priority: payload.priority },
      ipAddress: null,
    }, db);
    return { enqueued: true };
  }

  /** Monitoring view: how many alerts are waiting / failed permanently. */
  async outboxStatus(): Promise<{ pending: number; dead: number; sent24h: number }> {
    const [pending, dead, sent24h] = await Promise.all([
      this.prisma.adminAlertOutbox.count({ where: { status: 'PENDING' } }),
      this.prisma.adminAlertOutbox.count({ where: { status: 'DEAD' } }),
      this.prisma.adminAlertOutbox.count({
        where: { status: 'SENT', sentAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
      }),
    ]);
    return { pending, dead, sent24h };
  }

  /** Safety net: deliver due alerts every minute even if n8n is down. */
  @Cron(CronExpression.EVERY_MINUTE)
  async cronProcessOutbox(): Promise<void> {
    await this.processOutbox(50).catch((err) =>
      this.logger.error(`Outbox cron failed: ${err instanceof Error ? err.message : err}`),
    );
  }

  /**
   * Deliver due PENDING alerts. Returns counts per outcome.
   * Safe to call concurrently (atomic lease claims; network I/O outside any
   * transaction) and safe to call when no webhook URL is configured (rows
   * stay PENDING, attempts not burned).
   */
  async processOutbox(limit = 50): Promise<{ sent: number; failed: number; dead: number; skipped: number }> {
    const url = this.config.get<string>('ZENSKILL_ADMIN_ALERT_URL');
    const outcome = { sent: 0, failed: 0, dead: 0, skipped: 0 };
    if (!url) {
      const pending = await this.prisma.adminAlertOutbox.count({
        where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      });
      if (pending > 0) {
        this.logger.warn(
          `ZENSKILL_ADMIN_ALERT_URL not configured — ${pending} ticket alert(s) waiting in outbox`,
        );
      }
      outcome.skipped = pending;
      return outcome;
    }

    // Reclaim stale leases left by crashed workers before claiming new rows.
    await this.prisma.adminAlertOutbox.updateMany({
      where: { status: 'PENDING', lockedUntil: { lte: new Date() } },
      data: { lockedUntil: null },
    });

    for (let i = 0; i < limit; i++) {
      const claim = await this.claimOne();
      if (!claim) break;
      const attempts = claim.attemptCount + 1;
      try {
        // Network I/O outside any transaction: nothing locks while we wait.
        await this.postWebhook(url, claim.payload);
        const done = await this.prisma.adminAlertOutbox.updateMany({
          where: { id: claim.id, lockedUntil: claim.lockedUntil },
          data: {
            status: 'SENT', sentAt: new Date(), attemptCount: attempts,
            lastError: null, lockedUntil: null,
          },
        });
        if (done.count !== 1) continue; // lease lost to recovery; skip
        outcome.sent += 1;
        await this.audit.log({
          actorType: 'SYSTEM', actorId: null,
          action: 'automation.admin_alert_sent',
          entityType: 'support_ticket', entityId: claim.ticketId,
          after: { attempts }, ipAddress: null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 300) : 'unknown';
        const finalize = (data: Prisma.AdminAlertOutboxUpdateInput) =>
          this.prisma.adminAlertOutbox.updateMany({
            where: { id: claim.id, lockedUntil: claim.lockedUntil },
            data: { ...data, lockedUntil: null },
          });
        if (attempts >= ALERT_MAX_ATTEMPTS) {
          const done = await finalize({ status: 'DEAD', attemptCount: attempts, lastError: message });
          if (done.count !== 1) continue;
          outcome.dead += 1;
          await this.audit.log({
            actorType: 'SYSTEM', actorId: null,
            action: 'automation.admin_alert_dead',
            entityType: 'support_ticket', entityId: claim.ticketId,
            after: { attempts, lastError: message }, ipAddress: null,
          });
          this.logger.error(`Admin alert for ticket ${claim.ticketId} DEAD after ${attempts} attempts: ${message}`);
        } else {
          const backoff = ALERT_BACKOFF_MS[Math.min(attempts - 1, ALERT_BACKOFF_MS.length - 1)];
          const done = await finalize({
            attemptCount: attempts,
            nextAttemptAt: new Date(Date.now() + backoff),
            lastError: message,
          });
          if (done.count !== 1) continue;
          outcome.failed += 1;
          await this.audit.log({
            actorType: 'SYSTEM', actorId: null,
            action: 'automation.admin_alert_retry',
            entityType: 'support_ticket', entityId: claim.ticketId,
            after: { attempts, nextAttemptInMs: backoff, lastError: message }, ipAddress: null,
          });
        }
      }
    }
    return outcome;
  }

  /**
   * Atomically claim one due row: SELECT … FOR UPDATE SKIP LOCKED picks a
   * row no live worker holds, and the UPDATE stamps our lease. Returns null
   * when nothing is due.
   */
  private async claimOne(): Promise<{
    id: string; ticketId: string; payload: unknown; attemptCount: number; lockedUntil: Date;
  } | null> {
    const leaseUntil = new Date(Date.now() + ALERT_LEASE_MS);
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; ticket_id: string; payload: unknown; attempt_count: number; locked_until: Date;
    }>>`
      UPDATE admin_alert_outbox
      SET locked_until = ${leaseUntil}
      WHERE id = (
        SELECT id FROM admin_alert_outbox
        WHERE status = 'PENDING' AND next_attempt_at <= now()
          AND (locked_until IS NULL OR locked_until <= now())
        ORDER BY next_attempt_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, ticket_id, payload, attempt_count, locked_until
    `;
    const r = rows[0];
    return r
      ? { id: r.id, ticketId: r.ticket_id, payload: r.payload, attemptCount: r.attempt_count, lockedUntil: r.locked_until }
      : null;
  }

  private async postWebhook(url: string, payload: unknown): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ticket_alert', ...(payload as Record<string, unknown>) }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`admin webhook HTTP ${res.status}`);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null &&
    'code' in err && (err as { code?: string }).code === 'P2002'
  );
}
