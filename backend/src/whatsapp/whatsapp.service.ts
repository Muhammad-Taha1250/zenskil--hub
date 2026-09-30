import { BadRequestException, Inject, Injectable, Logger, OnModuleInit, ServiceUnavailableException, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ConversationsService } from '../conversations/conversations.service';
import {
  InboundMessage,
  InteractiveButton,
  OutboundInteractive,
  OutboundMedia,
  OutboundTemplate,
  OutboundText,
  WhatsAppClient,
} from './whatsapp-client.interface';
import { BaileysClient, BaileysError } from './baileys.client';

const STOP_WORDS = new Set(['stop', 'unsubscribe', 'opt out', 'optout', 'quit', 'cancel messages']);
const START_WORDS = new Set(['start', 'subscribe', 'opt in', 'optin', 'resume']);

/** Delivery status reported by the provider for an outbound message. */
export interface StatusUpdate {
  providerMessageId: string;
  recipient: string;
  status: string; // 'sent' | 'delivered' | 'read' | 'failed' | ...
  timestamp: Date;
  errorCode?: string;
}

/** Exact outbound request persisted on the message row for faithful retries. */
export type StoredPayload =
  | ({ __kind: 'text' } & OutboundText)
  | ({ __kind: 'template' } & OutboundTemplate)
  | ({ __kind: 'interactive' } & OutboundInteractive)
  | ({ __kind: 'media' } & OutboundMedia);

// Backoff between send retries (attempt 1..5). WhatsApp sends are safe to
// retry: they carry no money movement, and each attempt is idempotent at the
// business level (a duplicate text is a nuisance, never a double charge).
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 8 * 3_600_000];
const MAX_SEND_ATTEMPTS = 5;

type StoredKind = 'text' | 'template' | 'interactive' | 'media';

