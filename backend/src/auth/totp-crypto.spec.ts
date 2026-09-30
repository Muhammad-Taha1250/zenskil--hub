import { decryptSecret, encryptSecret } from '../auth/totp-crypto';

// 32-byte test key (base64). loadKey() reads process.env at call time.
process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

describe('TOTP secret crypto (AES-256-GCM)', () => {
  it('round-trips a secret through encrypt/decrypt', () => {
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const stored = encryptSecret(secret);
    expect(stored.startsWith('enc:')).toBe(true);
    expect(stored).not.toContain(secret);
    const parts = stored.slice(4).split('.');
    expect(parts).toHaveLength(3); // iv.tag.ciphertext
    expect(decryptSecret(stored)).toBe(secret);
  });

  it('produces unique ciphertexts for the same secret (random IV)', () => {
    expect(encryptSecret('abc')).not.toBe(encryptSecret('abc'));
  });

  it('rejects tampered ciphertext', () => {
    const stored = encryptSecret('s3cr3t');
    const [iv, tag, enc] = stored.slice(4).split('.');
    const tampered = `enc:${iv}.${tag}.${enc.slice(0, -2)}ff`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('rejects tampered auth tag', () => {
    const stored = encryptSecret('s3cr3t');
    const [iv, , enc] = stored.slice(4).split('.');
    const tampered = `enc:${iv}.deadbeef.${enc}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('rejects malformed payloads (regression: no dropped parts)', () => {
    expect(() => decryptSecret('enc:abc.def')).toThrow(); // missing part
    expect(() => decryptSecret('enc:')).toThrow();
    expect(() => decryptSecret('nope')).toThrow(); // unknown prefix
    expect(() => decryptSecret('')).toThrow();
  });

  it('requires the key to decrypt encrypted secrets', () => {
    const stored = encryptSecret('s3cr3t');
    const saved = process.env.TOTP_ENCRYPTION_KEY;
    delete process.env.TOTP_ENCRYPTION_KEY;
    try {
      expect(() => decryptSecret(stored)).toThrow(/TOTP_ENCRYPTION_KEY/);
    } finally {
      process.env.TOTP_ENCRYPTION_KEY = saved;
    }
  });

  it('falls back to plain: prefix when no key is set (dev only)', () => {
    const saved = process.env.TOTP_ENCRYPTION_KEY;
    delete process.env.TOTP_ENCRYPTION_KEY;
    try {
      expect(encryptSecret('devsecret')).toBe('plain:devsecret');
      expect(decryptSecret('plain:devsecret')).toBe('devsecret');
    } finally {
      process.env.TOTP_ENCRYPTION_KEY = saved;
    }
  });

  it('decrypts repeatedly without the old IV-drop bug', () => {
    for (let i = 0; i < 5; i++) {
      const secret = `secret-${i}-${Date.now()}`;
      expect(decryptSecret(encryptSecret(secret))).toBe(secret);
    }
  });
});
