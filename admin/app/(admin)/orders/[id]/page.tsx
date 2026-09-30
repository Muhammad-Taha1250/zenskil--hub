'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, errMsg } from '@/lib/api-client';
import { formatPkr, formatDateTime } from '@/lib/format';
import { PageHead, Badge, Loading, useRole, canWrite } from '@/components/ui';

interface OrderDetail {
  id: string;
  orderNumber: string;
  status: string;
  amountPaisa: number;
  currency: string;
  couponCode?: string | null;
  discountPaisa?: number | null;
  paymentExpiresAt?: string | null;
  createdAt: string;
  customer?: { id: string; name?: string | null; whatsappNumber?: string | null } | null;
  items: { id: string; plan?: { name?: string } | null; product?: { name?: string } | null }[];
  payments: { id: string; status: string; amountPaisa: number; provider: string; createdAt: string }[];
  fulfillmentTasks: { id: string; status: string; provider: string; createdAt: string }[];
  subscription?: { id: string; status: string; expiresAt?: string | null } | null;
}

/**
 * Order detail.
 * Backend: GET /api/v1/orders/:id, POST /api/v1/orders/:id/confirm,
 *          POST /api/v1/orders/:id/cancel { reason }.
 * Confirm/cancel are OWNER/FINANCE/SUPPORT.
 */
export default function OrderDetailPage({ params }: { params: { id: string } }) {
  const role = useRole();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [showCancel, setShowCancel] = useState(false);

  async function load() {
    setError('');
    const r = await api<OrderDetail>(`orders/${params.id}`);
    if (r.ok) setOrder(r.data);
    else setError(errMsg(r.data, 'Failed to load order'));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirm() {
    setBusy(true);
    const r = await api(`orders/${params.id}/confirm`, { method: 'POST' });
    setBusy(false);
    if (!r.ok) setError(errMsg(r.data, 'Confirm failed'));
    else {
      setNotice('Order confirmed.');
      await load();
    }
  }

  async function cancel() {
    if (!cancelReason.trim()) {
      setError('A cancellation reason is required.');
      return;
    }
    setBusy(true);
    const r = await api(`orders/${params.id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: cancelReason.trim() }),
    });
    setBusy(false);
    if (!r.ok) setError(errMsg(r.data, 'Cancel failed'));
    else {
      setNotice('Order cancelled.');
      setShowCancel(false);
      setCancelReason('');
      await load();
    }
  }

  const canAct = canWrite(role, ['OWNER', 'FINANCE', 'SUPPORT']);

  return (
    <>
      <PageHead
        title={order ? `Order ${order.orderNumber}` : 'Order'}
        sub="Full order detail: items, payments, fulfillment tasks, subscription."
        actions={<Link href="/orders" className="btn secondary">← Back to orders</Link>}
      />
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}
      {!order ? (
        <Loading />
      ) : (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0 }}>Summary</h2>
              <Badge value={order.status} />
            </div>
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>Amount</dt>
              <dd>{formatPkr(order.amountPaisa)} {order.currency}</dd>
              <dt>Customer</dt>
              <dd>{order.customer?.name || '—'} ({order.customer?.whatsappNumber || '—'})</dd>
              <dt>Coupon</dt>
              <dd>{order.couponCode || '—'}{order.discountPaisa ? ` (−${formatPkr(order.discountPaisa)})` : ''}</dd>
              <dt>Payment deadline</dt>
              <dd>{formatDateTime(order.paymentExpiresAt)}</dd>
              <dt>Created</dt>
              <dd>{formatDateTime(order.createdAt)}</dd>
            </dl>
            {canAct && (
              <div className="btn-row">
                <button className="btn small" disabled={busy} onClick={confirm}>
                  Confirm order
                </button>
                <button className="btn secondary small" onClick={() => setShowCancel(!showCancel)}>
                  Cancel order…
                </button>
              </div>
            )}
            {showCancel && canAct && (
              <div style={{ marginTop: 10 }}>
                <div className="field">
                  <label>Cancellation reason (required)</label>
                  <input
                    type="text"
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    placeholder="Why is this order being cancelled?"
                  />
                </div>
                <div className="btn-row">
                  <button className="btn danger small" disabled={busy} onClick={cancel}>
                    Confirm cancellation
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="grid cols-2">
            <div className="card">
              <h2>Items</h2>
              <table className="data">
                <tbody>
                  {order.items.map((it) => (
                    <tr key={it.id}>
                      <td>{it.product?.name} — {it.plan?.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>Subscription</h3>
              {order.subscription ? (
                <dl className="kv">
                  <dt>Status</dt>
                  <dd><Badge value={order.subscription.status} /></dd>
                  <dt>Expires</dt>
                  <dd>{formatDateTime(order.subscription.expiresAt)}</dd>
                </dl>
              ) : (
                <div className="empty">No subscription yet</div>
              )}
            </div>
            <div className="card">
              <h2>Payments</h2>
              {order.payments.length === 0 ? (
                <div className="empty">No payments</div>
              ) : (
                <table className="data">
                  <thead>
                    <tr><th>Amount</th><th>Status</th><th>Provider</th><th>Created</th></tr>
                  </thead>
                  <tbody>
                    {order.payments.map((p) => (
                      <tr key={p.id}>
                        <td><Link href={`/payments?highlight=${p.id}`}>{formatPkr(p.amountPaisa)}</Link></td>
                        <td><Badge value={p.status} /></td>
                        <td>{p.provider}</td>
                        <td>{formatDateTime(p.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <h3>Fulfillment tasks</h3>
              {order.fulfillmentTasks.length === 0 ? (
                <div className="empty">No tasks</div>
              ) : (
                <table className="data">
                  <thead>
                    <tr><th>Status</th><th>Provider</th><th>Created</th></tr>
                  </thead>
                  <tbody>
                    {order.fulfillmentTasks.map((t) => (
                      <tr key={t.id}>
                        <td><Link href={`/fulfillment?highlight=${t.id}`}><Badge value={t.status} /></Link></td>
                        <td>{t.provider}</td>
                        <td>{formatDateTime(t.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
