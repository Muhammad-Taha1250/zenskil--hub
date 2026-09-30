import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

// Private local proof storage (v1). Payment screenshots are downloaded from
// Meta's CDN at receipt time and stored here — never hot-linked afterwards,
// because Meta media URLs are short-lived and token-authenticated.
// The storage key (e.g. "proofs/<paymentId>/<sha256>.jpg") is what lands in
// Payment.proofUrl. Files are written 0600 inside PROOF_STORAGE_DIR
// (default ./storage/proofs). A future S3-compatible implementation can
// replace this class behind the same interface; the key format is
// provider-agnostic.
export interface StoredProof {
  storageKey: string;
  sha256: string;
  bytes: number;
  mimeType: string;
}

const ALLOWED_MIME = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['application/pdf', 'pdf'],
]);

@Injectable()
export class ProofStorageService {
  private readonly dir: string;

  constructor(private readonly config: ConfigService) {
    this.dir =
      this.config.get<string>('PROOF_STORAGE_DIR') ||
      resolve(process.cwd(), 'storage', 'proofs');
  }

  /** Stores proof bytes privately; returns the storage key + integrity hash. */
  async store(paymentId: string, data: Buffer, mimeType: string): Promise<StoredProof> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(paymentId)) {
      throw new Error('Invalid payment id');
    }
    const ext = ALLOWED_MIME.get(mimeType);
    if (!ext) throw new Error(`Unsupported proof MIME type: ${mimeType}`);
    if (data.length > 10 * 1024 * 1024) throw new Error('Proof file too large (max 10 MB)');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const key = `proofs/${paymentId}/${sha256}.${ext}`;
    const abs = this.absolute(key);
    await mkdir(join(this.dir, 'proofs', paymentId), { recursive: true, mode: 0o700 });
    await writeFile(abs, data, { mode: 0o600 });
    return { storageKey: key, sha256, bytes: data.length, mimeType };
  }

  /** Reads proof bytes back for the admin download endpoint. */
  async read(storageKey: string): Promise<{ data: Buffer; mimeType: string }> {
    const abs = this.absolute(storageKey);
    try {
      await stat(abs);
    } catch {
      throw new NotFoundException('Proof file not found');
    }
    const ext = storageKey.split('.').pop() ?? 'bin';
    const mimeType =
      [...ALLOWED_MIME.entries()].find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
    return { data: await readFile(abs), mimeType };
  }

  /** Resolves a storage key to an absolute path, rejecting traversal. */
  private absolute(storageKey: string): string {
    if (!/^proofs\/[0-9a-f-]+\/[0-9a-f]{64}\.[a-z0-9]+$/.test(storageKey)) {
      throw new Error('Invalid proof storage key');
    }
    const abs = resolve(this.dir, storageKey);
    if (!abs.startsWith(this.dir + sep)) throw new Error('Path traversal rejected');
    return abs;
  }
}
