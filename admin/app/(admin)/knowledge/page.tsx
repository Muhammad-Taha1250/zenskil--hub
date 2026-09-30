'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, errMsg } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { PageHead, Badge, Loading, Empty, useRole, canWrite } from '@/components/ui';

const KB_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];

/**
 * Knowledge base editor (versioned, publish/draft).
 * Backend: GET /api/v1/knowledge/documents?status=, GET /:id,
 *          POST /api/v1/knowledge/documents { slug, title, language?, content },
 *          PATCH /api/v1/knowledge/documents/:id { title?, language?, content? },
 *          POST /api/v1/knowledge/documents/:id/status { status }.
 * Create/update: OWNER/SUPPORT. Status changes: OWNER only.
 */
export default function KnowledgePage() {
  const role = useRole();
  const canEdit = canWrite(role, ['OWNER', 'SUPPORT']);
  const [docs, setDocs] = useState<any[]>([]);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState('en');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(s: string) {
    setLoading(true);
    setError('');
    const r = await api<any[]>(`knowledge/documents${s ? `?status=${s}` : ''}`);
    if (r.ok) setDocs(r.data || []);
    else setError(errMsg(r.data, 'Failed to load documents'));
    setLoading(false);
  }

  useEffect(() => {
    load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    if (!slug.trim() || !title.trim() || !content.trim()) {
      setError('Slug, title and content are required.');
      return;
    }
    setBusy(true);
    const r = await api('knowledge/documents', {
      method: 'POST',
      body: JSON.stringify({ slug: slug.trim(), title: title.trim(), language, content }),
    });
    setBusy(false);
    if (!r.ok) {
      setError(errMsg(r.data, 'Create failed'));
      return;
    }
    setShowNew(false);
    setSlug('');
    setTitle('');
    setContent('');
    setNotice('Document created as DRAFT.');
    await load(status);
  }

  const filtered = query.trim()
    ? docs.filter(
        (d) =>
          d.title?.toLowerCase().includes(query.toLowerCase()) ||
          d.slug?.toLowerCase().includes(query.toLowerCase()),
      )
    : docs;

  return (
    <>
      <PageHead
        title="Knowledge base"
        sub="Versioned articles the AI answers from. Only PUBLISHED documents are used for grounding."
        actions={canEdit && <button className="btn" onClick={() => setShowNew(!showNew)}>+ New document</button>}
      />
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      {showNew && canEdit && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>New document</h2>
          <div className="form-row">
            <div className="field">
              <label>Slug (unique)</label>
              <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="refund-policy" />
            </div>
            <div className="field">
              <label>Language</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="en">en</option>
                <option value="ur">ur</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label>Content</label>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} style={{ minHeight: 160 }} />
          </div>
          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create as DRAFT'}</button>
            <button className="btn secondary" onClick={() => setShowNew(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="toolbar">
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => { setStatus(e.target.value); load(e.target.value); }}>
              <option value="">Any</option>
              {KB_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Filter by title/slug</label>
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search…" />
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? <Loading /> : filtered.length === 0 ? <Empty text="No documents." /> : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Title</th><th>Slug</th><th>Lang</th><th>Status</th><th>Version</th><th>Updated</th></tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr key={d.id}>
                    <td><Link href={`/knowledge/${d.id}`}>{d.title}</Link></td>
                    <td className="mono">{d.slug}</td>
                    <td>{d.language}</td>
                    <td><Badge value={d.status} /></td>
                    <td>v{d.version}</td>
                    <td>{formatDateTime(d.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
