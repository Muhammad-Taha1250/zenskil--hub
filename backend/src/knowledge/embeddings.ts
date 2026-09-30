import { Logger } from '@nestjs/common';

// Provider-agnostic embedding interface. Day one there is no embedding key,
// so search degrades gracefully to keyword (full-text) ranking. When the
// owner supplies an embedding provider, implement this interface and search
// gains vector recall; keyword ranking stays as the deterministic fallback.
export interface EmbeddingProvider {
  embed(text: string): Promise<number[] | null>;
}

export class NullEmbeddingProvider implements EmbeddingProvider {
  async embed(_text: string): Promise<null> {
    return null;
  }
}

// OpenAI-compatible embeddings adapter (Phase 6). Dormant unless the owner
// sets AI_EMBEDDING_API_KEY (HUMAN ACTION REQUIRED: choose provider, supply
// key). When active, chunk writes embed automatically and search gains vector
// recall; any failure degrades to the deterministic keyword fallback.
//
// The schema stores vector(1536): responses with other dimensions are
// rejected loudly (not silently truncated) so misconfiguration is visible.

export interface EmbeddingAdapterOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  expectedDims?: number;
  fetchImpl?: typeof fetch;
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  private readonly logger = new Logger(OpenAICompatibleEmbeddingProvider.name);
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: EmbeddingAdapterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(text: string): Promise<number[] | null> {
    const batch = await this.embedBatch([text]);
    return batch[0] ?? null;
  }

  async embedBatch(texts: string[]): Promise<Array<number[] | null>> {
    const clean = texts.map((t) => t.slice(0, 8000)).filter((t) => t.trim().length > 0);
    if (clean.length === 0) return texts.map(() => null);
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/embeddings`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({ input: clean, model: this.opts.model }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`embeddings HTTP ${res.status}`);
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const out: Array<number[] | null> = texts.map(() => null);
    let cursor = 0;
    for (const item of json.data ?? []) {
      const vec = item?.embedding;
      if (!Array.isArray(vec)) continue;
      if (this.opts.expectedDims && vec.length !== this.opts.expectedDims) {
        throw new Error(
          `embedding dimension mismatch: got ${vec.length}, expected ${this.opts.expectedDims}`,
        );
      }
      // Map back onto the original texts array (clean filtered empties).
      while (cursor < texts.length && texts[cursor].trim().length === 0) cursor++;
      if (cursor < texts.length) out[cursor] = vec;
      cursor++;
    }
    return out;
  }
}
