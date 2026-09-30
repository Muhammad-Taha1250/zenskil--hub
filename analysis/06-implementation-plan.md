# 06 — Implementation Plan (Phase 1)

## Cadence (same as the Betzilla build)

Each phase: **authorize → build → tests green → walkthrough with evidence →
sign-off gate → next phase.** Nothing is announced complete until verified.
Per §55.10, approval is required before any production-destructive change;
analysis and local builds touch nothing external.

## Phase 0 — Approval gate (this document set) ✅ in progress

Deliverables: `00`–`07` analysis docs, project README, tracked project item.
Exit: owner approves architecture (or requests changes). Parallel track:
begin D1 (Meta Business verification) immediately.

## Phase 1 — Architecture ✅ complete

This analysis. Exit: approval to proceed.

## Phase 2 — Database

- Prisma schema for all 27 tables + enums; versioned migrations; per-day
  order-number sequence; seed script (5 plans at exact spec prices,
  product/catalog placeholders, KB DRAFT skeletons, default settings,
  business-hours placeholder).
- Tests: migrations up/down on fresh DB; seed idempotency; unique-constraint
  violations; order-number atomicity under concurrency.
- Human actions: none (all local). Owner *may* start reviewing KB DRAFT titles.
- Exit: `prisma migrate` clean on fresh Postgres; seeds load; tests green.

## Phase 3 — Backend

- NestJS modules: config, database, auth (admin JWT + TOTP + RBAC), customers,
  catalog, orders (state machine + transition table), audit, health/ready,
  system_settings/business_hours, approvals.
- State machine unit-tested: every legal transition + rejection of illegal
  ones (all 19 states).
- Tests: unit (state machine, order numbers, RBAC matrix) + API integration.
- Human actions: none.
- Exit: API boots against real Postgres; health/ready green; tests green.

## Phase 4 — WhatsApp integration

- Cloud API client (send text/buttons/templates/media), n8n
  `whatsapp-ingress` workflow (verify → dedupe → normalize → backend),
  inbound router, greeting/menu handlers (§7), session management, Urdu/Roman
  Urdu/English handling, `ORDER` lookup flow (§17), opt-in/opt-out.
- WhatsApp simulator + test doubles so everything is testable without Meta.
- Tests: signature rejection, replay dedupe, menu flows, language variants,
  opt-out silencing.
- Human actions: **D1–D3 should be underway** (Meta track); no blocking.
- Exit: end-to-end simulated conversation: greeting → menu → product/plan
  browse; real webhook verified once Meta app exists.

## Phase 5 — n8n automation

- Workflows: notification-dispatcher (24h-window + template logic), abandoned
  reminders, renewal reminders, expiry sweeper, ticket alerts, db-backup.
- All workflows exported as versioned JSON in `/workflows/n8n`.
- Tests: each workflow against recorded fixtures; window/template logic matrix.
- Human actions: **D4** — draft message templates for approval.
- Exit: scheduled flows fire correctly in staging; dispatcher respects window
  and opt-outs.

## Phase 6 — AI agent

- `LlmProvider` interface + first adapter; 9 tools implemented against backend
  services (never raw DB); RAG pipeline (chunking, embeddings, retrieval over
  PUBLISHED KB docs); system prompt with §43 hardening; language detection;
  escalation paths; deterministic fallback to menu flow on AI failure.
- Tests: tool allowlist enforcement, KB-grounded answers, price-always-from-DB,
  adversarial prompt suite (§43 patterns), no-PII-in-logs.
- Human actions: **D5** — choose provider, supply `AI_API_KEY`, set budget cap;
  **KB content** — owner writes/approves the DRAFT documents (launch blocker
  for AI quality).
- Exit: eval suite green; AI answers FAQs from KB, escalates when unsure,
  refuses attacks safely.

## Phase 7 — Payment abstraction

- `PaymentProvider` interface (`createPayment`, `getPaymentStatus`,
  `verifyPayment`, `handleWebhook`, `refundPayment`); `ManualTransferProvider`
  (transfer details + proof upload + `MANUAL_REVIEW_REQUIRED`); §16 webhook
  pipeline (12 steps) with idempotency; admin approve/reject with mandatory
  reason + audit.
- Tests: success, failure, replayed webhook (no duplicates), amount mismatch →
  manual review, proof upload flow, unauthorized approval blocked.
- Human actions: **D6** — owner supplies receiving account/wallet details for
  the manual path; gateway decision for later.
- Exit: full simulated payment lifecycle incl. manual review; no duplicate
  processing under replay.

## Phase 8 — Fulfillment

- `FulfillmentProvider` interface; `ManualFulfillmentProvider` (admin task
  queue per order); state transitions PENDING → PROCESSING → COMPLETED /
  FAILED / MANUAL_REVIEW; customer notified only on confirmation.
- Tests: success, failure, retry idempotency, manual completion, "never claim
  delivered early" assertion.
- Human actions: **G-1** — owner defines what the customer receives per
  product (this determines whether an API provider is built later).
- Exit: order → payment → fulfillment → ACTIVE subscription, verified.

## Phase 9 — Admin panel

- Next.js: login + 2FA, dashboard (§26 metrics), catalog CRUD (products/plans/
  prices), order search + detail + payment review queue, fulfillment task
  queue, ticket inbox with WhatsApp replies, KB editor (versioned), coupons,
  refunds + `pending_approvals` queue, settings/business hours, audit log
  viewer, ad-attribution analytics (§22).
- Tests: RBAC page/API matrix, 2FA enrollment/login, approval flows.
- Human actions: owner walkthrough — "can I change a price / add a service /
  approve a payment without code?" (§52 acceptance).
- Exit: §52 checklist passes in the owner's hands.

## Phase 10 — Security

- Apply the threat model (§05): headers, CORS, CSRF, rate limiting, input
  validation everywhere, encrypted TOTP secrets, webhook secrets rotation
  procedure, log redaction audit, backup encryption, dependency audit.
- Tests: the §05.5 security test list, all green.
- Human actions: owner sets admin 2FA; reviews the security doc.
- Exit: security tests pass; `SECURITY.md` complete.

## Phase 11 — Testing

- Full suites from §40 + the §41 end-to-end scenario run against staging:
  WhatsApp greeting → services → product → plan → summary → confirm →
  details → payment → webhook → verified → fulfilled → ACTIVE → renewal
  reminder → support ticket. Every stage asserted.
- Load/smoke: webhook burst, concurrent order-number generation.
- Human actions: owner participates in the staging walkthrough.
- Exit: §53 acceptance criteria all checked.

## Phase 12 — Deployment

- Production Compose, Caddy + Let's Encrypt, `DEPLOYMENT.md` with exact
  commands, `BACKUP.md` + `DISASTER_RECOVERY.md`, runbooks
  (`TROUBLESHOOTING.md`), all docs from §45 incl. `ADMIN_USER_GUIDE.md`
  written for a non-technical owner, setup checklist (§46) with every item
  verifiable.
- Human actions: **D7–D10** — VPS, domain/DNS, GitHub repo, backup bucket;
  paste secrets into production `.env`; run the setup checklist.
- Exit: production health green; test order completed live; owner operates
  the business from the panel.

## What can run in parallel

- Meta track (D1→D2→D3→D4): start now, independent of code.
- Owner content track: KB documents, policies, product definitions,
  fulfillment definition, refund policy — needed by Phases 6/8/9.
- Infra track (D7–D10): any time before Phase 12.
