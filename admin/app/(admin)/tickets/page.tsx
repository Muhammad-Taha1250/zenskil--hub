'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, errMsg } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { PageHead, Badge, Loading, Empty, Pager, useRole, canWrite } from '@/components/ui';

const TICKET_STATUSES = ['OPEN', 'ASSIGNED', 'WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

/**
 * Support ticket inbox.
 * Backend: GET /api/v1/support/tickets, GET /:id, POST /:id/messages
 *          { authorType: 'AGENT', bodyText }, PATCH /:id/assign, PATCH /:id/status.
 * Writes are OWNER/FINANCE/SUPPORT.
 *
 * NOTE (backend gap): POST /:id/messages records the reply in the ticket
 * thread but does NOT deliver it to the customer over WhatsApp — there is no
 * admin "send WhatsApp message" endpoint (only the OWNER-only
 * /admin/whatsapp/test-send diagnostic). The reply box is labelled honestly.
 */
export default function TicketsPage() {
  const role = useRole();
  const canAct = canWrite(role, ['OWNER', 'FINANCE', 'SUPPORT']);
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('OPEN');
  const [priority, setPriority] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load(p: number, s: string, pr: string) {
    setLoading(true);
    setError('');
    const q = new URLSearchParams({ page: String(p), pageSize: '20' });
    if (s) q.set('status', s);
    if (pr) q.set('priority', pr);
    const r = await api<{ total: number; items: any[] }>(`support/tickets?${q}`);
    if (r.ok) {
      setItems(r.data.items || []);
      setTotal(r.data.total || 0);
    } else setError(errMsg(r.data, 'Failed to load tickets'));
    setLoading(false);
  }

  useEffect(() => {
    load(1, 'OPEN', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <PageHead title="Support tickets" sub="Customer ticket inbox with reply thread." />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="toolbar">
          <div className="field">
            <label>Status</label>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); load(1, e.target.value, priority); }}>
              <option value="">Any</option>
              {TICKET_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Priority</label>
            <select value={priority} onChange={(e) => { setPriority(e.target.value); setPage(1); load(1, status, e.target.value); }}>
              <option value="">Any</option>
              {PRIORITIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="card">
        {loading ? <Loading /> : items.length === 0 ? <Empty text="No tickets in this state." /> : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Subject</th><th>Status</th><th>Priority</th><th>Customer</th><th>Assignee</th><th>Updated</th></tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <tr key={t.id}>
                    <td><Link href={`/tickets/${t.id}`}>{t.subject}</Link></td>
                    <td><Badge value={t.status} /></td>
                    <td><Badge value={t.priority} /></td>
                    <td>{t.customer?.name || t.customer?.whatsappNumber || '—'}</td>
                    <td>{t.assignee?.name || '—'}</td>
                    <td>{formatDateTime(t.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={page} pageSize={20} total={total} onPage={(pg) => { setPage(pg); load(pg, status, priority); }} />
          </div>
        )}
      </div>
    </>
  );
}
