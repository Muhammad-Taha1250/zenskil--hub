# ZenSkil Hub — Autonomous Customer & Order Management System

Brand: ZenSkil Hub — LEARN • BUILD • GROW
Market: Pakistan | Currency: PKR | Timezone: Asia/Karachi
Primary channel: WhatsApp via Baileys (WhatsApp Web WebSocket, QR-paired —
replaced the Meta WhatsApp Cloud API on 2026-09-26; see "Baileys refactor"
note below)

## Project status

- [x] Phase 1 — Architecture (analysis, this folder) — approved by owner 2026-09-24
- [x] Phase 2 — Database — complete, tests green, **approved by owner 2026-09-24**
- [x] Phase 3 — Backend — complete 2026-09-24, evidence in `PHASE3_REPORT.md`, **approved by owner 2026-09-24**
- [x] Phase 4 — WhatsApp integration — complete 2026-09-24, evidence in `PHASE4_REPORT.md`, **approved by owner 2026-09-24**
- [x] Phase 5 — n8n automation — complete 2026-09-24, evidence in `PHASE5_REPORT.md`, **approved by owner 2026-09-24**
- [x] Phase 6 — AI agent — complete 2026-09-24, evidence in `PHASE6_REPORT.md`, **approved by owner 2026-09-24**
- [x] Phase 7 — Payment abstraction — complete 2026-09-24, evidence in `PHASE7_REPORT.md`, **approved by owner 2026-09-24**
- [x] Phase 8 — Fulfillment — complete 2026-09-24, evidence in `PHASE8_REPORT.md`, **awaiting owner sign-off**
- [x] Phase 9 — Admin panel — complete 2026-09-24, evidence in `PHASE9_REPORT.md`, **approved by owner 2026-09-24**
- [ ] Phase 10 — Security — complete 2026-09-24, evidence in `PHASE10_REPORT.md`, full posture in `SECURITY.md`, **awaiting owner sign-off**
- [ ] Phase 11 — Testing — complete 2026-09-24, evidence in `PHASE11_REPORT.md` (646/646 checks green, §41 journey 52/52, 1 real defect fixed), **approved by owner 2026-09-24**
- [ ] Phase 12 — Deployment — complete 2026-09-24, package in `DEPLOYMENT.md` + `SETUP_CHECKLIST.md` + `ADMIN_USER_GUIDE.md`, evidence in `PHASE12_REPORT.md`, **awaiting owner sign-off**

Each phase ends with: what was built, test results, errors found and fixed,
human actions required, and a sign-off gate before the next phase begins.

## Baileys refactor (2026-09-26) — Meta Cloud API replaced

At the owner's request, the Meta WhatsApp Cloud API integration (Phase 4)
was replaced with `@whiskeysockets/baileys` (WhatsApp Web WebSocket, QR
pairing). The historical phase sections below still describe what was built
and approved at the time; this note describes the current architecture,
which supersedes them wherever they mention Meta:

- No Meta app, access token, phone-number ID, webhook, or template approval
  is required. Pairing is a QR scan (WhatsApp → Linked devices) printed to
  the server logs on first boot.
- Inbound arrives over the authenticated WebSocket (`messages.upsert`); the
  public Meta webhook route is removed (returns 404).
- Template message bodies are rendered locally from the `message_templates`
  table (seeded from the owner-approved drafts, owner-editable via the admin
  panel) — unknown templates and missing variables fail loud rather than
  sending fragments.
- Interactive buttons degrade to numbered text; customers reply with a digit
  and the conversation router handles it as text.
- `BAILEYS_AUTH_DIR` must live on persistent storage; exactly one backend
  replica may own the session. Logging out requires wiping the auth dir and
  re-scanning.
- Baileys is unofficial and can be disrupted or rate-limited by WhatsApp;
  all opt-in, 24h-window, anti-spam, and audit policies still apply.

## Phase 2 — Database (delivered 2026-09-24)

- `database/prisma/schema.prisma` — 28 tables, strict enums (incl. all 19
  customer states), UUID PKs, `timestamptz` UTC, money in integer paisa,
  pgvector `embedding` on knowledge-base chunks.
- `database/prisma/migrations/20260923222340_init/migration.sql` — applies
  cleanly on a fresh PostgreSQL 16 + pgvector (verified via `migrate deploy`
  on an empty database); also creates the `vector` extension and Postgres
  RULEs making `audit_logs` / `webhook_events` append-only.
- `database/prisma/seed.ts` — idempotent seed: 5 learning plans at exact spec
  prices (PKR 830 / 1,500 / 2,100 / 3,600 / 6,000), 3 inactive product
  placeholders, 12 DRAFT knowledge-base skeletons, system settings,
  business-hours placeholder.
