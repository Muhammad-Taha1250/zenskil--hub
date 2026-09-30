'use client';

import { useEffect, useState } from 'react';

/** Status → badge tone mapping. */
const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info' | ''> = {
  ACTIVE: 'ok',
  PAID: 'ok',
  COMPLETED: 'ok',
  PUBLISHED: 'ok',
  RESOLVED: 'ok',
  SENT: 'ok',
  APPROVED: 'ok',
  CLOSED: '',
  DRAFT: 'warn',
  PENDING: 'warn',
  AWAITING_PAYMENT: 'warn',
  MANUAL_REVIEW_REQUIRED: 'warn',
  MANUAL_REVIEW: 'warn',
  PROCESSING: 'info',
  FULFILLING: 'info',
  FULFILLMENT_PENDING: 'info',
  FULFILLMENT_PROCESSING: 'info',
  ASSIGNED: 'info',
  WAITING_CUSTOMER: 'info',
  WAITING_INTERNAL: 'info',
  QUEUED: 'info',
  OPEN: 'info',
  FAILED: 'bad',
  CANCELLED: 'bad',
  REJECTED: 'bad',
  EXPIRED: 'bad',
  DEAD: 'bad',
};

export function Badge({ value }: { value: string | null | undefined }) {
  if (!value) return <span>—</span>;
  return <span className={`badge ${TONE[value] ?? ''}`}>{value}</span>;
}

export function PageHead({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="btn-row" style={{ marginTop: 0 }}>{actions}</div>}
    </div>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <span>
        Page {page} of {pages} · {total} total
      </span>
      <button className="btn secondary small" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Prev
      </button>
      <button
        className="btn secondary small"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      >
        Next →
      </button>
    </div>
  );
}

/** Current admin role, fetched once from the session endpoint (decoded server-side). */
export function useRole(): string | null {
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setRole(d?.admin?.role ?? null))
      .catch(() => setRole(null));
  }, []);
  return role;
}

export function canWrite(role: string | null, roles: string[]): boolean {
  return !!role && roles.includes(role);
}

export function Loading() {
  return <div className="loading">Loading…</div>;
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}
