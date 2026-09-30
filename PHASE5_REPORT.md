# Phase 5 — n8n automation: delivery report & sign-off gate

**Date:** 2026-09-24 (Asia/Karachi)
**Goal:** `goal_a709fcce2724` — ZenSkil Hub automation platform
**Authorization:** owner approved Phase 4 and authorized Phase 5 immediately on 2026-09-24.
**Status: complete — awaiting owner sign-off. Do not begin Phase 6 until signed.**

## Architecture decision (the important one)

n8n is a **thin scheduler/dispatcher**. The NestJS backend stays authoritative for
every business-critical decision:

- Candidate selection (who is due a reminder), reminder timing and stages,
  opt-in enforcement, 24-hour-window / template policy, idempotency, atomic
  claims, and auditing — all live in the backend.
- n8n workflows call service-token-protected endpoints under
  `/api/v1/automation/*`, fetch due items, and invoke one endpoint per item.
- Real-time inbound WhatsApp continues to hit the backend directly; it does
  not pass through n8n.

This means schedules can be re-timed in n8n without ever changing who gets
messaged or why.

## What was built

**Auth** (`common/guards/service-token.guard.ts`): `x-service-token` header,
constant-time comparison, token never logged. No token → 401, wrong token →
401, server token unset → 503 (automation closed by default).

**Dispatch policy** (`notifications/dispatch-policy.ts`, pure + unit-tested):
free-form requires an active 24-hour service window; templates work outside
the window but require opt-in; abandoned-order and renewal nudges always use
approved templates. Unit test covers all 8 combinations of
free-form/template × in/out-of-window × opted-in/out.

**Database** (applied to `zenskill_test`; Prisma client regenerated via the
`database/` cached-engine workflow):
- `20260924051500_add_automation_fields` — `orders.abandonment_reminder_stage`,
  `support_tickets.alerted_at` + index.
- `20260924052500_add_reminder_stage_timestamps` —
  `orders.abandonment_reminder_stage_at`, `subscriptions.renewal_reminder_stage_at`.
  Stage timestamps stop a catch-up run from firing multiple stages back-to-back
  (anti-burst gap: 20h between abandonment stages, 20h between renewal stages).

**AutomationService** (`automation/automation.service.ts`):
- Notification dispatcher: lists queued notifications, dispatches each via the
  policy; opted-out customers are blocked (marked FAILED, never sent).
- Abandoned orders: candidates = `AWAITING_PAYMENT` orders ≥2h old (stage 0) or
  ≥24h old (stage 1), opted-in customers only, paid/processing/manual-review
  excluded; stage claimed atomically via conditional `updateMany` — concurrent
  runs produce exactly one winner, losers get `race_lost`; sends template 1
  then template 2 (final), audited.
- Renewal reminders: buckets 7d / 3d / 1d before expiry, stage advances
  atomically, anti-burst gaps, opt-out excluded, template send, audited.
- Ticket alerts: unalerted HIGH/URGENT (any assignment) and unassigned MEDIUM+
  tickets listed; alert claimed atomically (`alertedAt` set once; re-claim →
  false); admin webhook called per alert.
- Expiry sweeper: delegates to the existing `SubscriptionsService` sweeper
  (grace/expiring logic unchanged from Phase 3).

**MaintenanceService** (`automation/maintenance.service.ts`): `pg_dump`
(no shell interpolation) piped through gzip into `BACKUP_DIR`, keeps the
newest `BACKUP_RETENTION_COUNT` (default 7), successful backups audited;
partial files deleted on failure.

**HTTP API** (`automation.controller.ts`, 10 endpoints):
`GET /automation/notifications/pending`, `POST /automation/notifications/:id/dispatch`,
`GET /automation/orders/abandoned`, `POST /automation/orders/:id/abandonment-reminder`,
`GET /automation/subscriptions/renewal-candidates`,
`POST /automation/subscriptions/:id/renewal-reminder`,
`POST /automation/subscriptions/sweeper/run`,
`GET /automation/support/tickets/alerts`,
`POST /automation/support/tickets/:id/alert`,
`POST /automation/maintenance/db-backup`.

