import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KbStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { StateTransitionActor } from '../customers/customers.service';
import {
  EmbeddingProvider,
  NullEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
} from './embeddings';

export interface KbSearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  documentSlug: string;
  language: string;
  content: string;
  score: number;
}

export const KB_CHUNK_TARGET = 600;

/** Deterministic paragraph-based chunking (pure — unit-tested). */
export function splitIntoChunks(content: string): string[] {
  const paragraphs = content.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    if ((current + '\n\n' + p).length > KB_CHUNK_TARGET && current) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  if (chunks.length === 0) chunks.push(content.slice(0, KB_CHUNK_TARGET));
  return chunks;
}

// Stop words stripped from keyword queries (en + roman urdu + urdu) so that
// natural questions like "What is your refund policy?" match on content words
// only. Without this, rare-but-irrelevant matches on "what/is/you" would
// either drown real hits (AND semantics) or return junk (OR semantics).
const SEARCH_STOP_WORDS = new Set([
  'what', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'and', 'or', 'do', 'does',
  'did', 'you', 'your', 'yours', 'me', 'my', 'mine', 'we', 'our', 'how', 'can',
  'could', 'would', 'should', 'will', 'tell', 'give', 'know', 'about', 'for',
  'with', 'have', 'has', 'had', 'this', 'that', 'these', 'those', 'it', 'its',
  'in', 'on', 'at', 'to', 'of', 'from', 'by', 'as', 'be', 'been', 'i',
  'kya', 'hai', 'hain', 'ho', 'ka', 'ki', 'ke', 'ko', 'se', 'me', 'mein',
  'main', 'aap', 'ap', 'apka', 'apki', 'mera', 'meri', 'mere', 'tum', 'tumhara',
  'kaise', 'kahan', 'kab', 'kitna', 'kitne', 'kitni', 'aur', 'ya', 'bhi', 'ne',
  'per', 'par', 'liye', 'wala', 'wali', 'wale', 'tha', 'thi', 'the',
  'kar', 'karo', 'karein', 'karta', 'hota', 'hoti', 'hote', 'chahiye',
  'کیا', 'ہے', 'ہیں', 'کا', 'کی', 'کے', 'کو', 'سے', 'میں', 'نے', 'آپ', 'میرا',
  'میری', 'میرے', 'اور', 'یا', 'بھی', 'کب', 'کہاں', 'کیسے', 'کتنا', 'کتنے',
  'تھا', 'تھی', 'تھے', 'ہو', 'ہوں', 'کر', 'کریں', 'لیے', 'والا', 'والی',
]);

/** Extract content-word search terms: lowercase, unicode word tokens,
 *  drop short tokens and stop words. Empty result => nothing searchable. */
export function extractSearchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const tok of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (tok.length < 3) continue;
    if (SEARCH_STOP_WORDS.has(tok)) continue;
    if (!terms.includes(tok)) terms.push(tok);
  }
  return terms;
}

