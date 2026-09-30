import {
  NullEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
} from './embeddings';

const vec = (n: number, dims = 4) => Array.from({ length: dims }, (_, i) => (n + i) / 10);

const okFetch = (dims = 4) =>
  (async () =>
    ({
      ok: true,
      json: async () => ({ data: [{ embedding: vec(1, dims), index: 0 }, { embedding: vec(2, dims), index: 1 }] }),
    }) as Response) as typeof fetch;

describe('embeddings', () => {
  it('null provider returns null (keyword fallback path)', async () => {
    expect(await new NullEmbeddingProvider().embed('hello')).toBeNull();
  });

  it('posts OpenAI-compatible payload and maps vectors back in order', async () => {
    const calls: Array<{ url: string; body: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: init.body as string,
        auth: (init.headers as Record<string, string>).Authorization ?? null,
      });
      return { ok: true, json: async () => ({ data: [{ embedding: vec(1), index: 0 }] }) };
    }) as unknown as typeof fetch;
    const p = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://emb.example.com/v1/',
      apiKey: 'k',
      model: 'm',
      expectedDims: 4,
      fetchImpl,
    });
    const out = await p.embedBatch(['hello world', '   ']);
    expect(out[0]).toEqual(vec(1));
    expect(out[1]).toBeNull(); // blank input skipped
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://emb.example.com/v1/embeddings');
    expect(calls[0].auth).toBe('Bearer k');
    expect(JSON.parse(calls[0].body)).toEqual({ input: ['hello world'], model: 'm' });
  });

  it('rejects dimension mismatch loudly (schema is vector(1536))', async () => {
    const p = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
      expectedDims: 1536,
      fetchImpl: okFetch(4),
    });
    await expect(p.embed('hi')).rejects.toThrow('dimension mismatch');
  });

  it('throws on HTTP error so callers fall back to keyword search', async () => {
    const p = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
      fetchImpl: (async () => ({ ok: false, status: 429 }) as Response) as typeof fetch,
    });
    await expect(p.embed('hi')).rejects.toThrow('embeddings HTTP 429');
  });

  it('empty input batch returns nulls without calling the API', async () => {
    let called = 0;
    const p = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
      fetchImpl: (async () => {
        called++;
        return { ok: true, json: async () => ({ data: [] }) };
      }) as unknown as typeof fetch,
    });
    expect(await p.embedBatch(['  ', ''])).toEqual([null, null]);
    expect(called).toBe(0);
  });
});
