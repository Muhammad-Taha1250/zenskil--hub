import { compare as bcryptCompare } from 'bcryptjs';
import { hash as argon2Hash, verify as argon2Verify, argon2id } from 'argon2';

// Password hashing (Phase 10, threat model T6).
//
// New hashes are argon2id with:
//   timeCost 3, memoryCost 65536 (64 MiB), parallelism 4
// This exceeds OWASP's interactive-login recommendations (19 MiB minimum,
// time cost >= 2): login is a rare, latency-tolerant operation for admins,
// so we spend more memory to raise the cost of GPU/ASIC offline cracking.
// argon2id (not argon2i or argon2d) resists both side-channel and
// tradeoff attacks, per RFC 9106.
//
// Backward compatibility: hashes created before Phase 10 used bcrypt
// (cost 12) via bcryptjs. They are detected by the $2a$/$2b$/$2y$ prefix,
// verified with bcryptjs, and REHASHED to argon2id on the next successful
// login (see AuthService.login). bcryptjs stays a dependency for legacy
// verification only — nothing new is ever hashed with it.
export const ARGON2_OPTIONS = {
  type: argon2id,
  timeCost: 3,
  memoryCost: 65536,
  parallelism: 4,
} as const;

const BCRYPT_PREFIXES = ['$2a$', '$2b$', '$2y$'];

/** True when the stored hash is a legacy bcrypt hash (needs verify+rehash). */
export function isLegacyBcryptHash(storedHash: string): boolean {
  return BCRYPT_PREFIXES.some((p) => storedHash.startsWith(p));
}

/** Hash a fresh password with argon2id. */
export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored hash of either kind.
 * Returns { ok, needsRehash }: needsRehash is true for legacy bcrypt hashes
 * that verified successfully — the caller should persist a fresh argon2id
 * hash (transparent migration, no user action required).
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  if (isLegacyBcryptHash(storedHash)) {
    const ok = await bcryptCompare(password, storedHash);
    return { ok, needsRehash: ok };
  }
  try {
    const ok = await argon2Verify(storedHash, password);
    return { ok, needsRehash: false };
  } catch {
    // Malformed hash (corrupt row, unknown format): never grant access.
    return { ok: false, needsRehash: false };
  }
}
