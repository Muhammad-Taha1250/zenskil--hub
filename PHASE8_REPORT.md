# Phase 8 — Fulfillment: delivery report & sign-off gate

**Date:** 2026-09-24 (Asia/Karachi)
**Goal:** `goal_a709fcce2724` — ZenSkil Hub automation platform
**Authorization:** owner approved Phase 7 on 2026-09-24 and authorized
Phase 8 (Fulfillment) immediately.
**Status: complete — awaiting owner sign-off.**

## Architecture decision (the important one)

Phase 3 built the fulfillment scaffolding (task queue, task state machine,
provider interface, admin endpoints). Phase 8 closes the loop around it —
the **promise the business makes to the customer** is now enforced in code:

- **The customer is never told "delivered" before delivery actually
  happened.** The only place a delivery message can originate is
  `FulfillmentService.completeTask()` — payment confirmation, proof receipt,
  webhook handling, task claim, and task failure all provably send nothing.
  The test suite asserts this negatively at every stage: after payment
  confirmation, after claim, and after failure there is no
  `order_fulfilled` notification and the order/customer are not ACTIVE.
- **The admin queue always knows what to deliver.** The owner's per-product
  fulfillment definition (H-5/G-1) now has a home: `Product.fulfillmentNotes`,
  editable via `PATCH /api/v1/catalog/products/:id` — no code, no deploy.
  Every task snapshots product name, plan name, price, and those notes at
  creation, so the queue is self-contained even if the catalog changes later.
- **The manual provider stays honest.** The worker sweep runs every 5
  minutes (in-process cron + `POST /api/v1/automation/fulfillment/process`
  + n8n `fulfillment-processor.v1.json`), but with only the manual provider
  registered it *defers* every task to the admin queue — it never pretends
  to deliver. A future API provider implements `FulfillmentProvider.execute`
  and the same sweep, claims, audits, and notifications apply unchanged.
- **Claims are race-safe.** Task pickup uses the atomic conditional
  `updateMany` claim (PENDING → PROCESSING); concurrent workers race and
  exactly one wins — tested with 5 parallel claims.

## What was built

- **Completion-only customer notification**
  (`fulfillment/fulfillment.service.ts`): `completeTask()` now queues the
  `order_fulfilled` template notification (order number, product, plan,
  expiry date) after order → FULFILLED → ACTIVE and customer →
  FULFILLED → ACTIVE. The template name resolves from the
  `templates.order_fulfilled` setting (default `order_fulfilled`, drafted in
  `workflows/n8n/message-templates.draft.md` in EN/Roman Urdu/Urdu). Actual
  sending still goes through the Phase 5 dispatcher, which enforces
  opt-in + 24h-window policy. A `fulfillment.delivered_notification_queued`
  audit row is written with the template used.
- **Task payload snapshot** (`payments/payments.service.ts`): at payment
  confirmation each task now records productName, planName, pricePaisa,
  currency, customerName, and the product's `fulfillmentNotes` — the admin
  queue tells staff exactly what the customer must receive.
- **`Product.fulfillmentNotes`** (migration
  `20260924081000_product_fulfillment_notes`, catalog PATCH support):
  owner-editable per-product "what does the customer receive" instructions.
- **Worker wiring**: 5-minute in-process cron (`SchedulerService.fulfillmentWorker`),
  `POST /api/v1/automation/fulfillment/process` (service-token guard),
  and the 7th n8n workflow `fulfillment-processor.v1.json` (thin
  schedule → POST, like the expiry sweeper).
- Module wiring: `FulfillmentModule` now imports `NotificationsModule` and
  `SettingsModule` (no dependency cycles); `SchedulerModule` and
  `AutomationModule` import `FulfillmentModule`.

## Defects found and fixed by testing

1. `zenskill_test` carried a stale failed-migration row
   (`20260924054500_add_admin_alert_outbox`, `finished_at NULL`) from Phase 6
   work, blocking `migrate deploy` with P3018/42P07. The table was already
   present, so the migration was resolved as applied (`migrate resolve
   --applied`) and all migrations deployed cleanly. Fresh-DB deploy was
   unaffected and verified clean.
2. The n8n workflow validator uses a hardcoded file list — the new
   `fulfillment-processor.v1.json` was added to it (99 → 113 checks).

## Evidence (all against real PostgreSQL `zenskill_test` unless noted)

