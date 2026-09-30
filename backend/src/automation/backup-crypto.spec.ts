// backup-crypto.spec.ts — T12 backup encryption. Pure crypto: no DB, no pg_dump.
// Test keypairs are generated ephemerally per test and never persisted.
import { Readable } from 'stream';
import {
  BACKUP_UNENCRYPTED_WARNING,
  decryptBackupBytes,
  encryptBackupBytes,
  encryptedBackupStream,
  parseAgeRecipients,
  validateAgeRecipients,
} from './backup-crypto';
import { generateIdentity, identityToRecipient } from 'age-encryption';

const PLAINTEXT = Buffer.from('CREATE TABLE secret (id serial primary key);\nINSERT INTO secret VALUES (1);\n');

async function genRecipient(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateIdentity();
  return { identity, recipient: await identityToRecipient(identity) };
}

describe('parseAgeRecipients', () => {
  it('returns [] for undefined/empty', () => {
    expect(parseAgeRecipients(undefined)).toEqual([]);
    expect(parseAgeRecipients('')).toEqual([]);
    expect(parseAgeRecipients('  ')).toEqual([]);
  });

  it('splits on commas and trims whitespace', () => {
    const r = 'age1abc, age1def ,age1ghi';
    expect(parseAgeRecipients(r)).toEqual(['age1abc', 'age1def', 'age1ghi']);
  });

  it('drops empty entries from trailing/double commas', () => {
    expect(parseAgeRecipients('age1abc,,')).toEqual(['age1abc']);
  });
});

describe('validateAgeRecipients', () => {
  it('accepts native, pq, and tag recipients', () => {
    expect(() => validateAgeRecipients(['age1abc', 'age1pq1xyz', 'age1tag1q'])).not.toThrow();
  });

  it('rejects garbage', () => {
    expect(() => validateAgeRecipients(['not-a-key'])).toThrow(/Invalid age recipient/);
    expect(() => validateAgeRecipients(['age2abc'])).toThrow(/Invalid age recipient/);
  });

  it('BACKUP_UNENCRYPTED_WARNING is the loud unset-recipients warning', () => {
    expect(BACKUP_UNENCRYPTED_WARNING).toContain('BACKUP_AGE_RECIPIENTS');
  });
});

describe('encryptBackupBytes / decryptBackupBytes', () => {
  it('roundtrips: decrypt(encrypt(x)) === x', async () => {
    const { identity, recipient } = await genRecipient();
    const ciphertext = await encryptBackupBytes(PLAINTEXT, [recipient]);
    expect(ciphertext.length).toBeGreaterThan(0);
    expect(Buffer.from(ciphertext).toString('ascii', 0, 20)).toContain('age-encryption.org');
    expect(await decryptBackupBytes(ciphertext, identity)).toEqual(PLAINTEXT);
  });

  it('encrypts to multiple recipients; every identity decrypts', async () => {
    const a = await genRecipient();
    const b = await genRecipient();
    const ciphertext = await encryptBackupBytes(PLAINTEXT, [a.recipient, b.recipient]);
    expect(await decryptBackupBytes(ciphertext, a.identity)).toEqual(PLAINTEXT);
    expect(await decryptBackupBytes(ciphertext, b.identity)).toEqual(PLAINTEXT);
  });

  it('wrong key fails: a different identity cannot decrypt', async () => {
    const a = await genRecipient();
    const b = await genRecipient();
    const ciphertext = await encryptBackupBytes(PLAINTEXT, [a.recipient]);
    await expect(decryptBackupBytes(ciphertext, b.identity)).rejects.toThrow();
  });

  it('handles empty input', async () => {
    const { identity, recipient } = await genRecipient();
    const ciphertext = await encryptBackupBytes(new Uint8Array(0), [recipient]);
    expect(await decryptBackupBytes(ciphertext, identity)).toEqual(Buffer.alloc(0));
  });

  it('throws on empty recipient list', async () => {
    await expect(encryptBackupBytes(PLAINTEXT, [])).rejects.toThrow(/at least one age recipient/);
  });

  it('throws on malformed recipient instead of writing an unrecoverable file', async () => {
    await expect(encryptBackupBytes(PLAINTEXT, ['bogus'])).rejects.toThrow(/Invalid age recipient/);
  });
});

describe('encryptedBackupStream (production pipeline shape)', () => {
  it('encrypts a Node stream end-to-end; decrypted output matches', async () => {
    const { identity, recipient } = await genRecipient();
    const input = Readable.from([PLAINTEXT.subarray(0, 20), PLAINTEXT.subarray(20)]);
    const encrypted = await encryptedBackupStream(input, [recipient]);
    const chunks: Buffer[] = [];
    for await (const chunk of encrypted) chunks.push(Buffer.from(chunk as Uint8Array));
    const ciphertext = Buffer.concat(chunks);
    expect(ciphertext.length).toBeGreaterThan(0);
    expect(await decryptBackupBytes(ciphertext, identity)).toEqual(PLAINTEXT);
  });
});
