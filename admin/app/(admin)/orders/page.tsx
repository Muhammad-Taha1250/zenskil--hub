'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, errMsg } from '@/lib/api-client';
import { formatPkr, formatDateTime } from '@/lib/format';
import { PageHead, Badge, Loading, Empty, Pager } from '@/components/ui';

const ORDER_STATUSES = [
  'DRAFT', 'AWAITING_PAYMENT', 'PAYMENT_PROCESSING', 'PAYMENT_CONFIRMED',
  'FULFILLING', 'FULFILLED', 'ACTIVE', 'CANCELLED', 'REFUND_REQUESTED', 'REFUNDED',
];

interface OrderItem {
  id: string;
  orderNumber: string;
  status: string;
  amountPaisa: number;
  currency: string;
  createdAt: string;
  customer?: { name?: string | null; whatsappNumber?: string | null } | null;
}

/**
 * Order search + list.
 * Backend: GET /api/v1/orders?page=&pageSize=&status=&customerId=,
 * GET /api/v1/orders/by-number/:orderNumber
 */
export default function OrdersPage() {
  const [items, setItems] = useState<OrderItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load(p: number, s: string, c: string) {
    setLoading(true);
    setError('');
    const q = new URLSearchParams({ page: String(p), pageSize: '20' });
    if (s) q.set('status', s);
    if (c.trim()) q.set('customerId', c.trim());
    const r = await api<{ total: number; items: OrderItem[] }>(`orders?${q}`);
    if (r.ok) {
      setItems(r.data.items || []);
      setTotal(r.data.total || 0);
    } else {
      setError(errMsg(r.data, 'Failed to load orders'));
    }
    setLoading(false);
  }

  useEffect(() => {
    load(1, '', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [orderNumber, setOrderNumber] = useState('');

  async function findByNumber() {
    const n = orderNumber.trim();
    if (!n) {
      setError('Enter an order number (e.g. ZSH-20260924-00001).');
      return;
    }
    setLoading(true);
    setError('');
    const r = await api<{ id: string }>(`orders/by-number/${encodeURIComponent(n)}`);
    setLoading(false);
    if (!r.ok) setError(errMsg(r.data, 'Order not found'));
    else window.location.href = `/orders/${r.data.id}`;
  }

  function search() {
    setPage(1);
    load(1, status, customerId);
  }

  return (
    <>
      <PageHead title="Orders" sub="Search and inspect orders. Deterministic order numbers: ZSH-YYYYMMDD-XXXXX." />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="toolbar">
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any</option>
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Customer ID</label>
            <input
              type="text"
              placeholder="UUID"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && search()}
            />
          </div>
          <div className="field">
            <label>Order number</label>
            <input
              type="text"
              placeholder="ZSH-YYYYMMDD-XXXXX"
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && findByNumber()}
            />
          </div>
          <button className="btn" onClick={search}>Search</button>
          <button className="btn secondary" onClick={findByNumber}>Find by #</button>
          <button
            className="btn secondary"
            onClick={() => { setStatus(''); setCustomerId(''); setPage(1); load(1, '', ''); }}
          >
            Reset
          </button>
        </div>
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="card">
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty text="No orders found." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Status</th>
                  <th>Amount</th>
                  <th>Customer</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">
                      <Link href={`/orders/${o.id}`}>{o.orderNumber}</Link>
                    </td>
                    <td><Badge value={o.status} /></td>
                    <td>{formatPkr(o.amountPaisa)}</td>
                    <td>{o.customer?.name || o.customer?.whatsappNumber || '—'}</td>
                    <td>{formatDateTime(o.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager
              page={page}
              pageSize={20}
              total={total}
              onPage={(p) => { setPage(p); load(p, status, customerId); }}
            />
          </div>
        )}
      </div>
    </>
  );
}
