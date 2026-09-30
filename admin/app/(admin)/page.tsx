'use client';

import { useEffect, useState } from 'react';
import { api, errMsg } from '@/lib/api-client';
import { formatPkr } from '@/lib/format';
import { PageHead, Loading } from '@/components/ui';

interface Overview {
  customersByState: Record<string, number>;
  ordersByStatus: Record<string, number>;
  paymentsByStatus: Record<string, number>;
  subscriptionsByStatus: Record<string, number>;
  ticketsByStatus: Record<string, number>;
  revenuePaisa: number;
  paidPayments: number;
  openApprovals: number;
  queuedNotifications: number;
}

interface DayRow {
  day: string;
  orders: number;
  revenuePaisa: number;
}

function Rollup({ title, data }: { title: string; data: Record<string, number> }) {
  const entries = Object.entries(data || {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="card">
      <h2>{title}</h2>
      {entries.length === 0 && <div className="empty">No data</div>}
      <table className="data">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td style={{ textAlign: 'right', width: 70 }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Dashboard — spec §26 metrics.
 * Backend: GET /api/v1/analytics/overview and GET /api/v1/analytics/daily.
 * (OWNER/FINANCE/VIEWER only; nav hides this page for SUPPORT.)
 */
export default function DashboardPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [daily, setDaily] = useState<DayRow[]>([]);
  const [days, setDays] = useState(30);
  const [error, setError] = useState('');

  async function load(d: number) {
    setError('');
    const [o, s] = await Promise.all([
      api<Overview>('analytics/overview'),
      api<DayRow[]>(`analytics/daily?days=${d}`),
    ]);
    if (!o.ok) setError(errMsg(o.data, 'Failed to load overview'));
    else setOverview(o.data);
    if (s.ok) setDaily(s.data || []);
  }

  useEffect(() => {
    load(days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const maxOrders = Math.max(1, ...daily.map((r) => r.orders));

  return (
    <>
      <PageHead
        title="Dashboard"
        sub="Operational metrics from the live backend (Asia/Karachi)."
        actions={
          <select
            value={days}
            onChange={(e) => {
              const d = Number(e.target.value);
              setDays(d);
              load(d);
            }}
            aria-label="Days"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        }
      />
      {error && <div className="alert error">{error}</div>}
      {!overview ? (
        <Loading />
      ) : (
        <>
          <div className="grid cols-4" style={{ marginBottom: 14 }}>
            <div className="card stat">
              <div className="label">Revenue (PAID)</div>
              <div className="value">{formatPkr(overview.revenuePaisa)}</div>
              <div className="sub">{overview.paidPayments} paid payments</div>
            </div>
            <div className="card stat">
              <div className="label">Open approvals</div>
              <div className="value">{overview.openApprovals}</div>
              <div className="sub">awaiting a second admin</div>
            </div>
            <div className="card stat">
              <div className="label">Queued notifications</div>
              <div className="value">{overview.queuedNotifications}</div>
              <div className="sub">waiting for dispatch</div>
            </div>
            <div className="card stat">
              <div className="label">Active subscriptions</div>
              <div className="value">{overview.subscriptionsByStatus?.ACTIVE ?? 0}</div>
              <div className="sub">customers with live service</div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 14 }}>
            <h2>Orders & revenue — daily</h2>
            {daily.length === 0 ? (
              <div className="empty">No daily data</div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 130 }}>
                {daily.map((r) => (
                  <div
                    key={r.day}
                    title={`${r.day}: ${r.orders} orders · ${formatPkr(r.revenuePaisa)}`}
                    style={{
                      flex: 1,
                      height: `${Math.max(3, (r.orders / maxOrders) * 120)}px`,
                      background: '#1a6fd4',
                      borderRadius: '2px 2px 0 0',
                      minWidth: 2,
                    }}
                  />
                ))}
              </div>
            )}
            <div style={{ fontSize: 12, color: '#66727f', marginTop: 6 }}>
              {daily[0]?.day} → {daily[daily.length - 1]?.day} · hover a bar for detail
            </div>
          </div>

          <div className="grid cols-3">
            <Rollup title="Orders by status" data={overview.ordersByStatus} />
            <Rollup title="Payments by status" data={overview.paymentsByStatus} />
            <Rollup title="Tickets by status" data={overview.ticketsByStatus} />
          </div>
          <div className="grid cols-2" style={{ marginTop: 14 }}>
            <Rollup title="Customers by state" data={overview.customersByState} />
            <Rollup title="Subscriptions by status" data={overview.subscriptionsByStatus} />
          </div>
        </>
      )}
    </>
  );
}
