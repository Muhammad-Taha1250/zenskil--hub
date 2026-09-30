'use client';

import { useEffect, useState } from 'react';
import { api, errMsg } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { PageHead, Loading, Empty, Pager } from '@/components/ui';

interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorType: string;
  actorId: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  createdAt: string;
}

/**
 * Audit log viewer — append-only record of every state-changing action.
 * Backend: GET /api/v1/audit-log?page=&pageSize=&action=&entityType=
 * &entityId=&actorType=&from=&to=
 */
export default function AuditPage() {
  const [items, setItems] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [f, setF] = useState({ action: '', entityType: '', entityId: '', actorType: '', from: '', to: '' });
  const [openId, setOpenId] = useState<string | null>(null);

  async function load(p: number) {
    setLoading(true);
    setError('');
    const q = new URLSearchParams({ page: String(p), pageSize: '25' });
    for (const [k, v] of Object.entries(f)) if (v.trim()) q.set(k, v.trim());
    const r = await api<{ total: number; page: number; pageSize: number; items: AuditRow[] }>(
      `audit-log?${q}`,
    );
    if (r.ok) {
      setItems(r.data.items || []);
      setTotal(r.data.total || 0);
      setPage(r.data.page || p);
    } else setError(errMsg(r.data, 'Failed to load audit log'));
    setLoading(false);
  }

  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function set<K extends keyof typeof f>(k: K, v: string) {
    setF((prev) => ({ ...prev, [k]: v }));
  }

  return (
    <>
      <PageHead
        title="Audit log"
        sub="Append-only record of every state-changing action. Rows can never be edited or deleted."
      />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="toolbar">
          <div className="field"><label>Action contains</label>
            <input value={f.action} onChange={(e) => set('action', e.target.value)} placeholder="order." />
          </div>
          <div className="field"><label>Entity type</label>
            <input value={f.entityType} onChange={(e) => set('entityType', e.target.value)} placeholder="order" />
          </div>
          <div className="field"><label>Entity ID</label>
            <input value={f.entityId} onChange={(e) => set('entityId', e.target.value)} placeholder="UUID" />
          </div>
          <div className="field"><label>Actor type</label>
            <select value={f.actorType} onChange={(e) => set('actorType', e.target.value)}>
              <option value="">Any</option>
              <option value="ADMIN">ADMIN</option>
              <option value="CUSTOMER">CUSTOMER</option>
              <option value="SYSTEM">SYSTEM</option>
            </select>
          </div>
          <div className="field"><label>From</label>
            <input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} />
          </div>
          <div className="field"><label>To</label>
            <input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} />
          </div>
          <button className="btn" onClick={() => load(1)}>Filter</button>
          <button className="btn secondary" onClick={() => { setF({ action: '', entityType: '', entityId: '', actorType: '', from: '', to: '' }); load(1); }}>
            Reset
          </button>
        </div>
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="card">
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty text="No audit entries found." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Actor</th>
                  <th>IP</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(a.createdAt)}</td>
                    <td className="mono">{a.action}</td>
                    <td className="mono">{a.entityType}{a.entityId ? ` · ${a.entityId.slice(0, 8)}…` : ''}</td>
                    <td>{a.actorType}</td>
                    <td className="mono">{a.ipAddress || '—'}</td>
                    <td>
                      <button className="btn secondary" onClick={() => setOpenId(openId === a.id ? null : a.id)}>
                        {openId === a.id ? 'Hide' : 'Detail'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {openId && (() => {
              const a = items.find((x) => x.id === openId);
              return a ? (
                <pre className="dump" style={{ marginTop: 12 }}>
                  {JSON.stringify({ id: a.id, before: a.before, after: a.after }, null, 2)}
                </pre>
              ) : null;
            })()}
            <Pager page={page} pageSize={25} total={total} onPage={load} />
          </div>
        )}
      </div>
    </>
  );
}
