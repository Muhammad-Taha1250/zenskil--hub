'use client';

import { useEffect, useState } from 'react';
import { api, errMsg } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { PageHead, Badge, Loading, Empty, Pager, useRole, canWrite } from '@/components/ui';

const ACTION_TYPES = ['REFUND', 'MANUAL_PAYMENT', 'PRICE_CHANGE', 'POLICY_CHANGE', 'CREDENTIAL_CHANGE', 'CUSTOMER_DELETE'];
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'];

/**
 * Pending approvals (maker-checker).
 * Backend: GET /api/v1/approvals?status=&actionType=&page=&pageSize=,
 *          GET /api/v1/approvals/:id,
 *          POST /api/v1/approvals/:id/decide { decision: 'APPROVE'|'REJECT', reason? }.
 * Decide: OWNER/FINANCE. A different admin than the requester must decide (backend-enforced).
 */
export default function ApprovalsPage() {
  const role = useRole();
  const canDecide = canWrite(role, ['OWNER', 'FINANCE']);
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('PENDING');
  const [actionType, setActionType] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<any>(null);
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(p: number, s: string, at: string) {
    setLoading(true);
    setError('');
    const q = new URLSearchParams({ page: String(p), pageSize: '20' });
    if (s) q.set('status', s);
    if (at) q.set('actionType', at);
    const r = await api<{ total: number; items: any[] }>(`approvals?${q}`);
    if (r.ok) {
      setItems(r.data.items || []);
      setTotal(r.data.total || 0);
    } else setError(errMsg(r.data, 'Failed to load approvals'));
    setLoading(false);
  }

  useEffect(() => {
    load(1, 'PENDING', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openDetail(id: string) {
    setReason('');
    setDecision('APPROVE');
    const r = await api<any>(`approvals/${id}`);
    if (r.ok) setSelected(r.data);
    else setError(errMsg(r.data, 'Failed to load approval'));
  }

  async function decide() {
    if (!selected) return;
    setBusy(true);
    const r = await api(`approvals/${selected.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision, reason: reason.trim() || undefined }),
    });
    setBusy(false);
    if (!r.ok) {
      setError(errMsg(r.data, 'Decision failed'));
      return;
    }
    setNotice(`Approval ${decision === 'APPROVE' ? 'approved' : 'rejected'}.`);
    setSelected(null);
    setReason('');
    await load(page, status, actionType);
  }

  return (
    <>
      <PageHead
        title="Approvals"
        sub="Maker-checker queue: refunds, price changes, policy/credential changes, customer deletion."
      />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="toolbar">
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); load(1, e.target.value, actionType); }}>
              <option value="">Any</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Action type</label>
            <select value={actionType} onChange={(e) => { setActionType(e.target.value); setPage(1); load(1, status, e.target.value); }}>
              <option value="">Any</option>
              {ACTION_TYPES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
      </div>
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      <div className="grid cols-2" style={{ gridTemplateColumns: selected ? '1fr 1fr' : '1fr' }}>
        <div className="card">
          <h2>Queue</h2>
          {loading ? <Loading /> : items.length === 0 ? <Empty text="No approvals in this state." /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Type</th><th>Status</th><th>Requested by</th><th>Created</th></tr>
                </thead>
                <tbody>
                  {items.map((a) => (
                    <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(a.id)}>
                      <td><Badge value={a.actionType} /></td>
                      <td><Badge value={a.status} /></td>
                      <td>{a.requester?.name || a.requester?.email || '—'}</td>
                      <td>{formatDateTime(a.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager page={page} pageSize={20} total={total} onPage={(pg) => { setPage(pg); load(pg, status, actionType); }} />
            </div>
          )}
        </div>

        {selected && (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2>Approval detail</h2>
              <button className="btn secondary small" onClick={() => setSelected(null)}>Close</button>
            </div>
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Type</dt>
              <dd><Badge value={selected.actionType} /></dd>
              <dt>Status</dt>
              <dd><Badge value={selected.status} /></dd>
              <dt>Requested by</dt>
              <dd>{selected.requester?.name || selected.requester?.email || '—'}</dd>
              <dt>Decided by</dt>
              <dd>{selected.decider?.name || selected.decider?.email || '—'}</dd>
              <dt>Created</dt>
              <dd>{formatDateTime(selected.createdAt)}</dd>
              <dt>Expires</dt>
              <dd>{formatDateTime(selected.expiresAt)}</dd>
            </dl>
            <h3>Payload</h3>
            <pre className="dump">{JSON.stringify(selected.payload ?? selected, null, 2)}</pre>

            {canDecide && selected.status === 'PENDING' ? (
              <>
                <h3>Decision</h3>
                <div className="field">
                  <label>Decision</label>
                  <select value={decision} onChange={(e) => setDecision(e.target.value as any)}>
                    <option value="APPROVE">APPROVE</option>
                    <option value="REJECT">REJECT</option>
                  </select>
                </div>
                <div className="field">
                  <label>Reason (optional)</label>
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
                <div className="btn-row">
                  <button className="btn" disabled={busy} onClick={decide}>
                    {busy ? 'Submitting…' : `Submit ${decision}`}
                  </button>
                </div>
              </>
            ) : (
              <div className="alert info" style={{ marginTop: 10 }}>
                Decisions require the OWNER or FINANCE role, and must come from a different admin than the requester.
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