- `database/src/orderNumber.ts` — deterministic `ZSH-YYYYMMDD-XXXXX`
  generator; per-day counter incremented by atomic UPSERT (Asia/Karachi day).
- `database/tests/verify.ts` — 22/22 checks green: seed idempotency, exact
  prices, 100-way concurrent order-number uniqueness (gapless, no collisions),
  unique constraints, enum rejection, append-only enforcement, integer paisa.
- See `database/README.md` for commands and environment notes
  (pgvector/superuser requirement, Prisma engine-download workaround).

## Phase 3 — Backend (delivered 2026-09-24, approved)

- `backend/` — NestJS API: auth (JWT/RBAC/TOTP 2FA), 19-state customer
  machine, catalog/orders/coupons, manual + provider-abstracted payments,
  fulfillment (atomic claims), subscriptions (renewal preserves prepaid
  time), support, approvals with expiry + stale-price guard, refunds
  (manual execution), notifications, settings, analytics, WhatsApp webhook
  (HMAC verified, invalid → 401), deterministic conversation engine, AI
  with exactly 9 ownership-checked tools.
- Evidence: unit 46/46, E2E **67/67** on real PostgreSQL (incl. 10-way
  webhook race, 5-way approval race, 5-way claim race), typecheck/lint/build
  clean, production build boots with `/health` + `/ready` at root, clean
  `migrate deploy` on fresh DB, seed idempotent, 100 concurrent order
  numbers unique + gapless.
- Docs: `PHASE3_REPORT.md` (evidence + sign-off gate), `ADMIN_USER_GUIDE.md`
  (owner operations, no code edits needed), `backend/README.md`,
  `backend/.env.example`.
- Defects found and fixed by testing: webhook P2002 race, non-atomic
  fulfillment claim, broken attribution query, health endpoints hijacked by
  URI versioning, unsupported proof MIME accepted.

## Phase 4 — WhatsApp integration (delivered 2026-09-24, approved)

- Hardened Meta Cloud API client: typed retryable errors, exponential
  backoff (429/5xx retried, other 4xx fail fast), interactive buttons,
  media upload/send, E.164 normalization.
- Delivery-status webhooks (`sent`/`delivered`/`read`/`failed`) applied to
  stored messages; provider failures schedule a retry.
- Atomic inbound dedupe (create-first on unique message id), atomic
  customer/session creation (advisory lock) — race-tested.
- Outbound retry sweeper with backoff (new `messages` retry columns);
  in-process scheduler runs it every 2 min + subscription expiry every
  15 min.
- OWNER-only diagnostics: `GET /api/v1/admin/whatsapp/status`,
  `POST /api/v1/admin/whatsapp/test-send` (live delivery verification once
  Meta credentials exist).
- Evidence: unit 55/55, WhatsApp E2E **40/40** (simulated conversations in
  EN/Roman-Urdu/Urdu, opt-out silencing, 24h window, 10-way dedupe/session/
  customer races, status webhooks, retry sweeper, proof image flow),
  business E2E 67/67 (no regression), typecheck/lint/build clean, clean boot.
- Defects found and fixed by testing: Meta 500/429 never retried
  (classification was outside the retry loop), admin controller missing
  `AuthModule` in DI.
- Docs: `PHASE4_REPORT.md` (evidence + sign-off gate).

## Phase 5 — n8n automation (delivered 2026-09-24, approved)

- n8n as thin scheduler/dispatcher; backend stays authoritative for
  candidates, timing, opt-in, 24h-window/template policy, atomic claims,
  audits. New `x-service-token` guard (`AUTOMATION_SERVICE_TOKEN`);
  endpoints closed by default (503) when unset.
- Pure dispatch-policy module (free-form needs window, templates need
  opt-in), unit-tested over all 8 combinations.
- New migrations: `orders.abandonment_reminder_stage` (+ stage timestamp),
  `support_tickets.alerted_at`, `subscriptions.renewal_reminder_stage_at`.
- Automation API (`/api/v1/automation/*`): notification dispatch, abandoned
  orders (2h/24h stages, atomic claim, template sends), renewal reminders
  (7d/3d/1d buckets, atomic stage advance, anti-burst gaps), ticket alerts
  (atomic alert claim), expiry sweeper, audited `pg_dump`+gzip backups with
  retention.
- 6 versioned n8n workflow JSONs (`workflows/n8n/`) + README + WhatsApp
  template drafts; structural validation **104/104**.
- Evidence: unit 64/64, n8n E2E **59/59** (10-way abandonment/renewal/ticket
  claim races, real pg_dump backup, retention), WhatsApp E2E 40/40 and
  business E2E 67/67 (no regression), typecheck/lint/build clean, production
  boot with `/health`+`/ready` 200 and guard probes.
