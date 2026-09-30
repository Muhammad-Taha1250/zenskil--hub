-- Phase 5: when each reminder stage was reached (anti-burst: reminder N+1 waits
-- for its absolute threshold AND a minimum gap after reminder N was sent)
ALTER TABLE "orders" ADD COLUMN "abandonment_reminder_stage_at" TIMESTAMPTZ(6);
ALTER TABLE "subscriptions" ADD COLUMN "renewal_reminder_stage_at" TIMESTAMPTZ(6);
