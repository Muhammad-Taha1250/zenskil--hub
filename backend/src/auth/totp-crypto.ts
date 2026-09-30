import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM envelope for TOTP secrets at rest. Key comes from
// TOTP_ENCRYPTION_KEY (32 bytes, hex or base64). If unset, secrets are stored
// as plaintext and a loud warning is logged — acceptable for local dev only.

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

function loadKey(): Buffer | null {
  const raw = process.env.TOTP_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = raw.startsWith('hex:') ? Buffer.from(raw.slice(4), 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('TOTP_ENCRYPTION_KEY must decode to 32 bytes');
  return key;
}

let warned = false;

export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  if (!key) {
    if (!warned) {
      warned = true;
      // eslint-disable-next-line no-console
      console.warn('[auth] TOTP_ENCRYPTION_KEY not set — TOTP secrets stored unencrypted (dev only).');
    }
    return `plain:${plaintext}`;
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  if (stored.startsWith('plain:')) return stored.slice('plain:'.length);
  if (!stored.startsWith('enc:')) throw new Error('Unknown TOTP secret format');
  const key = loadKey();
  if (!key) throw new Error('TOTP_ENCRYPTION_KEY is required to decrypt stored secrets');
  const [ivB64, tagB64, encB64] = stored.split(':')[1].split('.');
  if (!ivB64 || !tagB64 || !encB64) throw new Error('Malformed TOTP secret payload');
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
