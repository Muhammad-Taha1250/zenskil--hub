import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Webhook HMAC verification with secret-rotation support (Phase 10, T1).
 *
 * Verifies a `sha256=<hex>` signature header against the raw request body,
 * trying each secret in `secrets` in order (primary first, then the previous
 * secret while a rotation is in flight). Returns false (fail closed) when:
 * no secrets are configured, the header is missing/malformed, or no secret
 * matches. Comparisons are constant-time per candidate.
 *
 * Rotation contract (documented in /tmp/rotation-note.md):
 *   1. generate the new secret at the provider,
 *   2. set it as the primary env var, move the old one to *_PREVIOUS,
 *   3. rolling-restart the API (env vars are read at boot),
 *   4. verify traffic is verifying against the primary,
 *   5. clear *_PREVIOUS and restart again.
 * During steps 2-4 webhooks signed with EITHER secret verify — zero
 * downtime, and a leak of the old secret alone no longer forges traffic
 * once *_PREVIOUS is cleared.
 */
export function verifyHmacSha256(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secrets: Array<string | undefined | null>,
): boolean {
  const configured = secrets.filter((s): s is string => !!s);
  if (configured.length === 0) return false;
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const actual = signatureHeader.slice('sha256='.length);
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return configured.some((secret) => {
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  });
}
