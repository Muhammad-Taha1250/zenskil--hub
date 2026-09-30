import { Boom } from '@hapi/boom';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import makeWASocket, {
  DisconnectReason,
  WAMessage,
  WAMessageKey,
  WASocket,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import qrcode from 'qrcode-terminal';
import type { StatusUpdate } from './whatsapp.service';
import {
  InboundMessage,
  OutboundInteractive,
  OutboundMedia,
  OutboundTemplate,
  OutboundText,
  WhatsAppClient,
  normalizePhoneNumber,
  toWhatsappJid,
} from './whatsapp-client.interface';

export class BaileysError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts?: { retryable?: boolean }) {
    super(message);
    this.name = 'BaileysError';
    this.retryable = opts?.retryable ?? false;
  }
}

export type InboundHandler = (msg: InboundMessage) => void | Promise<void>;
export type StatusHandler = (updates: StatusUpdate[]) => void | Promise<void>;

/** Public connection states served by GET /api/whatsapp/status. */
export type WhatsappConnectionState = 'CONNECTED' | 'DISCONNECTED' | 'CONNECTING' | 'QR_READY';

// ------------------------------------------------------------ pure helpers

type ExtractedContent = {
  text?: string;
  buttonId?: string;
  mediaKind?: 'image' | 'video' | 'document' | 'audio';
  mediaMimeType?: string;
};

/** Pulls text / button / media fields out of a Baileys proto message. */
export function extractBaileysContent(content: proto.IMessage | null | undefined): ExtractedContent {
  if (!content) return {};
  if (content.conversation) return { text: content.conversation };
  const ext = content.extendedTextMessage;
  if (ext?.text) return { text: ext.text };
  const img = content.imageMessage;
  if (img) return { text: img.caption ?? undefined, mediaKind: 'image', mediaMimeType: img.mimetype ?? undefined };
  const vid = content.videoMessage;
  if (vid) return { text: vid.caption ?? undefined, mediaKind: 'video', mediaMimeType: vid.mimetype ?? undefined };
  const doc = content.documentMessage;
  if (doc) return { text: doc.caption ?? undefined, mediaKind: 'document', mediaMimeType: doc.mimetype ?? undefined };
  const aud = content.audioMessage;
  if (aud) return { mediaKind: 'audio', mediaMimeType: aud.mimetype ?? undefined };
  const btn = content.buttonsResponseMessage;
  if (btn?.selectedButtonId) return { text: btn.selectedDisplayText ?? undefined, buttonId: btn.selectedButtonId };
  const list = content.listResponseMessage;
  if (list?.singleSelectReply?.selectedRowId) {
    return { text: list.title ?? undefined, buttonId: list.singleSelectReply.selectedRowId };
  }
  const tpl = content.templateButtonReplyMessage;
  if (tpl?.selectedId) return { text: tpl.selectedDisplayText ?? undefined, buttonId: tpl.selectedId };
  const interactive = content.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (interactive?.paramsJson) {
    try {
      const params = JSON.parse(interactive.paramsJson) as { id?: string };
      if (params.id) return { buttonId: params.id };
    } catch {
      // not JSON — nothing to extract
    }
  }
  return {};
}

/**
 * Normalizes a raw Baileys WAMessage into our provider-agnostic
 * InboundMessage. Returns null for unprocessable messages (no id, no
 * sender, or status broadcasts). Pure — unit-testable without a socket.
 */
