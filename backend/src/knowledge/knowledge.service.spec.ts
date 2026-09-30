import { KB_CHUNK_TARGET, splitIntoChunks } from '../knowledge/knowledge.service';

describe('KB chunking', () => {
  it('splits on paragraph boundaries at ~600 chars', () => {
    const para = 'x'.repeat(300);
    const content = [para, para, para, para].join('\n\n');
    const chunks = splitIntoChunks(content);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(KB_CHUNK_TARGET + 300); // paragraphs aren't mid-split
    }
    // deterministic: same input -> same output
    expect(splitIntoChunks(content)).toEqual(chunks);
  });

  it('keeps short content as a single chunk', () => {
    expect(splitIntoChunks('hello world')).toEqual(['hello world']);
  });

  it('trims and drops empty paragraphs', () => {
    const chunks = splitIntoChunks('  a  \n\n\n\n  b  ');
    expect(chunks).toEqual(['a\n\nb']);
  });

  it('never returns an empty array', () => {
    expect(splitIntoChunks('')).toHaveLength(1);
    expect(splitIntoChunks('   \n\n   ')).toHaveLength(1);
  });

  it('round-trips all paragraphs (no content lost)', () => {
    const paras = ['first paragraph here', 'second one', 'third paragraph here'];
    const chunks = splitIntoChunks(paras.join('\n\n'));
    const joined = chunks.join('\n\n');
    for (const p of paras) {
      expect(joined).toContain(p);
    }
  });
});
