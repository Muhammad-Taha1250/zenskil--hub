'use client';

import { useEffect, useState } from 'react';
import { api, errMsg } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { PageHead, Badge, Loading, Empty, Pager, useRole, canWrite } from '@/components/ui';

const TASK_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'MANUAL_REVIEW'];

interface TaskRow {
  id: string;
  status: string;
  provider: string;
  attempts: number;
  createdAt: string;
  order?: { orderNumber: string } | null;
}

interface TaskDetail extends TaskRow {
  payload?: Record<string, any> | null;
  claimedBy?: { name?: string | null; email?: string | null } | null;
  note?: string | null;
  lastError?: string | null;
  completedAt?: string | null;
}

/**
 * Fulfillment task queue (the manual admin queue).
 * Backend: GET /api/v1/fulfillment/tasks, GET /:id,
 *   POST /:id/claim | /complete {note?} | /fail {error} | /retry | /manual-review {note}.
 * Actions are OWNER/FINANCE/SUPPORT. The customer is notified only on completion.
 */
export default function FulfillmentPage() {
  const role = useRole();
  const canAct = canWrite(role, ['OWNER', 'FINANCE', 'SUPPORT']);
  const [items, setItems] = useState<TaskRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('PENDING');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<TaskDetail | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(p: number, s: string) {
    setLoading(true);
    setError('');
    const q = new URLSearchParams({ page: String(p), pageSize: '20' });
    if (s) q.set('status', s);
    const r = await api<{ total: number; items: TaskRow[] }>(`fulfillment/tasks?${q}`);
    if (r.ok) {
      setItems(r.data.items || []);
      setTotal(r.data.total || 0);
    } else setError(errMsg(r.data, 'Failed to load tasks'));
    setLoading(false);
  }

  useEffect(() => {
    load(1, 'PENDING');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openDetail(id: string) {
    setNote('');
    const r = await api<TaskDetail>(`fulfillment/tasks/${id}`);
    if (r.ok) setSelected(r.data);
    else setError(errMsg(r.data, 'Failed to load task'));
  }

  async function act(action: string, body?: Record<string, unknown>) {
    if (!selected) return;
    setBusy(true);
    const r = await api(`fulfillment/tasks/${selected.id}/${action}`, {
      method: 'POST',
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    setBusy(false);
    if (!r.ok) {
      setError(errMsg(r.data, `Action "${action}" failed`));
      return;
    }
    setNotice(`Task ${action} succeeded.`);
    setNote('');
    await openDetail(selected.id);
    await load(page, status);
  }

  const payload = selected?.payload || {};

  return (
    <>
      <PageHead
        title="Fulfillment"
        sub="Manual delivery queue. The customer hears “delivered” only after you complete a task — never before."
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
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      <div className="grid cols-2" style={{ gridTemplateColumns: selected ? '1fr 1.1fr' : '1fr' }}>
        <div className="card">
          <h2>Queue</h2>
          {loading ? (
            <Loading />
          ) : items.length === 0 ? (
            <Empty text="No tasks in this state." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Order</th><th>Status</th><th>Provider</th><th>Attempts</th><th>Created</th></tr>
                </thead>
                <tbody>
                  {items.map((t) => (
                    <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(t.id)}>
                      <td className="mono">{t.order?.orderNumber || t.id.slice(0, 8)}</td>
                      <td><Badge value={t.status} /></td>
                      <td>{t.provider}</td>
                      <td>{t.attempts}</td>
                      <td>{formatDateTime(t.createdAt)}</td>
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
              <h2>Task detail</h2>
              <button className="btn secondary small" onClick={() => setSelected(null)}>Close</button>
            </div>
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Status</dt>
              <dd><Badge value={selected.status} /></dd>
              <dt>Order</dt>
              <dd className="mono">{selected.order?.orderNumber || '—'}</dd>
              <dt>Provider</dt>
              <dd>{selected.provider}</dd>
              <dt>Attempts</dt>
              <dd>{selected.attempts}</dd>
              <dt>Claimed by</dt>
              <dd>{selected.claimedBy?.name || selected.claimedBy?.email || '—'}</dd>
              <dt>Last error</dt>
              <dd>{selected.lastError || '—'}</dd>
            </dl>

            <h3>What to deliver (snapshot at payment time)</h3>
            <dl className="kv">
              <dt>Product</dt>
              <dd>{payload.productName || '—'}</dd>
              <dt>Plan</dt>
              <dd>{payload.planName || '—'}</dd>
              <dt>Customer</dt>
              <dd>{payload.customerName || '—'}</dd>
              <dt>Price</dt>
              <dd>{payload.pricePaisa != null ? `PKR ${(payload.pricePaisa / 100).toFixed(2)}` : '—'} {payload.currency || ''}</dd>
            </dl>
            {payload.fulfillmentNotes && (
              <div className="alert info" style={{ marginTop: 8 }}>
                <strong>Fulfillment notes:</strong> {payload.fulfillmentNotes}
              </div>
            )}

            {canAct ? (
              <>
                <h3>Actions</h3>
                {(selected.status === 'PENDING' || selected.status === 'FAILED') && (
                  <div className="btn-row">
                    <button className="btn small" disabled={busy} onClick={() => act('claim')}>
                      Claim task
                    </button>
                    {selected.status === 'FAILED' && (
                      <button className="btn secondary small" disabled={busy} onClick={() => act('retry')}>
                        Retry (→ PENDING)
                      </button>
                    )}
                  </div>
                )}
                {(selected.status === 'PROCESSING' || selected.status === 'MANUAL_REVIEW') && (
                  <>
                    <div className="field" style={{ marginTop: 8 }}>
                      <label>Note (optional for complete; mandatory for manual review)</label>
                      <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="e.g. Credentials emailed to customer at …"
                      />
                    </div>
                    <div className="btn-row">
                      <button className="btn small" disabled={busy} onClick={() => act('complete', note.trim() ? { note: note.trim() } : undefined)}>
                        Complete — notify customer
                      </button>
                      <button
                        className="btn secondary small"
                        disabled={busy}
                        onClick={() => {
                          if (!note.trim()) {
                            setError('A note is mandatory for manual review.');
                            return;
                          }
                          act('manual-review', { note: note.trim() });
                        }}
                      >
                        Manual review
                      </button>
                      <button
                        className="btn danger small"
                        disabled={busy}
                        onClick={() => {
                          if (!note.trim()) {
                            setError('Describe the failure (note becomes the error).');
                            return;
                          }
                          act('fail', { error: note.trim() });
                        }}
                      >
                        Fail
                      </button>
                    </div>
                    <div className="hint" style={{ marginTop: 6, fontSize: 12, color: '#66727f' }}>
                      Completing moves the order to ACTIVE and sends the delivery message.
                    </div>
                  </>
                )}
                {selected.status === 'COMPLETED' && (
                  <div className="alert ok">Completed {selected.completedAt ? formatDateTime(selected.completedAt) : ''} — customer notified.</div>
                )}
              </>
            ) : (
              <div className="alert info" style={{ marginTop: 10 }}>
                Task actions require the OWNER, FINANCE or SUPPORT role.
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
