'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, errMsg } from '@/lib/api-client';
import { formatPkr, formatDateTime } from '@/lib/format';
import { PageHead, Badge, Loading, Empty, Pager, useRole, canWrite } from '@/components/ui';

const PAYMENT_STATUSES = [
  'PENDING', 'PROCESSING', 'PAID', 'FAILED', 'EXPIRED',
  'REFUNDED', 'PARTIALLY_REFUNDED', 'MANUAL_REVIEW_REQUIRED',
];

interface PaymentRow {
  id: string;
  status: string;
  amountPaisa: number;
  currency: string;
  provider: string;
  proofUrl?: string | null;
  createdAt: string;
  order?: { orderNumber: string } | null;
}

interface PaymentDetail extends PaymentRow {
  attempts: { id: string; status: string; createdAt: string }[];
  reviewer?: { name?: string | null; email?: string | null } | null;
  reviewReason?: string | null;
}

/**
 * Payment review queue.
 * Backend: GET /api/v1/payments, GET /api/v1/payments/:id,
 *          GET /api/v1/payments/:id/instructions, GET /api/v1/payments/:id/proof,
 *          POST /api/v1/payments/:id/review { decision, reason } (OWNER/FINANCE, reason mandatory).
 */
export default function PaymentsPage() {
  const role = useRole();
  const canReview = canWrite(role, ['OWNER', 'FINANCE']);
  const canSeeProof = canWrite(role, ['OWNER', 'FINANCE', 'SUPPORT']);
  const [items, setItems] = useState<PaymentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('MANUAL_REVIEW_REQUIRED');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<PaymentDetail | null>(null);
  const [instructions, setInstructions] = useState<any>(null);
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(p: number, s: string) {
    setLoading(true);
    setError('');
    const q = new URLSearchParams({ page: String(p), pageSize: '20' });
    if (s) q.set('status', s);
    const r = await api<{ total: number; items: PaymentRow[] }>(`payments?${q}`);
    if (r.ok) {
      setItems(r.data.items || []);
      setTotal(r.data.total || 0);
    } else setError(errMsg(r.data, 'Failed to load payments'));
    setLoading(false);
  }

  useEffect(() => {
    load(1, 'MANUAL_REVIEW_REQUIRED');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openDetail(id: string) {
    setInstructions(null);
    setReason('');
    setDecision('APPROVE');
    const r = await api<PaymentDetail>(`payments/${id}`);
    if (r.ok) {
      setSelected(r.data);
      const ins = await api(`payments/${id}/instructions`);
      if (ins.ok) setInstructions(ins.data);
    } else setError(errMsg(r.data, 'Failed to load payment'));
  }

  async function review() {
    if (!selected) return;
    if (!reason.trim()) {
      setError('A reason is mandatory for approve/reject.');
      return;
    }
    setBusy(true);
    const r = await api(`payments/${selected.id}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision, reason: reason.trim() }),
    });
    setBusy(false);
    if (!r.ok) {
      setError(errMsg(r.data, 'Review failed'));
      return;
    }
    setNotice(`Payment ${decision === 'APPROVE' ? 'approved' : 'rejected'}.`);
    setSelected(null);
    setReason('');
    await load(page, status);
  }

  return (
    <>
      <PageHead
        title="Payments"
        sub="Manual review queue. Screenshots never mark a payment PAID — only your approval (or a verified provider webhook) does."
      />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="toolbar">
          <div className="field">
            <label>Status</label>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
                load(1, e.target.value);
              }}
            >
              <option value="">Any</option>
              {PAYMENT_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      <div className="grid cols-2" style={{ gridTemplateColumns: selected ? '1fr 1fr' : '1fr' }}>
        <div className="card">
          <h2>Queue</h2>
          {loading ? (
            <Loading />
          ) : items.length === 0 ? (
            <Empty text="No payments in this state." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Amount</th><th>Status</th><th>Order</th><th>Provider</th><th>Created</th></tr>
                </thead>
                <tbody>
                  {items.map((p) => (
                    <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(p.id)}>
                      <td>{formatPkr(p.amountPaisa)}</td>
                      <td><Badge value={p.status} /></td>
                      <td className="mono">{p.order?.orderNumber || '—'}</td>
                      <td>{p.provider}</td>
                      <td>{formatDateTime(p.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager
                page={page}
                pageSize={20}
                total={total}
                onPage={(pg) => { setPage(pg); load(pg, status); }}
              />
            </div>
          )}
        </div>

        {selected && (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2>Payment detail</h2>
              <button className="btn secondary small" onClick={() => setSelected(null)}>Close</button>
            </div>
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Amount</dt>
              <dd>{formatPkr(selected.amountPaisa)} {selected.currency}</dd>
              <dt>Status</dt>
              <dd><Badge value={selected.status} /></dd>
              <dt>Provider</dt>
              <dd>{selected.provider}</dd>
              <dt>Order</dt>
              <dd className="mono">{selected.order?.orderNumber || '—'}</dd>
              <dt>Reviewer</dt>
              <dd>{selected.reviewer?.name || selected.reviewer?.email || '—'}</dd>
            </dl>

            {canSeeProof && selected.proofUrl && (
              <div className="btn-row">
                <a
                  className="btn secondary small"
                  href={`/api/admin-proxy/payments/${selected.id}/proof`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View proof screenshot
                </a>
              </div>
            )}

            {instructions && (
              <>
                <h3>Transfer instructions (what the customer was told)</h3>
                <pre className="dump">{JSON.stringify(instructions, null, 2)}</pre>
              </>
            )}

            {canReview && selected.status === 'MANUAL_REVIEW_REQUIRED' && (
              <>
                <h3>Review decision</h3>
                <div className="alert warn">
                  Approving marks the payment <strong>PAID</strong>, creates the fulfillment
                  task and activates the subscription. Rejecting returns it to PENDING.
                </div>
                <div className="field">
                  <label>Decision</label>
                  <select value={decision} onChange={(e) => setDecision(e.target.value as any)}>
                    <option value="APPROVE">APPROVE</option>
                    <option value="REJECT">REJECT</option>
                  </select>
                </div>
                <div className="field">
                  <label>Reason (mandatory)</label>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Amount PKR 830.00 matches bank statement ref …"
                  />
                </div>
                <div className="btn-row">
                  <button className="btn" disabled={busy} onClick={review}>
                    {busy ? 'Submitting…' : `Submit ${decision}`}
                  </button>
                </div>
              </>
            )}
            {!canReview && (
              <div className="alert info" style={{ marginTop: 10 }}>
                Review decisions require the OWNER or FINANCE role.
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
