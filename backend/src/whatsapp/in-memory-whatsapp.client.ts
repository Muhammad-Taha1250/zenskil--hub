import {
  OutboundInteractive,
  OutboundMedia,
  OutboundTemplate,
  OutboundText,
  WhatsAppClient,
  normalizePhoneNumber,
} from './whatsapp-client.interface';
import { BaileysError } from './baileys.client';

// In-memory WhatsApp client for tests and the simulator. Records every send
// (normalized), returns deterministic provider ids, and can be scripted to
// fail specific sends to exercise retry/backoff paths. Never touches the
// network.
export interface RecordedSend {
  kind: 'text' | 'template' | 'interactive' | 'media';
  to: string;
  body?: string;
  templateName?: string;
  buttons?: Array<{ id: string; title: string }>;
  mediaId?: string;
  providerMessageId: string;
}

export class InMemoryWhatsAppClient implements WhatsAppClient {
  readonly clientName = 'in-memory';
  readonly sent: RecordedSend[] = [];
  readonly readReceipts: string[] = [];
  private counter = 0;
  /** When set, the next N sends throw a retryable error. */
  failNextSends = 0;
  /** When set, all sends throw this error instead. */
  permanentFailure: Error | null = null;

  private nextId(): string {
    this.counter += 1;
    return `wamid.FAKE${String(this.counter).padStart(6, '0')}`;
  }

  private maybeFail(): void {
    if (this.permanentFailure) throw this.permanentFailure;
    if (this.failNextSends > 0) {
      this.failNextSends -= 1;
      throw new BaileysError('simulated transient failure', { retryable: true });
    }
  }

  async sendText(msg: OutboundText): Promise<{ providerMessageId: string }> {
    this.maybeFail();
    const providerMessageId = this.nextId();
    this.sent.push({ kind: 'text', to: normalizePhoneNumber(msg.to), body: msg.body, providerMessageId });
    return { providerMessageId };
  }

  async sendTemplate(msg: OutboundTemplate): Promise<{ providerMessageId: string }> {
    this.maybeFail();
    const providerMessageId = this.nextId();
    this.sent.push({
      kind: 'template', to: normalizePhoneNumber(msg.to),
      templateName: msg.templateName, body: msg.renderedBody ?? msg.variables.join(' | '), providerMessageId,
    });
    return { providerMessageId };
  }

  async sendInteractive(msg: OutboundInteractive): Promise<{ providerMessageId: string }> {
    this.maybeFail();
    const providerMessageId = this.nextId();
    this.sent.push({
      kind: 'interactive', to: normalizePhoneNumber(msg.to), body: msg.body,
      buttons: msg.buttons.map((b) => ({ id: b.id, title: b.title })), providerMessageId,
    });
    return { providerMessageId };
  }

  async uploadMedia(_data: Buffer, _mimeType: string, _filename?: string): Promise<{ mediaId: string }> {
    this.maybeFail();
    return { mediaId: `media-FAKE${String(++this.counter).padStart(6, '0')}` };
  }

  async sendMedia(msg: OutboundMedia): Promise<{ providerMessageId: string }> {
    this.maybeFail();
    const providerMessageId = this.nextId();
    this.sent.push({
      kind: 'media', to: normalizePhoneNumber(msg.to), body: msg.caption,
      mediaId: msg.mediaId, providerMessageId,
    });
    return { providerMessageId };
  }

  async markRead(providerMessageId: string): Promise<void> {
    this.readReceipts.push(providerMessageId);
  }

  async downloadMedia(_mediaId: string): Promise<{ data: Buffer; mimeType: string }> {
    // 1x1 PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    return { data: png, mimeType: 'image/png' };
  }

  textsTo(to: string): RecordedSend[] {
    return this.sent.filter((s) => s.to === normalizePhoneNumber(to));
  }

  reset(): void {
    this.sent.length = 0;
    this.readReceipts.length = 0;
    this.failNextSends = 0;
    this.permanentFailure = null;
  }
}
