// PII redaction for AI audit logs (Phase 6).
//
// The AI's tool-call arguments and results are audited for accountability,
// but they can carry customer PII: create_support_ticket takes free-text
// descriptions, get_customer returns name + WhatsApp number, and a model
// reply may echo back whatever the customer typed. Before anything hits the
// audit log, this module masks:
//   - long digit runs (>= 10 digits, tolerating spaces/dashes) — Pakistani
//     mobile numbers (11), CNIC (13), card numbers (16)
//   - values of sensitive keys (password, cnic, otp, card, pin, token, ...)
// Prices (paisa amounts, <= 9 digits) and order numbers (ZSH-...) are left
// intact so price-from-DB auditing stays readable.

// Digit runs of >= 10 (phone/CNIC/card), separators allowed between digits
// but never trailing. Order numbers are matched first and left intact so
// price/order auditing stays readable.
const DIGIT_RUN = /(ZSH-\d{8}-\d{4,})|(\d(?:[\s-]?\d){9,})/g;

const SENSITIVE_KEY =
  /("(?:password|passwd|cnic|otp|pin|card(?:number)?|cvv|token|secret|api[_-]?key)"\s*:\s*")([^"]*)(")/gi;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function redactPII(text: string): string {
  if (!text) return text;
  return text
    .replace(SENSITIVE_KEY, '$1[redacted]$3')
    .replace(DIGIT_RUN, (m, order) => {
      if (order) return order; // order number — keep readable for auditing
      const digits = m.replace(/[\s-]/g, '');
      // Keep short numeric runs (prices, quantities, years) readable.
      if (digits.length < 10) return m;
      return '[redacted-digits]';
    })
    .replace(EMAIL, '[redacted-email]');
}

/** Redact every string value inside a JSON-ish structure, best-effort. */
export function redactPIIJson(value: unknown): unknown {
  if (typeof value === 'string') return redactPII(value);
  if (Array.isArray(value)) return value.map(redactPIIJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /password|passwd|cnic|otp|pin|card|cvv|token|secret/i.test(k) && typeof v === 'string'
        ? '[redacted]'
        : redactPIIJson(v);
    }
    return out;
  }
  return value;
}
