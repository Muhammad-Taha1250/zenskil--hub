import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProofStorageService } from './proof-storage.service';

function makeService(dir: string): ProofStorageService {
  const config = { get: (key: string) => (key === 'PROOF_STORAGE_DIR' ? dir : undefined) };
  // Direct construction: no Nest DI needed for these unit tests.
  return new ProofStorageService(config as never);
}

const PAYMENT_ID = randomUUID();
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe('ProofStorageService (private proof storage)', () => {
  let dir: string;
  let svc: ProofStorageService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'proofs-test-'));
    svc = makeService(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stores and reads back bytes with the canonical key format', async () => {
    const stored = await svc.store(PAYMENT_ID, JPEG, 'image/jpeg');
    expect(stored.storageKey).toMatch(new RegExp(`^proofs/${PAYMENT_ID}/[0-9a-f]{64}\\.jpg$`));
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
    const back = await svc.read(stored.storageKey);
    expect(Buffer.compare(back.data, JPEG)).toBe(0);
    expect(back.mimeType).toBe('image/jpeg');
  });

  it('rejects unsupported MIME types', async () => {
    await expect(svc.store(PAYMENT_ID, JPEG, 'text/html')).rejects.toThrow('Unsupported proof MIME type');
    await expect(svc.store(PAYMENT_ID, JPEG, 'application/x-sh')).rejects.toThrow('Unsupported proof MIME type');
  });

  it('rejects files over 10 MB', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 7);
    await expect(svc.store(PAYMENT_ID, big, 'image/jpeg')).rejects.toThrow('too large');
  });

  it('rejects non-UUID payment ids (path traversal)', async () => {
    await expect(svc.store('../../etc', JPEG, 'image/jpeg')).rejects.toThrow('Invalid payment id');
    await expect(svc.store('../x', JPEG, 'image/jpeg')).rejects.toThrow('Invalid payment id');
    await expect(svc.store('', JPEG, 'image/jpeg')).rejects.toThrow('Invalid payment id');
  });

  it('rejects malformed storage keys on read', async () => {
    await expect(svc.read('../../etc/passwd')).rejects.toThrow('Invalid proof storage key');
    await expect(svc.read(`proofs/${PAYMENT_ID}/nope.jpg`)).rejects.toThrow('Invalid proof storage key');
    await expect(svc.read('proofs/x/y')).rejects.toThrow('Invalid proof storage key');
  });

  it('throws NotFound for a well-formed but missing key', async () => {
    const missing = `proofs/${PAYMENT_ID}/${'0'.repeat(64)}.jpg`;
    await expect(svc.read(missing)).rejects.toThrow('Proof file not found');
  });

  it('writes proof files with 0600 permissions', async () => {
    const stored = await svc.store(PAYMENT_ID, JPEG, 'image/png');
    const st = await stat(join(dir, stored.storageKey));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('accepts all four supported MIME types', async () => {
    for (const [mime, ext] of [['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['application/pdf', 'pdf']] as const) {
      const stored = await svc.store(randomUUID(), JPEG, mime);
      expect(stored.storageKey.endsWith(`.${ext}`)).toBe(true);
    }
  });
});
