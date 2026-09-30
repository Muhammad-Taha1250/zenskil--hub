-- Phase 4: outbound retry bookkeeping for WhatsApp messages.
-- FAILED sends are retried with exponential backoff by the sweeper;
-- next_retry_at schedules the next attempt, retry_count caps attempts,
-- payload stores the exact outbound request so a retry re-sends faithfully.

ALTER TABLE "messages"
  ADD COLUMN "retry_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_retry_at" TIMESTAMPTZ(6),
  ADD COLUMN "payload" JSONB;

CREATE INDEX "messages_next_retry_at_idx"
  ON "messages" ("next_retry_at")
  WHERE "next_retry_at" IS NOT NULL;