export function normalizeBaileysMessage(wam: WAMessage): InboundMessage | null {
  const id = wam.key?.id;
  const remoteJid = wam.key?.remoteJid ?? '';
  // Only direct user chats enter the customer pipeline:
  //  - 'status@broadcast' is a status update, not a message
  //  - '@g.us' is a group chat (unsupported)
  //  - '@lid' is an opaque Linked-Device identifier — stripping it would
  //    fabricate a phone number and corrupt customer identity
  //  - anything else is malformed
  const [user, server] = remoteJid.split('@');
  if (!id || server !== 's.whatsapp.net') return null;
  const from = normalizePhoneNumber(user ?? '');
  if (!from) return null;
  const ts = wam.messageTimestamp;
  const msg: InboundMessage = {
    providerMessageId: id,
    from,
    timestamp: new Date(Number(ts ?? Date.now() / 1000) * 1000),
    type: 'unknown',
  };
  const { text, buttonId, mediaKind, mediaMimeType } = extractBaileysContent(wam.message);
  if (buttonId) {
    msg.type = 'button_reply';
    msg.buttonId = buttonId;
    msg.text = text;
  } else if (mediaKind) {
    msg.type = mediaKind;
    msg.text = text;
    msg.caption = text;
    // No Meta media-id concept on Baileys: the WA message id doubles as the
    // media handle — downloadMedia() resolves it through the raw cache.
    msg.mediaId = id;
    msg.mediaMimeType = mediaMimeType;
  } else if (text) {
    msg.type = 'text';
    msg.text = text;
  }
  return msg;
}

/** Maps a Baileys receipt status to our provider-status vocabulary. */
export function mapBaileysStatus(status: number | null | undefined): StatusUpdate['status'] | null {
  const S = proto.WebMessageInfo.Status;
  switch (status) {
    case S.SERVER_ACK:
      return 'sent';
    case S.DELIVERY_ACK:
      return 'delivered';
    case S.READ:
    case S.PLAYED:
      return 'read';
    default:
      return null;
  }
}

function toBaileysError(err: unknown, what: string): BaileysError {
  const code = (err as Boom | undefined)?.output?.statusCode;
  const retryable = code === 408 || code === 429 || (typeof code === 'number' && code >= 500);
  const message = err instanceof Error ? err.message : String(err);
  return new BaileysError(`${what}: ${message}`, { retryable });
}

const MAX_RAW_CACHE = 300;
const MAX_PENDING_INBOUND = 200;
const MAX_STAGED_UPLOADS = 50;
const RECONNECT_DELAY_MS = 2000;

// ------------------------------------------------------------ client

// Baileys WhatsApp client (unofficial WhatsApp Web socket).
// Replaces the Meta Cloud API: no developer app, no App ID, no tokens.
// The linked device holds the session; auth state lives in BAILEYS_AUTH_DIR
// (default ./baileys_auth). That directory MUST persist across restarts — on
// ephemeral filesystems (e.g. Render without a persistent disk) the QR has
// to be re-scanned on every boot.
//
// Inbound messages are normalized to InboundMessage and handed to handlers
// registered via onInbound() (WhatsappService wires the conversation
// pipeline there). Messages arriving before any handler is registered are
// buffered, never dropped.
@Injectable()
export class BaileysClient implements WhatsAppClient, OnModuleInit, OnModuleDestroy {
  readonly clientName = 'baileys';

  private readonly logger = new Logger(BaileysClient.name);
  private readonly authDir: string;
  private readonly logLevel: string;
  private sock: WASocket | null = null;
  private connecting = false;
  private destroyed = false;
  private connectionState: 'open' | 'connecting' | 'close' = 'close';
  private qrPending = false;
  private latestQr: string | null = null;
  private latestQrDataUri: string | null = null;
  private readonly inboundHandlers: InboundHandler[] = [];
  private readonly statusHandlers: StatusHandler[] = [];
  private readonly pendingInbound: InboundMessage[] = [];
  private readonly rawCache = new Map<string, WAMessage>();
  private readonly stagedUploads = new Map<string, { data: Buffer; mimeType: string; filename: string }>();

  constructor(private readonly config: ConfigService) {
    this.authDir = this.config.get<string>('BAILEYS_AUTH_DIR') ?? './baileys_auth';
    this.logLevel = this.config.get<string>('BAILEYS_LOG_LEVEL') ?? 'warn';
  }

  get connected(): boolean {
    return this.connectionState === 'open';
  }

  get awaitingQrScan(): boolean {
    return this.qrPending;
  }

  /**
   * Public connection state for the automation status endpoint.
   * QR_READY takes precedence over CONNECTING: when a QR is pending the
   * operator's next action is scanning, not waiting.
   */
  getConnectionState(): WhatsappConnectionState {
    if (this.connectionState === 'open') return 'CONNECTED';
    if (this.qrPending) return 'QR_READY';
    if (this.connectionState === 'connecting') return 'CONNECTING';
    return 'DISCONNECTED';
  }

