import { hashSync } from 'bcryptjs';
import {
  ARGON2_OPTIONS,
  hashPassword,
  isLegacyBcryptHash,
  verifyPassword,
} from './password.util';

describe('password.util (Phase 10, T6)', () => {
  it('hashes new passwords with argon2id', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(ARGON2_OPTIONS.timeCost).toBe(3);
    expect(ARGON2_OPTIONS.memoryCost).toBe(65536);
    expect(ARGON2_OPTIONS.parallelism).toBe(4);
  });

  it('verifies an argon2id hash with the right password', async () => {
    const h = await hashPassword('s3cret!');
    const res = await verifyPassword('s3cret!', h);
    expect(res.ok).toBe(true);
    expect(res.needsRehash).toBe(false);
  });

  it('rejects the wrong password for an argon2id hash', async () => {
    const h = await hashPassword('s3cret!');
    const res = await verifyPassword('wrong', h);
    expect(res.ok).toBe(false);
    expect(res.needsRehash).toBe(false);
  });

  it('detects legacy bcrypt hashes by prefix', () => {
    expect(isLegacyBcryptHash('$2a$12$......................')).toBe(true);
    expect(isLegacyBcryptHash('$2b$12$......................')).toBe(true);
    expect(isLegacyBcryptHash('$2y$12$......................')).toBe(true);
    expect(isLegacyBcryptHash('$argon2id$v=19$m=65536,t=3,p=4$...')).toBe(false);
  });

  it('verifies a legacy bcrypt hash AND flags it for rehash', async () => {
    // Low cost for test speed; prefix detection is what matters.
    const legacy = hashSync('legacy-pw', 4);
    expect(legacy.startsWith('$2b$')).toBe(true);
    const res = await verifyPassword('legacy-pw', legacy);
    expect(res.ok).toBe(true);
    expect(res.needsRehash).toBe(true);
  });

  it('rejects a wrong password against a legacy bcrypt hash (no rehash)', async () => {
    const legacy = hashSync('legacy-pw', 4);
    const res = await verifyPassword('nope', legacy);
    expect(res.ok).toBe(false);
    expect(res.needsRehash).toBe(false);
  });

  it('fails closed on a malformed/corrupt stored hash', async () => {
    const res = await verifyPassword('anything', 'not-a-hash-at-all');
    expect(res.ok).toBe(false);
    expect(res.needsRehash).toBe(false);
  });
});
