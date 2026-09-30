'use client';

import { useEffect, useState } from 'react';
import { api, errMsg } from '@/lib/api-client';
import { formatPkr } from '@/lib/format';
import { PageHead, Loading, Empty } from '@/components/ui';

interface AttributionRow {
  source: string | null;
  campaign: string | null;
  utmSource: string | null;
  orders: number;
  revenuePaisa: number;
}

/**
 * Ad-attribution analytics (spec §22).
 * Backend: GET /api/v1/analytics/attribution — orders grouped by attribution
 * source / campaign / utm_source, with PAID revenue. (OWNER/FINANCE/VIEWER.)
 */
export default function AttributionPage() {
  const [rows, setRows] = useState<AttributionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api<AttributionRow[]>('analytics/attribution').then((r) => {
      if (r.ok) setRows(r.data || []);
      else setError(errMsg(r.data, 'Failed to load attribution'));
      setLoading(false);
    });
  }, []);

  const totalOrders = rows.reduce((n, r) => n + r.orders, 0);
  const totalRevenue = rows.reduce((n, r) => n + r.revenuePaisa, 0);

  return (
    <>
      <PageHead
        title="Attribution"
        sub="Which ad sources and campaigns turn into orders (spec §22)."
      />
      {error && <div className="alert error">{error}</div>}
      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <div className="card stat">
          <div className="label">Attributed orders</div>
          <div className="value">{totalOrders}</div>
        </div>
        <div className="card stat">
          <div className="label">Attributed revenue (PAID)</div>
          <div className="value">{formatPkr(totalRevenue)}</div>
        </div>
        <div className="card stat">
          <div className="label">Sources</div>
          <div className="value">{rows.length}</div>
        </div>
      </div>
      <div className="card">
        {loading ? <Loading /> : rows.length === 0 ? <Empty text="No attribution data yet." /> : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Campaign</th>
                  <th>UTM source</th>
                  <th style={{ textAlign: 'right' }}>Orders</th>
                  <th style={{ textAlign: 'right' }}>Revenue (PAID)</th>
                  <th style={{ textAlign: 'right' }}>Share</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.source || '—'}</td>
                    <td>{r.campaign || '—'}</td>
                    <td className="mono">{r.utmSource || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{r.orders}</td>
                    <td style={{ textAlign: 'right' }}>{formatPkr(r.revenuePaisa)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {totalOrders ? `${((r.orders / totalOrders) * 100).toFixed(1)}%` : '—'}
                    </td>
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
