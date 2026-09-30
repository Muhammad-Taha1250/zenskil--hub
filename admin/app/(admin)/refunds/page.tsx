'use client';

import { useEffect, useState } from 'react';
import { api, errMsg } from '@/lib/api-client';
import { formatPkr, formatDateTime } from '@/lib/format';
import { PageHead, Badge, Loading, Empty, Pager, useRole, canWrite } from '@/components/ui';

/**
 * Refunds queue.
 * Backend: GET /api/v1/refunds?page=&pageSize=,
 *          POST /api/v1/refunds/request { paymentId, amountPaisa, reason }
 *            (creates the refund + a pending approval; a DIFFERENT admin must decide),
 *          POST /api/v1/refunds/:id/mark-executed { providerRefundId }
 *            (record the bank/wallet reference after YOU execute it there).
 * Writes: OWNER/FINANCE. Refund execution itself stays human.
 */
export default function RefundsPage() {
  const role = useRole();
  const canAct = canWrite(role, ['OWNER', 'FINANCE']);
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [paymentId, setPaymentId] = useState('');
  const [amountPkr, setAmountPkr] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [execFor, setExecFor] = useState<any>(null);
  const [providerRefundId, setProviderRefundId] = useState('');

  async function load(p: number) {
    setLoading(true);
    setError('');
    const r = await api<{ total: number; items: any[] }>(`refunds?page=${p}&pageSize=20`);
    if (r.ok) {
      setItems(r.data.items || []);
      setTotal(r.data.total || 0);
    } else setError(errMsg(r.data, 'Failed to load refunds'));
    setLoading(false);
  }

  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function request() {
    if (!paymentId.trim() || !amountPkr || !reason.trim()) {
      setError('Payment ID, amount and reason are all required.');
      return;
    }
    setBusy(true);
    const r = await api('refunds/request', {
      method: 'POST',
      body: JSON.stringify({
        paymentId: paymentId.trim(),
        amountPaisa: Math.round(Number(amountPkr) * 100),
        reason: reason.trim(),
      }),
    });
    setBusy(false);
    if (!r.ok) {
      setError(errMsg(r.data, 'Refund request failed'));
      return;
    }
    setShowNew(false);
    setPaymentId('');
    setAmountPkr('');
    setReason('');
    setNotice('Refund requested — a different admin must approve it on the Approvals page.');
    await load(page);
  }

  async function markExecuted() {
    if (!execFor || !providerRefundId.trim()) {
      setError('The provider/bank refund reference is required.');
      return;
    }
    setBusy(true);
    const r = await api(`refunds/${execFor.id}/mark-executed`, {
      method: 'POST',
      body: JSON.stringify({ providerRefundId: providerRefundId.trim() }),
    });
    setBusy(false);
    if (!r.ok) {
      setError(errMsg(r.data, 'Mark-executed failed'));
      return;
    }
    setExecFor(null);
    setProviderRefundId('');
    setNotice('Refund marked executed with the provider reference.');
    await load(page);
  }

  return (
    <>
      <PageHead
        title="Refunds"
        sub="Request → second-admin approval → you execute in the bank/wallet → record the reference here."
        actions={canAct && <button className="btn" onClick={() => setShowNew(!showNew)}>+ Request refund</button>}
      />
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      {showNew && canAct && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>Request refund</h2>
          <div className="alert warn">
            This creates a pending approval — <strong>a different admin</strong> must approve it
            (maker-checker). The money is moved by you in the bank/wallet app, not by this panel.
          </div>
          <div className="form-row">
            <div className="field">
              <label>Payment ID</label>
              <input type="text" className="mono" value={paymentId} onChange={(e) => setPaymentId(e.target.value)} placeholder="UUID from the Payments page" />
            </div>
            <div className="field">
              <label>Amount (PKR)</label>
              <input type="number" min={0.01} step="0.01" value={amountPkr} onChange={(e) => setAmountPkr(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>Reason</label>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this refund owed?" />
          </div>
          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={request}>{busy ? 'Requesting…' : 'Submit request'}</button>
            <button className="btn secondary" onClick={() => setShowNew(false)}>Cancel</button>
          </div>
        </div>
      )}

      {execFor && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>Mark executed — {formatPkr(execFor.amountPaisa)}</h2>
          <div className="alert info">
            Only after you have actually sent the money through the bank/wallet. Record the
            provider's reference so the refund is traceable.
          </div>
          <div className="field">
            <label>Provider refund reference</label>
            <input type="text" className="mono" value={providerRefundId} onChange={(e) => setProviderRefundId(e.target.value)} placeholder="e.g. bank transaction ID" />
          </div>
          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={markExecuted}>{busy ? 'Saving…' : 'Mark executed'}</button>
            <button className="btn secondary" onClick={() => setExecFor(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card">
        {loading ? <Loading /> : items.length === 0 ? <Empty text="No refunds." /> : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Amount</th><th>Status</th><th>Reason</th><th>Requested by</th><th>Provider ref</th><th>Created</th>{canAct && <th></th>}</tr>
              </thead>
              <tbody>
                {items.map((rf) => (
                  <tr key={rf.id}>
                    <td>{formatPkr(rf.amountPaisa)}</td>
                    <td><Badge value={rf.status} /></td>
                    <td style={{ maxWidth: 260 }}>{rf.reason}</td>
                    <td>{rf.requester?.name || rf.requester?.email || '—'}</td>
                    <td className="mono">{rf.providerRefundId || '—'}</td>
                    <td>{formatDateTime(rf.createdAt)}</td>
                    {canAct && (
                      <td>
                        {rf.status === 'APPROVED' && !rf.providerRefundId && (
                          <button className="btn secondary small" onClick={() => setExecFor(rf)}>
                            Mark executed…
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={page} pageSize={20} total={total} onPage={(pg) => { setPage(pg); load(pg); }} />
          </div>
        )}
      </div>
    </>
  );
}