**n8n workflows** (`workflows/n8n/`, 6 versioned JSONs + README + template
drafts): notification-dispatcher (every 5 min), abandoned-reminders (every
30 min), renewal-reminders (daily 09:00 Asia/Karachi), expiry-sweeper (every
15 min), ticket-alerts (every 5 min), db-backup (nightly 02:00 Asia/Karachi).
Credentials referenced by name only (`ZenSkil Backend API`); no token value
embedded. Structural validator: **104/104 checks green** (node wiring, one
valid schedule trigger per workflow, versioned filenames, URL roles,
no embedded secrets).

**Seed templates** (draft, unapproved): `abandoned_reminder_1/2`,
`renewal_reminder`, `payment_confirmation`, `support_followup` — submission to
Meta is **HUMAN ACTION REQUIRED** (see `workflows/n8n/message-templates.draft.md`).

## Defects found and fixed by testing

1. **Backup endpoint deadlock (real bug):** the `pg_dump` `close` listener was
   attached *after* `await pipeline(...)`; for a small DB the process exits
   before the listener exists → the await never resolves → HTTP request hangs
   forever. Fixed by attaching listeners before consuming stdout; pipeline
   failure now kills the child and deletes the partial file. (The E2E caught
   this as a hang in the backup section.)
2. **AuditLog.entityId not nullable-typed:** backup audit passed
   `entityId: 'database'` into a UUID column → P2023. Fixed to `entityId: null`.
3. **Production route double-prefix (real bug, found by the boot check):**
   `setGlobalPrefix('api/v1')` + URI versioning (`defaultVersion: '1'`) produced
   `/api/v1/v1/...` in production, while every document and the Meta webhook
   config say `/api/v1/...`. Fixed: global prefix is now `api`; URI versioning
   supplies the version → `/api/v1/...` in production. All three E2E harnesses
   now mirror `main.ts` exactly (prefix `api` + URI versioning) so the
   versioned-path contract is tested, not assumed.
4. Test assertion fixes only: Nest POST defaults to 201; three E2E assertions
   expected 200 (dispatcher, sweeper, backup endpoints all behave correctly).

## Evidence (all against real PostgreSQL `zenskill_test`)

| Check | Result |
|---|---|
| Unit (`npm test`) | 9 suites, **64/64** pass (new: dispatch-policy 8-combo matrix) |
| n8n E2E (`npm run test:n8n`) | **59/59**, incl. 10-way abandonment race (1 winner / 9 race_lost), 10-way renewal race, 10-way ticket-claim race, real `pg_dump`+gzip backup (valid pg_dump header), retention keeps newest 2 |
| WhatsApp E2E (`npm run test:whatsapp`) | **40/40**, no regression |
| Business E2E (`npm run test:e2e`) | **67/67**, no regression |
| Workflow JSON validation (`npm run test:workflows`) | **104/104** |
| `npm run typecheck`, `lint`, `build` | clean |
| Production boot (`dist`, real DB) | `/health` 200, `/ready` 200, automation 401 without token / 503 with unset token / 200 with token, 0 boot errors |

## HUMAN ACTION REQUIRED before live activation

- Deploy self-hosted n8n; set `ZENSKILL_API_BASE_URL` and
  `ZENSKILL_ADMIN_ALERT_URL`; create the `ZenSkil Backend API` HTTP Header Auth
  credential; set a matching backend `AUTOMATION_SERVICE_TOKEN`; import and
  activate all six workflows.
- Submit the WhatsApp templates in `workflows/n8n/message-templates.draft.md`
  to Meta and obtain approval (current sends use template *names*; real
  delivery needs approved templates).
- Configure backup storage for production and run a restore drill (planned for
  the backup phase).

## Known design decision (owner input welcome)

Ticket alerts set `alertedAt` when the claim is made, before the admin webhook
POST completes. Rationale: dedupe-first (a failed webhook shouldn't re-alert
every 5 minutes and spam admins); the failed webhook is logged. If you prefer
retry-with-visibility instead, say so and Phase 6 can add an outbox state.

## Open owner decisions (unchanged from Phase 4)

Fulfillment definition and delivery mechanism; day-one bank/JazzCash/Easypaisa
workflow details; AI provider/model and secret; refund policy; support hours
and operators; approved content (About/product/delivery/payment/refund/support/
legal/FAQ); logo, final display name, brand colors. Drafts and placeholders
remain; nothing invented.

**Phase 6 must not begin until this report is explicitly approved.**
