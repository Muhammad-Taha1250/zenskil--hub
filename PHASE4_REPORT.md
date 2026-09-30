# Phase 4 — WhatsApp integration: delivery report & sign-off gate

**Date:** 2026-09-24 (Asia/Karachi)
**Goal:** `goal_a709fcce2724` — ZenSkil Hub automation platform
**Authorization:** owner approved "Phase 3 is approved. Please proceed to Phase 4 (WhatsApp Integration) immediately." on 2026-09-24.
**Status: complete — awaiting owner sign-off. Do not begin Phase 5 until signed.**

## What was built

Everything is in `backend/` (NestJS + Prisma, real PostgreSQL). Phase 4 makes
the WhatsApp layer production-ready against the real Meta Cloud API while
keeping every path testable without Meta credentials.

- **Hardened Meta Cloud client** (`whatsapp/meta-cloud.client.ts`): typed
  `WhatsAppApiError` with `retryable` classification; exponential backoff +
  jitter retries on 429/5xx/network errors (3 attempts), fail-fast on other
  4xx; response classification now happens *inside* the retry loop (a unit
  test caught 500s never being retried — fixed); interactive button messages
  (1–3 buttons); media upload + media send (image/video/audio/document);
  E.164 normalization (`0300…` → `92300…`); secrets never logged.
- **Inbound delivery-status webhooks**: `statuses` callbacks (`sent`,
  `delivered`, `read`, `failed`) are normalized and applied to the stored
  outbound message; status moves forward monotonically (a stale `delivered`
  never overwrites `read`); provider-reported `failed` schedules a retry with
  the error code. The Meta webhook controller processes statuses before
  messages and still always answers 200.
- **Atomic inbound dedupe**: `handleInbound` now creates the inbound row
  first on the unique `whatsapp_message_id`; concurrent redeliveries race on
  the constraint and exactly one wins — the loser returns silently (no more
  noisy P2002 error logs, no double-processing).
- **Atomic customer/session creation**: `findOrCreateByWhatsapp` is
  create-first (P2002 → re-read); `getOrCreateSession` serializes concurrent
  creators with a transaction-scoped Postgres advisory lock — exactly one
  session per burst of simultaneous first messages.
- **Outbound retry sweeper**: failed sends are persisted with the exact
  outbound payload, `retryCount`, and `nextRetryAt`; `retryFailedOutbound()`
  re-sends due messages with 1m → 5m → 30m → 2h → 8h backoff, max 5
  attempts, then dead-letters for human review. New `messages.retry_count`,
  `messages.next_retry_at`, `messages.payload` columns (migration
  `20260924043500_add_message_retry_fields`).
- **In-process scheduler** (`scheduler/`): `@nestjs/schedule` cron runs the
  WhatsApp retry sweeper every 2 minutes and the subscription expiry sweeper
  every 15 minutes (the Phase 3 manual trigger the scheduler was promised to
  call). All jobs idempotent; failures logged, never crash the process.
- **Admin diagnostics** (OWNER-only): `GET /api/v1/admin/whatsapp/status`
  (client presence, no secret values echoed) and
  `POST /api/v1/admin/whatsapp/test-send` — the real-connection verification
  path: after Meta credentials are provisioned, the owner sends a live test
  message to their own number and gets `{ ok, providerMessageId, latencyMs }`.
- **In-memory test double** (`in-memory-whatsapp.client.ts`): records every
  send, deterministic provider ids, scriptable transient failures, media
  download stub — the whole Phase 4 suite runs with zero network.

## Evidence (all against real PostgreSQL, `zenskill_test`)

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 8 suites / **55 passed** (incl. 9 new: retry/backoff classification, E.164, interactive limits) |
| WhatsApp E2E (`npm run test:whatsapp`) | **40/40 checks** |
| Business E2E (`npm run test:e2e`, regression) | **67/67 checks**, 84 audit rows |
| `npm run typecheck` / lint | clean |
| `npm run build` + production boot | `/health` → 200, `/ready` → 200, zero errors in log |

WhatsApp E2E coverage (simulated, no Meta): full order conversation
(greeting → products → plans → name → YES → payment instructions) in
**English, Roman Urdu, and Urdu**; STOP/START opt-out silencing (templates
blocked after STOP); 24h service-window block (audited) and reopening;
**10-way replay-dedupe race → 1 row / 1 reply**; **10-way session race → 1
session**; **10-way customer race → 1 customer**; status progression
sent → delivered → read (monotonic), failed → retry scheduled → sweeper
re-sends to SENT; transient send failure → FAILED → sweeper SENT;
interactive buttons send + `button_reply` routing; payment-proof image →
PAYMENT_PROCESSING with proof file on disk; signed statuses POST through the
real HTTP controller → 200 + row updated.

Defects found and fixed by testing in Phase 4:
- Meta-level 500/429 errors were classified *outside* the retry loop and
  therefore never retried — moved classification inside `withRetry`
  (caught by the new unit test).
- `WhatsappModule` missed `AuthModule`, so the new admin controller failed
  DI at boot — fixed and covered by both E2E suites booting the full app.

## What is NOT done (HUMAN ACTION REQUIRED)

The code is ready for the real API; the Meta-side prerequisites are not:

1. Meta Business verification, WhatsApp Business Account, dedicated phone
   number, Meta developer app + Cloud API credentials, approved message
   templates — then set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
   `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` (see
   `backend/.env.example`) and run `POST /api/v1/admin/whatsapp/test-send`
   with your own number to verify live delivery.
2. The Meta webhook URL must be pointed at
   `https://<domain>/api/v1/webhooks/whatsapp` with the verify token.
3. Template content/approval remains with the owner; marketing templates
   additionally require customer opt-in (enforced in code).

## Open owner decisions (carried over)

Unchanged from Phase 3: fulfillment definition, day-one payment workflow
confirmation, AI provider, refund policy, support hours/operators, approved
content, branding.

## Sign-off

Reply **"approve"** to sign off Phase 4 and authorize Phase 5 (n8n
automation), or list the items you want tightened first.
