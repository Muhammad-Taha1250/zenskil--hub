import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Minimal RFC 6238 TOTP (SHA-1, 30s step, 6 digits) — no external dependency.
// Secrets are base32; otpauth:// URLs work with Google Authenticator etc.

const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW_STEPS = 1; // accept ±1 step for clock skew

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(bytes = 20): string {
  const buf = randomBytes(bytes);
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32.indexOf(char);
    if (idx === -1) throw new Error('Invalid base32 TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: bigint): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function totpCode(secret: string, at: Date = new Date()): string {
  const key = base32Decode(secret);
  const counter = BigInt(Math.floor(at.getTime() / 1000 / STEP_SECONDS));
  return hotp(key, counter);
}

export function verifyTotp(secret: string, code: string, at: Date = new Date()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const key = base32Decode(secret);
  const now = BigInt(Math.floor(at.getTime() / 1000 / STEP_SECONDS));
  for (let d = -WINDOW_STEPS; d <= WINDOW_STEPS; d++) {
    const expected = hotp(key, now + BigInt(d));
    if (
      expected.length === code.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(code))
    ) {
      return true;
    }
  }
  return false;
}

export function otpauthUrl(secret: string, account: string, issuer = 'ZenSkil Hub'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return (
    `otpauth://totp/${label}?secret=${secret}` +
    `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
  );
}
