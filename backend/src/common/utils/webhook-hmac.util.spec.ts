import { createHmac } from 'crypto';
import { verifyHmacSha256 } from './webhook-hmac.util';

const sig = (body: Buffer, secret: string) =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

describe('verifyHmacSha256 (Phase 10, T1)', () => {
  const body = Buffer.from('{"hello":"world"}');

  it('verifies against the primary secret', () => {
    expect(verifyHmacSha256(body, sig(body, 'primary'), ['primary', 'previous'])).toBe(true);
  });

  it('verifies against the previous secret during rotation', () => {
    expect(verifyHmacSha256(body, sig(body, 'previous'), ['primary', 'previous'])).toBe(true);
  });

  it('rejects a signature made with an unknown secret', () => {
    expect(verifyHmacSha256(body, sig(body, 'attacker'), ['primary', 'previous'])).toBe(false);
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from('{"hello":"mallory"}');
    expect(verifyHmacSha256(tampered, sig(body, 'primary'), ['primary'])).toBe(false);
  });

  it('fails closed with no configured secrets', () => {
    expect(verifyHmacSha256(body, sig(body, 'primary'), [])).toBe(false);
    expect(verifyHmacSha256(body, sig(body, 'primary'), [undefined, null])).toBe(false);
  });

  it('fails closed on missing or malformed signature headers', () => {
    expect(verifyHmacSha256(body, undefined, ['primary'])).toBe(false);
    expect(verifyHmacSha256(body, 'not-a-signature', ['primary'])).toBe(false);
    expect(verifyHmacSha256(body, 'sha256=short', ['primary'])).toBe(false);
  });

  it('skips empty previous-secret entries (no rotation in flight)', () => {
    expect(verifyHmacSha256(body, sig(body, 'primary'), ['primary', ''])).toBe(true);
    expect(verifyHmacSha256(body, sig(body, 'other'), ['primary', ''])).toBe(false);
  });
});