// WhatsApp ingress/egress (spec §40/§41):
// - Receives inbound messages from the Baileys WebSocket client (no Meta
//   webhooks, no HMAC — the socket itself is the authenticated channel).
// - Enforces opt-in/out, 24h service window, and template-kind marketing
//   policy locally before any send.
// - Persists every inbound/outbound message; failed outbound sends are
//   retried with exponential backoff by retryFailedOutbound().
// - Sends go through the WhatsAppClient so swapping providers never touches
//   conversation logic.
@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);
  private client: WhatsAppClient | null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly baileys: BaileysClient,
    @Inject(forwardRef(() => ConversationsService))
    private readonly conversations: ConversationsService,
  ) {
    // Default provider: Baileys (WhatsApp Web socket). useClient() swaps it
    // for tests.
    this.client = baileys;
  }

  /**
   * Wires the Baileys socket into the conversation pipeline. Runs after
   * BaileysClient.onModuleInit (dependency order), so the handlers are in
   * place before the socket can deliver its first message; anything that
   * arrives earlier is buffered by the client, never dropped.
   */
  async onModuleInit(): Promise<void> {
    this.baileys.onInbound((msg) =>
      this.conversations.handleInbound(msg).catch((err) => {
        this.logger.error(`Inbound handling failed: ${err instanceof Error ? err.message : err}`);
      }),
    );
    this.baileys.onStatusUpdates((updates) =>
      this.handleStatusUpdates(updates).catch((err) => {
        this.logger.error(`Status handling failed: ${err instanceof Error ? err.message : err}`);
      }),
    );
    if (!this.baileys.connected) {
      this.logger.warn(
        'WhatsApp socket not connected yet — scan the QR printed in the logs, then verify with GET /api/v1/admin/whatsapp/status',
      );
    }
  }

  get configured(): boolean {
    return this.client !== null;
  }

  /** True when the Baileys socket is open and can send/receive. */
  get connected(): boolean {
    return this.client instanceof BaileysClient ? this.client.connected : this.client !== null;
  }

  /** True while the socket is waiting for the QR to be scanned. */
  get awaitingQrScan(): boolean {
    return this.client instanceof BaileysClient ? this.client.awaitingQrScan : false;
  }

  /** Test/simulator seam: swap the underlying client at runtime. */
  useClient(client: WhatsAppClient | null): void {
    this.client = client;
  }

  /** Applies provider delivery statuses to our stored outbound messages. */
  async handleStatusUpdates(updates: StatusUpdate[]): Promise<void> {
    for (const u of updates) {
      const mapped = mapProviderStatus(u.status);
      if (!mapped) continue;
      try {
        const msg = await this.prisma.message.findUnique({
          where: { whatsappMessageId: u.providerMessageId },
        });
        if (!msg || msg.direction !== 'OUTBOUND') continue;
        // Statuses are monotonic-ish; never move backwards except to FAILED.
        if (mapped === 'FAILED' || statusRank(mapped) > statusRank(msg.status)) {
          await this.prisma.message.update({
            where: { id: msg.id },
            data: {
              status: mapped,
              ...(mapped === 'FAILED' && u.errorCode ? { errorCode: u.errorCode } : {}),
              // A provider-reported failure counts as a terminal send failure:
              // schedule a retry through the same backoff path as local errors.
              ...(mapped === 'FAILED' ? this.retrySchedule(msg.retryCount + 1, u.errorCode ?? 'provider reported failure') : {}),
            },
          });
        }
      } catch (err) {
        this.logger.warn(`Status update failed for ${u.providerMessageId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** Handles STOP/START keywords. Returns 'opted_out' | 'opted_in' | null. */
  async handleOptKeywords(customerId: string, text: string | undefined): Promise<'opted_out' | 'opted_in' | null> {
    const normalized = (text ?? '').trim().toLowerCase();
    if (!normalized) return null;
    if (STOP_WORDS.has(normalized)) {
      await this.prisma.customer.update({ where: { id: customerId }, data: { optedIn: false } });
      await this.audit.log({ actorType: 'CUSTOMER', actorId: customerId, action: 'customer.opted_out', entityType: 'customer', entityId: customerId });
      return 'opted_out';
    }
    if (START_WORDS.has(normalized)) {
      await this.prisma.customer.update({ where: { id: customerId }, data: { optedIn: true } });
      await this.audit.log({ actorType: 'CUSTOMER', actorId: customerId, action: 'customer.opted_in', entityType: 'customer', entityId: customerId });
      return 'opted_in';
    }
    return null;
  }

  // ------------------------------------------------------- outbound

  /**
   * Sends free-form text ONLY inside the 24h customer-service window.
   * Free-form messages outside the window are blocked even for opted-in
   * customers — those must use sendTemplateNotification(). Marketing
   * (template kind) additionally requires opt-in. These are platform
   * policies enforced locally (unsolicited messaging risks number bans),
   * not Meta API rules — Baileys itself imposes no template requirement.
   * Returns null when blocked (audited); never throws for policy blocks.
   */
  async sendText(sessionId: string, customerId: string, to: string, msg: Omit<OutboundText, 'to'>): Promise<string | null> {
    const policy = await this.checkSendPolicy(customerId, msg.kind, 'free-form text');
    if (!policy.ok) return null;
    const body: OutboundText = { to, ...msg };
    return this.persistAndSend(sessionId, customerId, to, 'text', msg.body.slice(0, 4096), body);
  }

  /**
   * Sends interactive options (rendered as a numbered list by the Baileys
   * client). Same 24h-window policy as free-form text: interactive messages
   * count as free-form and are blocked outside the customer-service window.
   */
  async sendInteractive(
    sessionId: string,
    customerId: string,
    to: string,
    msg: Omit<OutboundInteractive, 'to'>,
  ): Promise<string | null> {
    const policy = await this.checkSendPolicy(customerId, msg.kind, 'interactive message');
    if (!policy.ok) return null;
    const body: OutboundInteractive = {
      to,
      body: msg.body,
      buttons: msg.buttons.slice(0, 3).map((b: InteractiveButton) => ({ id: b.id, title: b.title })),
      replyToMessageId: msg.replyToMessageId,
      kind: msg.kind,
    };
    return this.persistAndSend(sessionId, customerId, to, 'interactive', msg.body.slice(0, 1024), body);
  }

  async sendMediaMessage(
    sessionId: string,
    customerId: string,
    to: string,
    msg: Omit<OutboundMedia, 'to'>,
  ): Promise<string | null> {
    const policy = await this.checkSendPolicy(customerId, msg.kind, 'media message');
    if (!policy.ok) return null;
    const body: OutboundMedia = { to, ...msg, kind: msg.kind };
    return this.persistAndSend(sessionId, customerId, to, 'media', (msg.caption ?? '[media]').slice(0, 1024), body);
  }

  async sendTemplateNotification(customerId: string, template: Omit<OutboundTemplate, 'to' | 'renderedBody'>): Promise<string | null> {
    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    if (!customer.optedIn) {
      await this.audit.log({
        actorType: 'SYSTEM', action: 'whatsapp.template_blocked',
        entityType: 'customer', entityId: customerId,
        after: { template: template.templateName, reason: 'not_opted_in' },
      });
      return null;
    }
    // Baileys has no server-side template registry: the full message body is
    // rendered locally from the message_templates table (owner-managed via
    // the admin panel; seeded from the approved drafts). A missing template
    // or a missing variable fails LOUD — sending bare variable fragments to
    // a customer is worse than sending nothing.
    const rendered = await this.renderTemplateNotification(template.templateName, template.languageCode, template.variables);
    const session = await this.prisma.conversationSession.findFirst({
      where: { customerId },
      orderBy: { updatedAt: 'desc' },
    });
    const sessionId = session?.id ?? (await this.ensureSession(customerId)).id;
    const body: OutboundTemplate = { to: customer.whatsappNumber, ...template, renderedBody: rendered };
    return this.persistAndSend(
      sessionId, customerId, customer.whatsappNumber, 'template',
      rendered.slice(0, 2000),
      body,
    );
  }

  /**
   * Resolves a template body from message_templates and substitutes
   * {{1}}..{{n}} with the variables. Throws when the template is unknown
   * (tried exact language, then 'en') or a placeholder has no variable —
   * callers must fix the data, not ship a degraded message.
   */
  async renderTemplateNotification(templateName: string, languageCode: string, variables: string[]): Promise<string> {
    const tpl =
      (await this.prisma.messageTemplate.findFirst({
        where: { name: templateName, language: languageCode, isActive: true },
      })) ??
      (await this.prisma.messageTemplate.findFirst({
        where: { name: templateName, language: 'en', isActive: true },
      }));
    if (!tpl) {
      throw new BadRequestException(
        `Unknown WhatsApp template "${templateName}" (HUMAN ACTION REQUIRED: add it to message_templates via the admin panel)`,
      );
    }
    return renderTemplateBody(tpl.body, variables);
  }

  /**
   * Retries failed outbound sends whose backoff has elapsed. Safe to run on
   * a schedule: each message is attempted at most MAX_SEND_ATTEMPTS times,
   * then left FAILED (dead-letter) for human review.
   */
  async retryFailedOutbound(limit = 25): Promise<{ retried: number; sent: number; dead: number }> {
    const due = await this.prisma.message.findMany({
      where: {
        direction: 'OUTBOUND',
        status: 'FAILED',
        retryCount: { lt: MAX_SEND_ATTEMPTS },
        nextRetryAt: { lte: new Date() },
      },
      orderBy: { nextRetryAt: 'asc' },
      take: limit,
    });
    let sent = 0;
    let dead = 0;
    for (const m of due) {
      const payload = m.payload as unknown as StoredPayload | null;
      if (!payload || !this.client) {
        // No client (or corrupted payload): leave for the next sweep.
        continue;
      }
      try {
        const res = await this.dispatchSend(payload);
        await this.prisma.message.update({
          where: { id: m.id },
          data: { status: 'SENT', whatsappMessageId: res.providerMessageId, nextRetryAt: null, errorCode: null },
        });
        sent += 1;
      } catch (err) {
        const attempts = m.retryCount + 1;
        const retryable = isRetryableSendError(err);
        await this.prisma.message.update({
          where: { id: m.id },
          data: {
            status: 'FAILED',
            retryCount: attempts,
            ...(retryable && attempts < MAX_SEND_ATTEMPTS
              ? { nextRetryAt: new Date(Date.now() + RETRY_BACKOFF_MS[attempts - 1]) }
              : { nextRetryAt: null }),
            errorCode: err instanceof Error ? err.message.slice(0, 500) : 'send failed',
          },
        });
        if (!retryable || attempts >= MAX_SEND_ATTEMPTS) dead += 1;
        await this.audit.log({
          actorType: 'SYSTEM', action: 'whatsapp.send_retry_failed',
          entityType: 'message', entityId: m.id,
          after: { attempt: attempts, dead: !retryable || attempts >= MAX_SEND_ATTEMPTS },
        });
      }
    }
    return { retried: due.length, sent, dead };
  }

  async markRead(providerMessageId: string): Promise<void> {
    if (this.client) await this.client.markRead(providerMessageId);
  }

  /**
   * Owner-initiated live-socket probe (used by the admin test-send endpoint).
   * Bypasses the 24h-window policy deliberately — this is an explicit human
   * action. The send is NOT persisted as a conversation message; the result
   * is returned for diagnostics.
   */
  async sendDiagnosticText(to: string, body: string): Promise<{ providerMessageId: string }> {
    if (!this.client) throw new BadRequestException('WhatsApp client not configured');
    return this.client.sendText({ to, body: body.slice(0, 4096), kind: 'transactional' });
  }

  /**
   * Automation/operator text send (POST /api/whatsapp/send).
   * Deliberate policy bypass like sendDiagnosticText: the caller proved
   * AUTOMATION_SERVICE_TOKEN, so this is an explicit operator action, not
   * customer-pipeline traffic (which must keep using the 24h-window paths:
   * sendText / sendTemplateNotification). The send is audited.
   */
  async sendAutomationText(to: string, body: string): Promise<{ providerMessageId: string }> {
    if (!this.client) throw new BadRequestException('WhatsApp client not configured');
    if (!this.connected) throw new ServiceUnavailableException('WhatsApp socket not connected');
    const { providerMessageId } = await this.client.sendText({
      to,
      body: body.slice(0, 4096),
      kind: 'transactional',
    });
    await this.audit.log({
      actorType: 'SYSTEM',
      action: 'whatsapp.automation_send',
      entityType: 'message',
      entityId: providerMessageId,
      after: { to },
    });
    return { providerMessageId };
  }

  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }> {
    if (!this.client?.downloadMedia) throw new BadRequestException('Media download not available');
    return this.client.downloadMedia(mediaId);
  }

  async uploadMedia(data: Buffer, mimeType: string, filename?: string): Promise<{ mediaId: string }> {
    if (!this.client) throw new BadRequestException('WhatsApp client not configured');
    return this.client.uploadMedia(data, mimeType, filename);
  }

  private async ensureSession(customerId: string) {
    return this.prisma.conversationSession.create({
      data: { customerId },
    });
  }

  /** 24h service window: customer sent any message in the last 24h. */
  async isInServiceWindow(customerId: string): Promise<boolean> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await this.prisma.message.count({
      where: {
        direction: 'INBOUND',
        createdAt: { gte: since },
        session: { customerId },
      },
    });
    return count > 0;
  }

  // ------------------------------------------------------- internals

  private async checkSendPolicy(
    customerId: string,
    kind: 'transactional' | 'template',
    what: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    const inWindow = await this.isInServiceWindow(customerId);
    if (!inWindow) {
      await this.audit.log({
        actorType: 'SYSTEM', action: 'whatsapp.send_blocked',
        entityType: 'customer', entityId: customerId,
        after: { reason: 'free_form_outside_24h_window', kind, what },
      });
      return { ok: false, reason: 'free_form_outside_24h_window' };
    }
    if (kind === 'template' && !customer.optedIn) {
      await this.audit.log({
        actorType: 'SYSTEM', action: 'whatsapp.send_blocked',
        entityType: 'customer', entityId: customerId,
        after: { reason: 'template_requires_opt_in', what },
      });
      return { ok: false, reason: 'template_requires_opt_in' };
    }
    return { ok: true };
  }

  /**
   * Sends an admin-authored text message (e.g. a support-ticket reply) to a
   * customer over WhatsApp. Policy is enforced before sending:
   *  - opted-out customers are never messaged (reason 'customer_opted_out')
   *  - free-form text is only sent inside the 24h customer-service window
   *    (reason 'free_form_outside_24h_window')
   * Returns a delivery verdict instead of throwing for policy blocks, so the
   * caller can report honestly what happened. Never invents delivery.
   */
  async sendAdminTextToCustomer(
    customerId: string,
    bodyText: string,
    actor: { type: 'ADMIN'; id: string | null; ip?: string | null },
  ): Promise<{ delivered: boolean; reason?: string; messageId?: string | null }> {
    const body = bodyText?.trim() ?? '';
    if (!body) throw new BadRequestException('Message body is required');
    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    if (!customer.optedIn) {
      await this.audit.log({
        actorType: actor.type, actorId: actor.id ?? null,
        action: 'whatsapp.admin_reply_blocked', entityType: 'customer', entityId: customerId,
        after: { reason: 'customer_opted_out' }, ipAddress: actor.ip ?? null,
      });
      return { delivered: false, reason: 'customer_opted_out' };
    }
    const policy = await this.checkSendPolicy(customerId, 'transactional', 'admin reply');
    if (!policy.ok) {
      await this.audit.log({
        actorType: actor.type, actorId: actor.id ?? null,
        action: 'whatsapp.admin_reply_blocked', entityType: 'customer', entityId: customerId,
        after: { reason: policy.reason ?? 'send_blocked' }, ipAddress: actor.ip ?? null,
      });
      return { delivered: false, reason: policy.reason ?? 'send_blocked' };
    }
    const session = await this.prisma.conversationSession.findFirst({
      where: { customerId },
      orderBy: { updatedAt: 'desc' },
    });
    const sessionId = session?.id ?? (await this.ensureSession(customerId)).id;
    const messageId = await this.sendText(sessionId, customerId, customer.whatsappNumber, {
      body: body.slice(0, 4096),
      kind: 'transactional',
    });
    if (!messageId) {
      // Policy changed between the pre-check and the send (or the provider
      // path failed closed); report the block, never a phantom delivery.
      return { delivered: false, reason: 'send_blocked' };
    }
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'whatsapp.admin_reply_sent', entityType: 'customer', entityId: customerId,
      after: { messageId }, ipAddress: actor.ip ?? null,
    });
    return { delivered: true, messageId };
  }

  /**
   * Per-customer outbound rate cap (Phase 10, T14): at most
   * WHATSAPP_MAX_PER_CUSTOMER_PER_HOUR (default 30) outbound messages per
   * customer per rolling hour. This is the anti-spam/abuse backstop behind
   * the global 120 req/min throttler — a bug or a compromised admin flow
   * can only reach one customer 30 times an hour before ban/spam risk
   * kicks in. Retries (retryFailedOutbound) bypass persistAndSend and are
   * not counted: they re-attempt already-counted messages.
   */
  private async checkHourlySendCap(customerId: string, what: string): Promise<boolean> {
    const raw = this.config.get<string>('WHATSAPP_MAX_PER_CUSTOMER_PER_HOUR');
    const parsed = raw === undefined || raw === '' ? 30 : Number(raw);
    const maxPerHour = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 30;
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const sentLastHour = await this.prisma.message.count({
      where: {
        direction: 'OUTBOUND',
        createdAt: { gte: since },
        session: { customerId },
      },
    });
    if (sentLastHour >= maxPerHour) {
      await this.audit.log({
        actorType: 'SYSTEM', action: 'whatsapp.send_blocked',
        entityType: 'customer', entityId: customerId,
        after: { reason: 'hourly_rate_limit_exceeded', sentLastHour, maxPerHour, what },
      });
      return false;
    }
    return true;
  }

  private async persistAndSend(
    sessionId: string,
    customerId: string,
    to: string,
    kind: StoredKind,
    bodyText: string,
    payload: OutboundText | OutboundTemplate | OutboundInteractive | OutboundMedia,
  ): Promise<string | null> {
    if (!(await this.checkHourlySendCap(customerId, kind))) return null;
    const stored = await this.prisma.message.create({
      data: {
        sessionId,
        direction: 'OUTBOUND',
        messageType: kind === 'text' ? 'TEXT' : kind === 'template' ? 'TEMPLATE' : kind === 'interactive' ? 'BUTTON' : 'MEDIA',
        bodyText,
        status: this.client ? 'QUEUED' : 'FAILED',
        payload: { __kind: kind, ...payload } as unknown as Prisma.InputJsonValue,
        ...(this.client ? {} : { errorCode: 'whatsapp client not configured', nextRetryAt: new Date(Date.now() + RETRY_BACKOFF_MS[0]) }),
      },
    });
    if (!this.client) return stored.id;
    try {
      const { providerMessageId } = await this.dispatchSend({ __kind: kind, ...payload } as StoredPayload);
      await this.prisma.message.update({
        where: { id: stored.id },
        data: { status: 'SENT', whatsappMessageId: providerMessageId, nextRetryAt: null },
      });
    } catch (err) {
      const retryable = isRetryableSendError(err);
      await this.prisma.message.update({
        where: { id: stored.id },
        data: {
          status: 'FAILED',
          retryCount: 1,
          nextRetryAt: retryable ? new Date(Date.now() + RETRY_BACKOFF_MS[0]) : null,
          errorCode: err instanceof Error ? err.message.slice(0, 500) : 'send failed',
        },
      });
      await this.audit.log({
        actorType: 'SYSTEM', action: 'whatsapp.send_failed',
        entityType: 'message', entityId: stored.id,
        after: { retryable, error: err instanceof Error ? err.message.slice(0, 300) : 'unknown' },
      });
      throw err;
    }
    return stored.id;
  }

  private async dispatchSend(payload: StoredPayload): Promise<{ providerMessageId: string }> {
    if (!this.client) throw new BadRequestException('WhatsApp client not configured');
    switch (payload.__kind) {
      case 'text':
        return this.client.sendText(payload);
      case 'template':
        // payload.renderedBody is always resolved by the service from
        // message_templates; the client sends it verbatim (Baileys has no
        // server-side template registry).
        return this.client.sendTemplate(payload);
      case 'interactive':
        return this.client.sendInteractive(payload);
      case 'media':
        return this.client.sendMedia(payload);
    }
  }

  private retrySchedule(retryCount: number, error: string): { retryCount: number; nextRetryAt: Date | null; errorCode: string } {
    const exhausted = retryCount >= MAX_SEND_ATTEMPTS;
    return {
      retryCount,
      nextRetryAt: exhausted ? null : new Date(Date.now() + RETRY_BACKOFF_MS[Math.min(retryCount - 1, RETRY_BACKOFF_MS.length - 1)]),
      errorCode: error.slice(0, 500),
    };
  }
}

function mapProviderStatus(status: string): NotificationStatus | null {
  switch (status) {
    case 'sent':
      return 'SENT';
    case 'delivered':
      return 'DELIVERED';
    case 'read':
      return 'READ';
    case 'failed':
      return 'FAILED';
    default:
      return null;
  }
}

const statusMap: Record<string, number> = { QUEUED: 0, FAILED: 0, SENT: 1, DELIVERED: 2, READ: 3 };

function statusRank(s: NotificationStatus): number {
  return statusMap[s];
}

function isRetryableSendError(err: unknown): boolean {
  if (err instanceof BaileysError) return err.retryable;
  // Unknown errors are treated as retryable (network-ish); the attempt cap
  // bounds the damage, and non-retryable provider errors are classified by
  // the client before they reach here.
  return true;
}

/**
 * Substitutes {{1}}..{{n}} placeholders with the variables (1-based).
 * Throws BadRequestException when a placeholder has no matching variable —
 * a wrong variable count is a code bug, and shipping a half-rendered
 * customer message is worse than failing loud.
 */
export function renderTemplateBody(body: string, variables: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (match, num: string) => {
    const idx = Number(num) - 1;
    const value = variables[idx];
    if (value === undefined) {
      throw new BadRequestException(
        `Template placeholder {{${num}}} has no variable (got ${variables.length} variables)`,
      );
    }
    return value;
  });
}