- Defects found and fixed by testing: backup endpoint hung when `pg_dump`
  exited before the `close` listener attached (listeners now attached first);
  `AuditLog.entityId` given a non-UUID value; production routes resolved at
  `/api/v1/v1/...` due to global prefix + URI versioning double-up (global
  prefix is now `api`, versioning supplies `v1` — the documented contract).
- **HUMAN ACTION REQUIRED** before live use: deploy n8n, set the service
  token on both sides, import/activate workflows. (2026-09-26: Meta template
  approval no longer applies — Baileys renders message bodies locally from
  the `message_templates` table.)
- Docs: `PHASE5_REPORT.md` (evidence + sign-off gate), admin guide has the
  n8n connection steps.

## Phase 6 — AI agent (delivered 2026-09-24, approved)

- Deterministic stub answers price/order/subscription/FAQ questions from the
  database + knowledge base with no AI key — every price comes from
  `get_plan`, never invented; customers can only see their own orders.
- Exactly 9 restricted tools (allowlist in code); prompt-injection scanning
  (English/Roman Urdu/Urdu), output guards, per-customer rate limiting,
  PII-redacted audit logs, PUBLISHED-only KB grounding with content-word
  search; anything unanswerable escalates to a human with a HIGH ticket.
- Any AI failure returns the deterministic numbered menu (EN/Roman/Urdu) —
  the customer is never stuck.
- OpenAI-compatible embeddings (dormant unless `AI_EMBEDDING_API_KEY` set);
  eval suite `npm run test:ai` **55/55** on real PostgreSQL.
- Admin ticket-alert outbox: atomic claim+enqueue, lease-based delivery
  outside any DB transaction, retry 1m→5m→30m→2h→8h then DEAD with audit
  trail, 1-minute safety-net cron; `ticket-alerts.v2.json` supersedes v1.
- Evidence: unit 75/75, AI E2E 55/55, n8n E2E 88/88 (incl. outbox races),
  business 67/67, WhatsApp 40/40, workflows 99/99, fresh-DB clean migrate +
  verify + seed idempotency, tsc/build clean, production boot 200s on
  `/health`+`/ready` with guard probes.
- **HUMAN ACTION REQUIRED** before live use: choose the AI/embedding
  provider + keys + spend cap (H-7); publish approved KB content (H-10); set
  `ZENSKILL_ADMIN_ALERT_URL` on the backend.
- Docs: `PHASE6_REPORT.md` (evidence + sign-off gate).

## Phase 7 — Payment abstraction (delivered 2026-09-24, approved by owner)

- Completed `PaymentProvider` interface (`createPayment`, `refundPayment`,
  `verifyWebhookSignature`, `parseWebhook`, `getPaymentStatus`) — a future
  card/wallet gateway plugs in without touching the order/fulfillment core.
- Single source of truth for "how do I pay": `GET /api/v1/payments/:id/instructions`
  (amount, owner-configured transfer details from the `payment.instructions`
  setting, deadline, proof guidance) — feeds the WhatsApp flow and the admin
  side; the owner changes accounts without a deploy.
- Payment-window expiry now enforced: 15-minute sweeper (in-process cron +
  `POST /api/v1/automation/payments/expire`) fails past-deadline unpaid
  payments, cancels their orders, moves the customer, writes the audit row —
  idempotent, and never touches payments under human review.
- Invariants tested end-to-end: screenshots/claims can never set PAID;
  amount/currency mismatch → manual review; unverified provider states never
  confirm; sequential + concurrent webhook replay → exactly one confirmation;
  review is OWNER/FINANCE-only with mandatory reason (401/403/201 over HTTP).
- New suite `npm run test:payments` **52/52** on real PostgreSQL; no
  regressions (unit 75/75, business 67/67, WhatsApp 40/40, n8n 88/88,
  AI 55/55, workflows 99/99); tsc/build clean; production boot 200s on
  `/health`+`/ready` with guard probes.
- **HUMAN ACTION REQUIRED** before live use: set `payment.instructions` with
  your receiving accounts (H-6); refund execution stays human
  (bank/wallet + record the reference).
- Docs: `PHASE7_REPORT.md` (evidence + sign-off gate).

## Phase 8 — Fulfillment (delivered 2026-09-24, awaiting sign-off)

- The customer is **never told "delivered" before delivery happened**: the
  `order_fulfilled` notification is queued in exactly one place —
  `FulfillmentService.completeTask()` — and the suite proves the negative at
  payment confirmation, claim, and failure (no notification, order/customer
  not ACTIVE until completion).
- Admin task queue is self-contained: each task snapshots product name, plan
  name, price, and the owner's per-product `fulfillmentNotes` at creation.
  `Product.fulfillmentNotes` is editable via `PATCH
  /api/v1/catalog/products/:id` — this is where the owner defines what each
  product delivers (H-5/G-1), no code, no deploy.
