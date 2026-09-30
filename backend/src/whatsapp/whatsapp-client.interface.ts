// Provider-agnostic WhatsApp interface (spec §40/§41).
// Current provider: BaileysClient (WhatsApp Web socket). Swapping providers =
// implementing this interface.

export interface OutboundText {
  to: string; // E.164-ish digits, e.g. 923001234567
  body: string;
  replyToMessageId?: string;
  /**
   * When true, the message is informational/transactional and may only go
   * out if the customer is opted in OR inside the 24h service window.
   * Marketing content additionally requires an approved template.
   */
  kind: 'transactional' | 'template';
}

export interface OutboundTemplate {
  to: string;
  templateName: string;
  languageCode: string; // e.g. 'en', 'ur'
  variables: string[];
  /**
   * Fully rendered body, resolved by WhatsappService from the
   * message_templates table. The transport sends this verbatim — Baileys
   * has no server-side template registry, so the service must always fill
   * this in; it is never left for the provider to render.
   */
  renderedBody?: string;
}

export interface InteractiveButton {
  id: string; // opaque callback id, e.g. 'menu:plans' (max 256 chars)
  title: string; // shown on the button (max 20 chars)
}

export interface OutboundInteractive {
  to: string; // E.164-ish digits, e.g. 923001234567
  body: string;
  buttons: InteractiveButton[]; // 1..3
  replyToMessageId?: string;
  /**
   * Interactive replies count as free-form: allowed only inside the 24h
   * customer-service window (same policy as sendText).
   */
  kind: 'transactional' | 'template';
}

export interface OutboundMedia {
  to: string; // E.164-ish digits
  /** Previously uploaded media id (preferred), or a public mediaUrl. */
  mediaId?: string;
  mediaUrl?: string;
  mimeType?: string;
  caption?: string;
  filename?: string; // for documents
  kind: 'transactional' | 'template';
}

export interface InboundMessage {
  providerMessageId: string;
  from: string;
  timestamp: Date;
  type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'button_reply' | 'list_reply' | 'reaction' | 'unknown';
  text?: string;
  buttonId?: string;
  mediaId?: string;
  mediaMimeType?: string;
  caption?: string;
}

export interface WhatsAppClient {
  readonly clientName: string;
  sendText(msg: OutboundText): Promise<{ providerMessageId: string }>;
  sendTemplate(msg: OutboundTemplate): Promise<{ providerMessageId: string }>;
  sendInteractive(msg: OutboundInteractive): Promise<{ providerMessageId: string }>;
  /** Stages media for sendMedia (Baileys sends inline; no remote upload). */
  uploadMedia(data: Buffer, mimeType: string, filename?: string): Promise<{ mediaId: string }>;
  sendMedia(msg: OutboundMedia): Promise<{ providerMessageId: string }>;
  markRead(providerMessageId: string): Promise<void>;
  downloadMedia?(mediaId: string): Promise<{ data: Buffer; mimeType: string }>;
}

/**
 * Normalizes a destination number to the digit string providers expect
 * (full international format, no '+').
 * - strips all non-digits;
 * - a leading 0 (Pakistani local format, e.g. 03001234567) becomes 92...;
 * - anything else is passed through untouched (already international).
 */
export function normalizePhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length >= 10) return `92${digits.slice(1)}`;
  return digits;
}

/**
 * Formats a phone number as a WhatsApp JID for Baileys,
 * e.g. '923001234567' -> '923001234567@s.whatsapp.net'.
 */
export function toWhatsappJid(raw: string): string {
  return `${normalizePhoneNumber(raw)}@s.whatsapp.net`;
}
