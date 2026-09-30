'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, errMsg } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { PageHead, Badge, Loading, useRole, canWrite } from '@/components/ui';

const TICKET_STATUSES = ['OPEN', 'ASSIGNED', 'WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'];

/**
 * Ticket detail + reply thread.
 * Backend: GET /api/v1/support/tickets/:id,
 * POST /:id/reply { bodyText } -> { message, whatsapp: { delivered, reason?, messageId? } }
 * (stores the AGENT reply in the thread AND sends it over WhatsApp),
 * PATCH /:id/assign { assigneeId }, PATCH /:id/status { status }.
 */
export default function TicketDetailPage({ params }: { params: { id: string } }) {
  const role = useRole();
  const canAct = canWrite(role, ['OWNER', 'FINANCE', 'SUPPORT']);
  const [ticket, setTicket] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [assigneeId, setAssigneeId] = useState('');
  const [newStatus, setNewStatus] = useState('');

  async function load() {
    setError('');
    const r = await api<any>(`support/tickets/${params.id}`);
    if (r.ok) {
      setTicket(r.data);
      setNewStatus(r.data.status);
    } else setError(errMsg(r.data, 'Failed to load ticket'));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendReply() {
    if (!reply.trim()) {
      setError('Reply text is required.');
      return;
    }
    setBusy(true);
    setNotice('');
    const r = await api<{ message: any; whatsapp: { delivered: boolean; reason?: string; messageId?: string | null } }>(
      `support/tickets/${params.id}/reply`,
      {
        method: 'POST',
        body: JSON.stringify({ bodyText: reply.trim() }),
      },
    );
    setBusy(false);
    if (!r.ok) {
      setError(errMsg(r.data, 'Reply failed'));
    } else {
      setReply('');
      const w = r.data.whatsapp;
      if (w.delivered) {
        setNotice('Reply sent to the customer over WhatsApp and recorded in the thread.');
      } else {
        const why =
          w.reason === 'customer_opted_out'
            ? 'the customer has opted out of WhatsApp messages'
            : w.reason === 'free_form_outside_24h_window'
              ? 'it is outside the 24-hour customer-service window (Meta only allows template messages there)'
              : 'delivery was blocked by policy';
        setNotice(`Reply recorded in the ticket thread, but NOT delivered over WhatsApp: ${why}.`);
      }
      await load();
    }
  }

  async function changeStatus() {
    setBusy(true);
    const r = await api(`support/tickets/${params.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus }),
    });
    setBusy(false);
    if (!r.ok) setError(errMsg(r.data, 'Status change failed'));
    else {
      setNotice(`Status → ${newStatus}.`);
      await load();
    }
  }

  async function assign() {
    if (!assigneeId.trim()) {
      setError('Assignee admin ID is required.');
      return;
    }
    setBusy(true);
    const r = await api(`support/tickets/${params.id}/assign`, {
      method: 'PATCH',
      body: JSON.stringify({ assigneeId: assigneeId.trim() }),
    });
    setBusy(false);
    if (!r.ok) setError(errMsg(r.data, 'Assign failed'));
    else {
      setNotice('Ticket assigned.');
      setAssigneeId('');
      await load();
    }
  }

  return (
    <>
      <PageHead
        title={ticket ? ticket.subject : 'Ticket'}
        sub="Thread, replies and status."
        actions={<Link href="/tickets" className="btn secondary">← Back to inbox</Link>}
      />
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}
      {!ticket ? (
        <Loading />
      ) : (
        <div className="grid cols-2" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
          <div className="card">
            <h2>Thread</h2>
            <div className="chat-box" style={{ marginBottom: 12 }}>
              <div className="thread">
                {(ticket.messages || []).map((m: any) => (
                  <div
                    key={m.id}
                    className={`msg ${m.authorType === 'AGENT' ? 'agent' : m.authorType === 'CUSTOMER' ? 'customer' : 'system'}`}
                  >
                    <div>{m.bodyText}</div>
                    <div className="meta">{m.authorType} · {formatDateTime(m.createdAt)}</div>
                  </div>
                ))}
                {(ticket.messages || []).length === 0 && <div className="empty">No messages yet.</div>}
              </div>
            </div>
            {canAct ? (
              <>
                <div className="field">
                  <label>Agent reply (sent over WhatsApp)</label>
                  <textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder="Write your reply to the customer…"
                  />
                  <div className="hint">
                    This records the reply in the ticket thread <strong>and</strong> sends it to the
                    customer over WhatsApp. Delivery follows WhatsApp policy: opted-out customers are
                    never messaged, and free-form replies only go through inside the 24-hour
                    customer-service window. If delivery is blocked, the reply stays in the thread and
                    you will see exactly why.
                  </div>
                </div>
                <div className="btn-row">
                  <button className="btn" disabled={busy} onClick={sendReply}>
                    {busy ? 'Sending…' : 'Send reply via WhatsApp'}
                  </button>
                </div>
              </>
            ) : (
              <div className="alert info">Replies require the OWNER, FINANCE or SUPPORT role.</div>
            )}
          </div>

          <div className="card">
            <h2>Details</h2>
            <dl className="kv">
              <dt>Status</dt>
              <dd><Badge value={ticket.status} /></dd>
              <dt>Priority</dt>
              <dd><Badge value={ticket.priority} /></dd>
              <dt>Customer</dt>
              <dd>{ticket.customer?.name || '—'} ({ticket.customer?.whatsappNumber || '—'})</dd>
              <dt>Order</dt>
              <dd className="mono">{ticket.order?.orderNumber || '—'}</dd>
              <dt>Assignee</dt>
              <dd>{ticket.assignee?.name || 'Unassigned'}</dd>
              <dt>Description</dt>
              <dd>{ticket.description || '—'}</dd>
            </dl>
            {canAct && (
              <>
                <h3>Change status</h3>
                <div className="toolbar">
                  <div className="field">
                    <select value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
                      {TICKET_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <button className="btn secondary small" disabled={busy} onClick={changeStatus}>
                    Apply
                  </button>
                </div>
                <h3>Assign</h3>
                <div className="toolbar">
                  <div className="field">
                    <label>Admin user ID</label>
                    <input
                      type="text"
                      className="mono"
                      value={assigneeId}
                      onChange={(e) => setAssigneeId(e.target.value)}
                      placeholder="UUID of assignee"
                    />
                  </div>
                  <button className="btn secondary small" disabled={busy} onClick={assign}>
                    Assign
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
