-- Phase 6 hardening: lease-based outbox delivery.
-- The processor claims a row with an atomic UPDATE (locked_until = now()+lease)
-- and performs the webhook POST *outside* any database transaction, so a slow
-- admin endpoint can never hold a DB transaction/row-lock open. Stale leases
-- (crashed workers) are recovered by the processor before each sweep.
ALTER TABLE "admin_alert_outbox" ADD COLUMN "locked_until" TIMESTAMPTZ(6);
