'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, errMsg } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { PageHead, Badge, Loading, useRole, canWrite } from '@/components/ui';

const KB_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];

/**
 * KB document edit + publish/draft.
 * Backend: GET/PATCH /api/v1/knowledge/documents/:id,
 *          POST /api/v1/knowledge/documents/:id/status { status } (OWNER only).
 */
export default function KnowledgeDetailPage({ params }: { params: { id: string } }) {
  const role = useRole();
  const canEdit = canWrite(role, ['OWNER', 'SUPPORT']);
  const canPublish = canWrite(role, ['OWNER']);
  const [doc, setDoc] = useState<any>(null);
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState('en');
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setError('');
    const r = await api<any>(`knowledge/documents/${params.id}`);
    if (r.ok) {
      setDoc(r.data);
      setTitle(r.data.title || '');
      setLanguage(r.data.language || 'en');
      setContent(r.data.content || '');
    } else setError(errMsg(r.data, 'Failed to load document'));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    setBusy(true);
    const r = await api(`knowledge/documents/${params.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, language, content }),
    });
    setBusy(false);
    if (!r.ok) setError(errMsg(r.data, 'Save failed'));
    else {
      setNotice('Saved — a new version was created.');
      await load();
    }
  }

  async function setStatus(status: string) {
    setBusy(true);
    const r = await api(`knowledge/documents/${params.id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
    setBusy(false);
    if (!r.ok) setError(errMsg(r.data, 'Status change failed'));
    else {
      setNotice(`Document → ${status}.`);
      await load();
    }
  }

  return (
    <>
      <PageHead
        title={doc ? doc.title : 'Document'}
        sub="Edit content (creates a new version) and control publish state."
        actions={<Link href="/knowledge" className="btn secondary">← Back</Link>}
      />
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}
      {!doc ? (
        <Loading />
      ) : (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0 }}>
                <span className="mono">{doc.slug}</span> · v{doc.version}
              </h2>
              <Badge value={doc.status} />
            </div>
            <p style={{ color: '#66727f', fontSize: 13 }}>
              Last updated {formatDateTime(doc.updatedAt)}
            </p>
            {canPublish ? (
              <div className="btn-row">
                {KB_STATUSES.filter((s) => s !== doc.status).map((s) => (
                  <button key={s} className="btn secondary small" disabled={busy} onClick={() => setStatus(s)}>
                    → {s}
                  </button>
                ))}
              </div>
            ) : (
              <div className="alert info">Publishing requires the OWNER role.</div>
            )}
          </div>

          <div className="card">
            <h2>Content</h2>
            {canEdit ? (
              <>
                <div className="form-row">
                  <div className="field">
                    <label>Title</label>
                    <input value={title} onChange={(e) => setTitle(e.target.value)} />
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
                  <label>Content</label>
                  <textarea value={content} onChange={(e) => setContent(e.target.value)} style={{ minHeight: 260 }} />
                </div>
                <div className="btn-row">
                  <button className="btn" disabled={busy} onClick={save}>
                    {busy ? 'Saving…' : 'Save (new version)'}
                  </button>
                </div>
              </>
            ) : (
              <pre className="dump" style={{ background: '#f6f8fa', color: '#1c2430' }}>{doc.content}</pre>
            )}
          </div>
        </>
      )}
    </>
  );
}
