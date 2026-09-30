-- Phase 5 (n8n automation): abandonment reminder stage + ticket alert timestamp
ALTER TABLE "orders" ADD COLUMN "abandonment_reminder_stage" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "support_tickets" ADD COLUMN "alerted_at" TIMESTAMPTZ(6);
CREATE INDEX "support_tickets_alerted_at_idx" ON "support_tickets"("alerted_at");
