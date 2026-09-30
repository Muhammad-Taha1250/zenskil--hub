// Redacts anything that looks like a secret before it is logged, returned in
// an error payload, or otherwise leaves the process boundary.

const SENSITIVE_KEY = /(secret|token|password|passwd|pwd|api[_-]?key|auth|credential|card|cvv|pin|otp|private[_-]?key|session|phone|whatsapp|msisdn|mobile)/i;

export function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = sanitizeMeta(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      out[key] = value.map((v) =>
        v && typeof v === 'object' ? sanitizeMeta(v as Record<string, unknown>) : v,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function sanitizeHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    if (/authorization|cookie|x-hub-signature/i.test(key)) out[key] = '[REDACTED]';
  }
  return out;
}