- Lifecycle: payment PAID → task PENDING → admin claim (atomic; concurrent
  claims race, exactly one wins) → complete → order FULFILLED → ACTIVE,
  customer → ACTIVE, subscription stays ACTIVE, customer notified via the
  Phase 5 dispatcher (opt-in + 24h-window enforced). Failure → FAILED →
  idempotent retry → PENDING; mid-flow human decision → MANUAL_REVIEW.
- Worker sweep: 5-minute in-process cron + `POST
  /api/v1/automation/fulfillment/process` (service-token guard) + 7th n8n
  workflow `fulfillment-processor.v1.json`. The manual provider defers every
  task to the admin queue — it never pretends to deliver; a future API
  provider implements `FulfillmentProvider.execute` and the same sweep,
  claims, audits, and notifications apply unchanged.
- New suite `npm run test:fulfillment` **54/54** on real PostgreSQL
  (lifecycle, never-early invariant, retry idempotency, 5-way claim race,
  illegal transitions, manual review, sweep deferral, automation guard
  401/401/201, HTTP RBAC 401/403/201, fulfillment-notes editing + snapshot);
  no regressions (unit 75/75, business 67/67, WhatsApp 40/40, payments 52/52,
  n8n 88/88, AI 55/55, workflows 113/113); tsc/build clean; production boot
  200s on `/health`+`/ready` with guard probes.
- **HUMAN ACTION REQUIRED** before live use: define per-product fulfillment
  notes (H-5). (2026-09-26: no Meta template submission needed — Baileys
  renders the `order_fulfilled` body locally from `message_templates`.)
- Docs: `PHASE8_REPORT.md` (evidence + sign-off gate).

- Completed `PaymentProvider` interface (`createPayment`, `refundPayment`,
  `verifyWebhookSignature`, `parseWebhook`, `getPaymentStatus`) — a future
  card/wallet gateway plugs in without touching the order/fulfillment core.
- Single source of truth for "how do I pay": `GET /api/v1/payments/:id/instructions`
  (amount, owner-configured transfer details from the `payment.instructions`
  setting, deadline, proof guidance) — feeds the WhatsApp flow and the admin
  side; the owner changes accounts without a deploy.
- Payment-window expiry now enforced: 15-minute sweeper (in-process cron +
  `POST /api/v1/automation/payments/expire`) fails past-deadline unpaid
  payments, cancels their orders, moves the customer, writes the audit row —
  idempotent, and never touches payments under human review.
- Invariants tested end-to-end: screenshots/claims can never set PAID;
  amount/currency mismatch → manual review; unverified provider states never
  confirm; sequential + concurrent webhook replay → exactly one confirmation;
  review is OWNER/FINANCE-only with mandatory reason (401/403/201 over HTTP).
- New suite `npm run test:payments` **52/52** on real PostgreSQL; no
  regressions (unit 75/75, business 67/67, WhatsApp 40/40, n8n 88/88,
  AI 55/55, workflows 99/99); tsc/build clean; production boot 200s on
  `/health`+`/ready` with guard probes.
- **HUMAN ACTION REQUIRED** before live use: set `payment.instructions` with
  your receiving accounts (H-6); refund execution stays human
  (bank/wallet + record the reference).
- Docs: `PHASE7_REPORT.md` (evidence + sign-off gate).

## Analysis documents (Phase 1)

1. `analysis/00-spec-analysis.md` — gap analysis, ambiguities, decisions, risks
2. `analysis/01-architecture.md` — system architecture, components, data flows, tech choices
3. `analysis/02-database-erd.md` — full schema, ERD, constraints, seed plan
4. `analysis/03-workflow-map.md` — customer state machine and end-to-end flows
5. `analysis/04-external-dependencies.md` — every external account/secret, with setup cards
6. `analysis/05-threat-model.md` — assets, threats, mitigations
7. `analysis/06-implementation-plan.md` — the 12 phases with exit criteria
8. `analysis/07-human-actions.md` — consolidated REQUIRES HUMAN ACTION checklist

## Operating rules (from the master prompt)

- Business-critical logic is deterministic; the AI assists but never decides
  money, prices, refunds, or configuration.
- The AI answers only from the verified knowledge base; when unsure it
  escalates to human support instead of guessing.
- Prices live in the database; the AI retrieves them, never invents them.
- No integration is ever claimed as working until it has been tested.
- Anything needing an external account, secret, verification, legal decision,
  or human authorization stops at a HUMAN ACTION REQUIRED boundary.
- Never claim affiliation with Udemy, Coursera, Envato, or any third party
  without verified authorization.
