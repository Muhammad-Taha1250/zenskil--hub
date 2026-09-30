// age encryption for nightly database backups (threat model T12).
//
// Backups are pg_dump → gzip → age (to every recipient in
// BACKUP_AGE_RECIPIENTS) → `<name>.sql.gz.age` on disk. The private identity
// never lives on the server; only recipient strings are configured.
//
// This module is pure stream/bytes crypto — no DB, no pg_dump — so the whole
// encrypt path is unit-testable without PostgreSQL (see backup-crypto.spec.ts).
import { Decrypter, Encrypter } from 'age-encryption';
import { Readable } from 'stream';

/** Loud warning logged + audited when BACKUP_AGE_RECIPIENTS is unset (never silently plaintext). */
export const BACKUP_UNENCRYPTED_WARNING = 'BACKUP UNENCRYPTED — set BACKUP_AGE_RECIPIENTS';

/** Split a comma-separated BACKUP_AGE_RECIPIENTS value into entries. Empty/unset → []. */
export function parseAgeRecipients(raw: string | undefined): string[] {
  if (raw === undefined || raw === null) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Reject malformed recipients loudly at backup time instead of producing an
 * unrecoverable file. Native X25519 recipients are `age1…`; post-quantum and
 * tag variants (`age1pq1…`, `age1tag1…`, `age1tagpq1…`) are accepted too.
 */
export function validateAgeRecipients(recipients: string[]): void {
  for (const r of recipients) {
    if (!/^age1(?:pq1|tag1|tagpq1)?[a-z0-9]+$/.test(r)) {
      throw new Error(`Invalid age recipient "${r}" — expected age1… / age1pq1… / age1tag1…`);
    }
  }
}

/** Encrypt raw bytes to every recipient. Throws on empty recipient list or malformed recipient. */
export async function encryptBackupBytes(plaintext: Uint8Array, recipients: string[]): Promise<Uint8Array> {
  if (recipients.length === 0) throw new Error('encryptBackupBytes requires at least one age recipient');
  validateAgeRecipients(recipients);
  const encrypter = new Encrypter();
  for (const r of recipients) encrypter.addRecipient(r);
  return encrypter.encrypt(plaintext);
}

/** Decrypt bytes with a single age identity (`AGE-SECRET-KEY-1…`). Throws if the identity can't unwrap. */
export async function decryptBackupBytes(ciphertext: Uint8Array, identity: string): Promise<Uint8Array> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  return decrypter.decrypt(ciphertext);
}

/**
 * Stream variant used by MaintenanceService: wraps a Node Readable (the gzip
 * output) and returns a Node Readable of the age ciphertext, which pipelines
 * straight into the backup file — the plaintext never touches disk.
 */
export async function encryptedBackupStream(input: Readable, recipients: string[]): Promise<Readable> {
  if (recipients.length === 0) throw new Error('encryptedBackupStream requires at least one age recipient');
  validateAgeRecipients(recipients);
  const encrypter = new Encrypter();
  for (const r of recipients) encrypter.addRecipient(r);
  const encrypted = await encrypter.encrypt(Readable.toWeb(input) as ReadableStream<Uint8Array>);
  return Readable.fromWeb(encrypted as unknown as import('stream/web').ReadableStream);
}
