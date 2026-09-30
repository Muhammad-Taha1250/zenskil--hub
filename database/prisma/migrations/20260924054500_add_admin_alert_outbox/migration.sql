-- Admin alert outbox: durable retry for ticket admin notifications.
-- claimTicketAlert enqueues one row per ticket; the processor POSTs the
-- payload to ZENSKILL_ADMIN_ALERT_URL with backoff until SENT or DEAD,
-- so a failed admin webhook never silently loses a ticket alert.
CREATE TABLE admin_alert_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       UUID NOT NULL UNIQUE REFERENCES support_tickets(id) ON DELETE CASCADE,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'SENT', 'DEAD')),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);
CREATE INDEX admin_alert_outbox_due_idx
  ON admin_alert_outbox (next_attempt_at)
  WHERE status = 'PENDING';