  /**
   * PNG data-URI of the latest pairing QR (for GET /api/whatsapp/qr).
   * Null when no QR is pending (already paired, or socket still connecting).
   * The URI is cached per QR string; a fresh QR invalidates the cache.
   */
  async getQrDataUri(): Promise<string | null> {
    if (!this.latestQr) return null;
    if (!this.latestQrDataUri) {
      this.latestQrDataUri = await QRCode.toDataURL(this.latestQr, { width: 320, margin: 2 });
    }
    return this.latestQrDataUri;
  }

  async onModuleInit(): Promise<void> {
    // Escape hatch for tests / admin-only deployments: skip the socket
    // entirely. Inbound handlers still work if driven manually.
    if ((this.config.get<string>('BAILEYS_DISABLE') ?? '').toLowerCase() === 'true') {
      this.logger.warn('BAILEYS_DISABLE=true — WhatsApp socket will not connect');
      return;
    }
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    // Close the WebSocket only — never logout(): logging out would destroy
    // the linked-device session and force a QR re-scan on next boot.
    try {
      this.sock?.ws.close();
    } catch {
      // shutdown path; nothing to do
    }
    this.sock = null;
  }

  /** Register an inbound-message handler; buffered messages flush first. */
  onInbound(handler: InboundHandler): void {
    this.inboundHandlers.push(handler);
    if (this.pendingInbound.length > 0) {
      const buffered = this.pendingInbound.splice(0, this.pendingInbound.length);
      for (const msg of buffered) void this.dispatchInbound(msg);
    }
  }

  onStatusUpdates(handler: StatusHandler): void {
    this.statusHandlers.push(handler);
  }

  // ------------------------------------------------------------ connection