// Knowledge base (spec §55): admin-managed documents, PUBLISHED docs only are
// served to the AI. Chunking is deterministic; embeddings optional.
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);
  private readonly embeddings: EmbeddingProvider;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {
    // Embeddings are dormant until the owner sets AI_EMBEDDING_API_KEY
    // (HUMAN ACTION REQUIRED: choose provider, supply key). Without a key the
    // NullEmbeddingProvider keeps search on the deterministic keyword path.
    const apiKey = this.config.get<string>('AI_EMBEDDING_API_KEY');
    this.embeddings = apiKey
      ? new OpenAICompatibleEmbeddingProvider({
          baseUrl: this.config.get<string>('AI_EMBEDDING_BASE_URL') ?? 'https://api.openai.com/v1',
          apiKey,
          model: this.config.get<string>('AI_EMBEDDING_MODEL') ?? 'text-embedding-3-small',
          expectedDims: 1536, // must match vector(1536) in the schema
        })
      : new NullEmbeddingProvider();
    if (apiKey) this.logger.log('Embeddings enabled (OpenAI-compatible provider)');
  }

  get embeddingsEnabled(): boolean {
    return !(this.embeddings instanceof NullEmbeddingProvider);
  }

  async searchKb(query: string, opts?: { topK?: number; language?: string }): Promise<KbSearchHit[]> {
    const topK = Math.min(10, Math.max(1, opts?.topK ?? 5));
    const q = query.trim().slice(0, 500);
    if (!q) return [];

    const languageFilter = opts?.language ? Prisma.sql`AND d.language = ${opts.language}` : Prisma.sql``;

    // Vector recall when embeddings are available.
    const vector = await this.embeddings.embed(q).catch(() => null);
    if (vector && vector.length > 0) {
      const vecLiteral = `[${vector.join(',')}]`;
      const rows = await this.prisma.$queryRaw<Array<{
        chunk_id: string; document_id: string; document_title: string;
        document_slug: string; language: string; content: string; score: number;
      }>>`
        SELECT c.id AS chunk_id, d.id AS document_id, d.title AS document_title,
               d.slug AS document_slug, d.language, c.content,
               (1 - (c.embedding <=> ${vecLiteral}::vector)) AS score
        FROM knowledge_base_chunks c
        JOIN knowledge_base_documents d ON d.id = c.document_id
        WHERE d.status = 'PUBLISHED' AND c.embedding IS NOT NULL ${languageFilter}
        ORDER BY c.embedding <=> ${vecLiteral}::vector
        LIMIT ${topK}`;
      return rows.map((r) => ({
        chunkId: r.chunk_id, documentId: r.document_id, documentTitle: r.document_title,
        documentSlug: r.document_slug, language: r.language, content: r.content, score: Number(r.score),
      }));
    }

    // Deterministic keyword fallback: full-text rank over PUBLISHED docs.
    // Content-word OR matching — a natural question matches on its content
    // words; queries with no content words (or no hits) return [] and the
    // caller escalates to a human instead of guessing.
    const terms = extractSearchTerms(q);
    if (terms.length === 0) return [];
    const tsq = terms.join(' | ');
    const rows = await this.prisma.$queryRaw<Array<{
      chunk_id: string; document_id: string; document_title: string;
      document_slug: string; language: string; content: string; score: number;
    }>>`
      SELECT c.id AS chunk_id, d.id AS document_id, d.title AS document_title,
             d.slug AS document_slug, d.language, c.content,
             ts_rank(to_tsvector('simple', c.content), to_tsquery('simple', ${tsq})) AS score
      FROM knowledge_base_chunks c
      JOIN knowledge_base_documents d ON d.id = c.document_id
      WHERE d.status = 'PUBLISHED'
        AND to_tsvector('simple', c.content) @@ to_tsquery('simple', ${tsq})
        ${languageFilter}
      ORDER BY score DESC
      LIMIT ${topK}`;
    return rows.map((r) => ({
      chunkId: r.chunk_id, documentId: r.document_id, documentTitle: r.document_title,
      documentSlug: r.document_slug, language: r.language, content: r.content, score: Number(r.score),
    }));
  }

  async listDocuments(status?: KbStatus) {
    return this.prisma.knowledgeBaseDocument.findMany({
      where: status ? { status } : undefined,
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { chunks: true } } },
    });
  }

  async getDocument(id: string) {
    const doc = await this.prisma.knowledgeBaseDocument.findUnique({
      where: { id },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
    if (!doc) throw new BadRequestException('Document not found');
    return doc;
  }

  async createDocument(
    data: { slug: string; title: string; language?: string; content: string },
    actor: StateTransitionActor,
  ) {
    if (!data.slug?.trim() || !data.title?.trim() || !data.content?.trim()) {
      throw new BadRequestException('slug, title and content are required');
    }
    const doc = await this.prisma.$transaction(async (tx) => {
      const created = await tx.knowledgeBaseDocument.create({
        data: {
          slug: data.slug.trim(),
          title: data.title.trim(),
          language: data.language ?? 'en',
          content: data.content,
          status: 'DRAFT',
          updatedBy: actor.type === 'ADMIN' ? actor.id : null,
        },
      });
      await this.chunkDocumentTx(tx, created.id, data.content);
      return created;
    });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'kb.document_created', entityType: 'knowledge_base_document', entityId: doc.id,
      after: { slug: doc.slug, title: doc.title },
      ipAddress: actor.ip ?? null,
    });
    // Best-effort vector indexing after commit (no-op without an embedding key).
    await this.embedDocumentChunks(doc.id).catch((err) =>
      this.logger.warn(`write-time embedding failed for ${doc.id}: ${err instanceof Error ? err.message : err}`),
    );
    return doc;
  }

  async updateDocument(
    id: string,
    data: { title?: string; language?: string; content?: string },
    actor: StateTransitionActor,
  ) {
    const doc = await this.prisma.knowledgeBaseDocument.findUniqueOrThrow({ where: { id } });
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.knowledgeBaseDocument.update({
        where: { id },
        data: {
          title: data.title ?? doc.title,
          language: data.language ?? doc.language,
          content: data.content ?? doc.content,
          version: { increment: 1 },
          updatedBy: actor.type === 'ADMIN' ? actor.id : null,
        },
      });
      if (data.content !== undefined) {
        await tx.knowledgeBaseChunk.deleteMany({ where: { documentId: id } });
        await this.chunkDocumentTx(tx, id, data.content);
      }
      return next;
    });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'kb.document_updated', entityType: 'knowledge_base_document', entityId: id,
      after: { version: updated.version },
      ipAddress: actor.ip ?? null,
    });
    await this.embedDocumentChunks(id).catch((err) =>
      this.logger.warn(`write-time embedding failed for ${id}: ${err instanceof Error ? err.message : err}`),
    );
    return updated;
  }

  async setStatus(id: string, status: KbStatus, actor: StateTransitionActor) {
    const doc = await this.prisma.knowledgeBaseDocument.findUniqueOrThrow({ where: { id } });
    const updated = await this.prisma.knowledgeBaseDocument.update({ where: { id }, data: { status } });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'kb.status_changed', entityType: 'knowledge_base_document', entityId: id,
      before: { status: doc.status }, after: { status },
      ipAddress: actor.ip ?? null,
    });
    return updated;
  }

  private async chunkDocumentTx(tx: Prisma.TransactionClient, documentId: string, content: string): Promise<void> {
    const chunks = splitIntoChunks(content);
    await tx.knowledgeBaseChunk.createMany({
      data: chunks.map((c, i) => ({ documentId, chunkIndex: i, content: c })),
    });
  }

  // Embed all not-yet-embedded chunks of a document (write-time). Runs AFTER
  // the document transaction commits — embeddings are a network call and must
  // not hold the DB transaction open. Failures are logged and left NULL so a
  // later reindexEmbeddings() run (or the next edit) picks them up; search
  // keeps working on the keyword path meanwhile.
  async embedDocumentChunks(documentId: string): Promise<{ embedded: number; failed: number }> {
    if (!this.embeddingsEnabled) return { embedded: 0, failed: 0 };
    return this.reindexEmbeddings(500, documentId);
  }

  // Backfill embeddings for chunks that lack them (admin/n8n-triggered after
  // the owner configures AI_EMBEDDING_API_KEY, or to heal past failures).
  async reindexEmbeddings(limit = 200, documentId?: string): Promise<{ processed: number; embedded: number; failed: number }> {
    const out = { processed: 0, embedded: 0, failed: 0 };
    if (!this.embeddingsEnabled) return out;
    const chunks = await this.prisma.$queryRaw<Array<{ id: string; content: string }>>`
      SELECT id, content FROM knowledge_base_chunks
      WHERE embedding IS NULL
        ${documentId ? Prisma.sql`AND document_id = ${documentId}::uuid` : Prisma.sql``}
      ORDER BY chunk_index ASC
      LIMIT ${Math.min(500, Math.max(1, limit))}
    `;
    out.processed = chunks.length;
    if (chunks.length === 0) return out;
    const provider = this.embeddings as OpenAICompatibleEmbeddingProvider;
    let vectors: Array<number[] | null>;
    try {
      vectors = await provider.embedBatch(chunks.map((c) => c.content));
    } catch (err) {
      this.logger.error(`reindex batch failed: ${err instanceof Error ? err.message : err}`);
      out.failed = chunks.length;
      return out;
    }
    for (let i = 0; i < chunks.length; i++) {
      const vec = vectors[i];
      if (!vec) { out.failed += 1; continue; }
      try {
        await this.prisma.$executeRaw`
          UPDATE knowledge_base_chunks SET embedding = ${`[${vec.join(',')}]`}::vector
          WHERE id = ${chunks[i].id}::uuid`;
        out.embedded += 1;
      } catch (err) {
        this.logger.error(`reindex chunk ${chunks[i].id} failed: ${err instanceof Error ? err.message : err}`);
        out.failed += 1;
      }
    }
    await this.audit.log({
      actorType: 'SYSTEM', actorId: null,
      action: 'kb.embeddings_reindexed',
      entityType: 'knowledge_base_document', entityId: documentId ?? null,
      after: out, ipAddress: null,
    });
    return out;
  }
}