| Check | Result |
|---|---|
| Fulfillment flow (`npm run test:fulfillment`, **new**) | **54/54**: full lifecycle order→PAID→PENDING→claim→complete→order ACTIVE + customer ACTIVE + subscription ACTIVE + exactly one `order_fulfilled` notification (order number/product/expiry variables) + completion audit; payload snapshot incl. fulfillmentNotes; never-delivered-early (no notification + not ACTIVE at confirmation/claim/failure); failure→FAILED→retry→PENDING across two cycles; illegal transitions rejected (complete/retry/manual-review from PENDING, claim from PROCESSING, note-less review); 5-way claim race → exactly one winner, attempts=1; manual-review→complete; worker sweep defers (processed 0, deferred ≥1); automation endpoint 401/401/201; HTTP 401 anon / 403 VIEWER / 201 SUPPORT claim / 200 OWNER list; catalog PATCH fulfillmentNotes + snapshot of updated notes |
| Unit (`npm test`) | 11 suites, **75/75**, no regression |
| Business E2E (`npm run test:e2e`) | **67/67**, no regression |
| WhatsApp E2E (`npm run test:whatsapp`) | **40/40**, no regression |
| Payments (`npm run test:payments`) | **52/52**, no regression (validates the task-payload snapshot refactor) |
| n8n E2E (`npm run test:n8n`) | **88/88**, no regression |
| AI eval (`npm run test:ai`) | **55/55**, no regression |
| Workflow validation (`npm run test:workflows`) | **113/113** (incl. new `fulfillment-processor.v1.json`) |
| `tsc --noEmit`, `nest build` | clean |
| Migrations | new migration applied clean on fresh DB (`zenskill_fresh`) and on `zenskill_test` after resolving the stale Phase 6 row; `products.fulfillment_notes` present on both |
| Production boot (`dist`, real DB) | `/health` 200, `/ready` 200, `POST …/automation/fulfillment/process` 503 without token configured (guard), `GET …/fulfillment/tasks` 401 without auth, 0 boot errors |

Note: `npm run lint` still has no configured target (ESLint not set up —
unchanged); `tsc` + `nest build` are the static gates.

## Delivered guarantee (fulfillment)

1. **No early delivery claims.** The `order_fulfilled` notification is queued
   in exactly one place — `completeTask()` — and the suite proves the
   negative at confirmation, claim, and failure.
2. **Every paid order has exactly one fulfillment task**, created in the
   same transaction as the payment confirmation, with the admin's delivery
   instructions snapshotted in.
3. **Only a human (or a future verified provider) can complete delivery.**
   Admin completion moves order → FULFILLED → ACTIVE, customer →
   FULFILLED → ACTIVE, keeps the subscription ACTIVE, and only then notifies
   the customer. Retries are idempotent; concurrent claims have exactly one
   winner; every decision is audited.

## HUMAN ACTION REQUIRED before live activation

- **H-5 (G-1) — fulfillment definition**: the mechanism is now ready. For
  each product, set **Fulfillment notes** (`PATCH
  /api/v1/catalog/products/:id`, e.g. `{"fulfillmentNotes": "Enroll the
  student in the LMS and share login credentials"}`) describing exactly what
  the customer receives. Until you define per-product automation, fulfillment
  stays a manual admin task per order (honest, no fake automation). If you
  later define an automatable delivery, an API provider can be plugged into
  the existing interface.
- **H-6**: unchanged — receiving account/wallet details still pending
  (`payment.instructions` shows the DRAFT placeholder until set).
- **H-7**: unchanged — AI provider key optional (stub runs without one).
- **Message template approval**: new `order_fulfilled` draft added to
  `workflows/n8n/message-templates.draft.md` (EN/Roman Urdu/Urdu) — submit
  alongside the other five before go-live.
- Real Meta/WhatsApp connection still pending (unchanged from Phase 4).

## Sign-off

Phase 8 acceptance per the implementation plan — `FulfillmentProvider`
interface, `ManualFulfillmentProvider` admin task queue, PENDING →
PROCESSING → COMPLETED / FAILED / MANUAL_REVIEW transitions, customer
notified only on confirmation, and the full order → payment → fulfillment →
ACTIVE subscription path — **all done** (54/54 fulfillment tests, all suites
green, production boot clean). Awaiting owner sign-off before Phase 9
(Admin panel).