  private async connect(): Promise<void> {
    if (this.connecting || this.destroyed) return;
    this.connecting = true;
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      // Build the socket version conditionally: fetch the latest published
      // version, and fall back to Baileys' bundled default when the lookup
      // fails (offline CI, DNS outage) rather than passing an invalid value.
      let version: [number, number, number] | undefined;
      try {
        ({ version } = await fetchLatestBaileysVersion());
      } catch {
        version = undefined;
      }
      const socketOptions: Parameters<typeof makeWASocket>[0] = {
        // Only pin an explicit version when the lookup succeeded; otherwise
        // omit it so Baileys falls back to its bundled default.
        ...(version ? { version } : {}),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        logger: pino({ level: this.logLevel as pino.Level }),
        // QR is printed via qrcode-terminal below (visible in Render logs).
        printQRInTerminal: false,
        browser: ['ZenSkil Hub', 'Chrome', '1.0'],
      };
      this.sock = makeWASocket(socketOptions);
      this.sock.ev.on('creds.update', saveCreds);
      this.sock.ev.on('connection.update', (u) => void this.onConnectionUpdate(u));
      this.sock.ev.on('messages.upsert', (u) => void this.onMessagesUpsert(u));
      this.sock.ev.on('messages.update', (u) => void this.onMessagesUpdate(u));
    } finally {
      this.connecting = false;
    }
  }

  private async onConnectionUpdate(update: {
    connection?: 'open' | 'close' | 'connecting';
    lastDisconnect?: { error?: Error };
    qr?: string;
  }): Promise<void> {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      this.qrPending = true;
      // Kept for the automation QR endpoint (data-URI) as well as the log.
      this.latestQr = qr;
      this.latestQrDataUri = null;
      this.logger.log('WhatsApp QR code received — scan it from WhatsApp → Linked devices:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      this.connectionState = 'open';
      this.qrPending = false;
      this.latestQr = null;
      this.latestQrDataUri = null;
      this.logger.log(`WhatsApp connected as ${this.sock?.user?.id ?? 'unknown device'}`);
    } else if (connection === 'connecting') {
      this.connectionState = 'connecting';
    } else if (connection === 'close') {
      this.connectionState = 'close';
      this.qrPending = false;
      this.latestQr = null;
      this.latestQrDataUri = null;
      if (this.destroyed) return;
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        // Session revoked on the phone: reconnecting is pointless. The
        // operator must wipe BAILEYS_AUTH_DIR and re-scan the QR.
        this.logger.error(
          'WhatsApp logged out (401) — session revoked. Delete the BAILEYS_AUTH_DIR contents and restart to pair again.',
        );
        this.sock = null;
        return;
      }
      // Automatic retry: connectionClosed, connectionLost, restartRequired,
      // and any other non-logout close. The multi-file auth session stays
      // valid, so a reconnect resumes without a new QR scan.
      this.logger.warn(`WhatsApp connection closed (code ${statusCode ?? 'unknown'}) — reconnecting…`);
      this.sock = null;
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
      await this.connect();
    }
  }

  // ------------------------------------------------------------ inbound

  private async onMessagesUpsert(upsert: { messages: WAMessage[]; type: string }): Promise<void> {
    // 'append' is history sync on reconnect — only 'notify' is new traffic.
    if (upsert.type !== 'notify') return;
    for (const wam of upsert.messages) {
      try {
        if (wam.key?.fromMe) continue; // never process our own sends
        const msg = normalizeBaileysMessage(wam);
        if (!msg) continue;
        this.cacheRaw(wam);
        await this.dispatchInbound(msg);
      } catch (err) {
        this.logger.error(`Inbound dispatch failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private async dispatchInbound(msg: InboundMessage): Promise<void> {
    if (this.inboundHandlers.length === 0) {
      // Boot race: socket opened before handlers registered. Buffer (bounded)
      // so no customer message is lost; onInbound() flushes in order.
      if (this.pendingInbound.length < MAX_PENDING_INBOUND) this.pendingInbound.push(msg);
      else this.logger.error('Inbound buffer full — dropping message (no handlers registered)');
      return;
    }
    for (const handler of this.inboundHandlers) {
      try {
        await handler(msg);
      } catch (err) {
        this.logger.error(`Inbound handler failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private async onMessagesUpdate(updates: Array<{ key: WAMessageKey; update: Partial<WAMessage> }>): Promise<void> {
    const mapped: StatusUpdate[] = [];
    for (const { key, update } of updates) {
      const status = mapBaileysStatus(update.status);
      if (!status || !key.id) continue;
      mapped.push({
        providerMessageId: key.id,
        recipient: normalizePhoneNumber((key.remoteJid ?? '').split('@')[0] ?? ''),
        status,
        timestamp: new Date(),
      });
    }
    if (mapped.length === 0) return;
    for (const handler of this.statusHandlers) {
      try {
        await handler(mapped);
      } catch (err) {
        this.logger.error(`Status handler failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private cacheRaw(wam: WAMessage): void {
    const id = wam.key?.id;
    if (!id) return;
    this.rawCache.set(id, wam);
    if (this.rawCache.size > MAX_RAW_CACHE) {
      const oldest = this.rawCache.keys().next().value;
      if (oldest) this.rawCache.delete(oldest);
    }
  }

  // ------------------------------------------------------------ outbound

  private requireSock(): WASocket {
    if (!this.sock) throw new BaileysError('WhatsApp socket not connected', { retryable: true });
    return this.sock;
  }

  private async sendAndGetId(jid: string, content: Parameters<WASocket['sendMessage']>[1]): Promise<string> {
    const sock = this.requireSock();
    let sent: proto.WebMessageInfo | undefined | null;
    try {
      sent = await sock.sendMessage(jid, content);
    } catch (err) {
      throw toBaileysError(err, 'WhatsApp send failed');
    }
    const id = sent?.key?.id;
    if (!id) throw new BaileysError('WhatsApp send returned no message id', { retryable: true });
    return id;
  }

  async sendText(msg: OutboundText): Promise<{ providerMessageId: string }> {
    const providerMessageId = await this.sendAndGetId(toWhatsappJid(msg.to), {
      text: msg.body.slice(0, 4096),
    });
    return { providerMessageId };
  }

  async sendTemplate(msg: OutboundTemplate): Promise<{ providerMessageId: string }> {
    // Baileys has no template registry: WhatsappService always renders the
    // full body locally (msg.renderedBody). The join fallback below is a
    // degraded last resort for direct client use — never the service path.
    const body = msg.renderedBody ?? msg.variables.join('\n');
    return this.sendText({ to: msg.to, body, kind: 'transactional' });
  }

  async sendInteractive(msg: OutboundInteractive): Promise<{ providerMessageId: string }> {
    // WhatsApp Web has no Cloud-style quick-reply buttons via this path:
    // render the options as a numbered list. Customers reply with the number
    // or the option text, which the conversation router handles as text.
    const options = msg.buttons
      .slice(0, 3)
      .map((b, i) => `${i + 1}. ${b.title}`)
      .join('\n');
    return this.sendText({
      to: msg.to,
      body: `${msg.body.slice(0, 1024)}\n\n${options}`,
      kind: msg.kind,
    });
  }

  async uploadMedia(data: Buffer, mimeType: string, filename = 'upload'): Promise<{ mediaId: string }> {
    // Baileys sends media inline — there is no pre-upload step. The buffer
    // is staged locally and consumed by sendMedia(mediaId).
    const mediaId = `baileys-upload-${randomUUID()}`;
    this.stagedUploads.set(mediaId, { data, mimeType, filename });
    if (this.stagedUploads.size > MAX_STAGED_UPLOADS) {
      const oldest = this.stagedUploads.keys().next().value;
      if (oldest) this.stagedUploads.delete(oldest);
    }
    return { mediaId };
  }

  async sendMedia(msg: OutboundMedia): Promise<{ providerMessageId: string }> {
    let media: { url: string } | Buffer;
    let mimeType = msg.mimeType ?? '';
    let filename = msg.filename ?? 'file';
    if (msg.mediaId) {
      const staged = this.stagedUploads.get(msg.mediaId);
      if (!staged) {
        throw new BaileysError(
          `Unknown mediaId ${msg.mediaId} — Baileys has no Meta media store; upload first or use mediaUrl`,
          { retryable: false },
        );
      }
      media = staged.data;
      mimeType = staged.mimeType;
      filename = msg.filename ?? staged.filename;
    } else if (msg.mediaUrl) {
      media = { url: msg.mediaUrl };
    } else {
      throw new BaileysError('sendMedia needs mediaId or mediaUrl', { retryable: false });
    }
    const caption = msg.caption?.slice(0, 1024);
    const content: Parameters<WASocket['sendMessage']>[1] = mimeType.startsWith('image/')
      ? { image: media, caption, mimetype: mimeType }
      : mimeType.startsWith('video/')
        ? { video: media, caption, mimetype: mimeType }
        : mimeType.startsWith('audio/')
          ? { audio: media, mimetype: mimeType }
          : { document: media, caption, mimetype: mimeType, fileName: filename.slice(0, 240) };
    const providerMessageId = await this.sendAndGetId(toWhatsappJid(msg.to), content);
    return { providerMessageId };
  }

  async markRead(providerMessageId: string): Promise<void> {
    // Best-effort: a failed read receipt must never break message processing.
    const sock = this.sock;
    const raw = this.rawCache.get(providerMessageId);
    if (!sock || !raw?.key) return;
    await sock.readMessages([raw.key]).catch(() => undefined);
  }

  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }> {
    // mediaId here is the WA message id (see normalizeBaileysMessage);
    // the raw message is resolved from the bounded in-memory cache.
    const raw = this.rawCache.get(mediaId);
    if (!raw?.message) {
      throw new BaileysError(`No cached message for media ${mediaId} (cache is in-memory and bounded)`, {
        retryable: false,
      });
    }
    let data: Buffer;
    try {
      data = await downloadMediaMessage(raw, 'buffer', {});
    } catch (err) {
      throw toBaileysError(err, 'Media download failed');
    }
    const { mediaMimeType } = extractBaileysContent(raw.message);
    return { data, mimeType: mediaMimeType ?? 'application/octet-stream' };
  }
}
