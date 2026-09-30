# ZenSkil Hub — Backend (Phase 3)

NestJS + Prisma + PostgreSQL backend for the ZenSkil Hub autonomous customer &
order management system. Market: Pakistan (PKR, Asia/Karachi). Primary channel:
WhatsApp via Baileys (WhatsApp Web WebSocket — no Meta Cloud API).

## Quick start

```bash
npm install            # if Prisma engine download fails with ECONNRESET, retry with --ignore-scripts
npx prisma generate    # (client is generated from ../database/prisma/schema.prisma)
npm run start:dev      # ts-node dev server on :3000
```

Environment: copy `.env.example` to `.env`. Boot is fail-fast: missing
`DATABASE_URL` crashes immediately; missing `JWT_SECRET` warns in dev and
crashes in production.

## Scripts

| Script | What it does |
|---|---|
| `npm run start` | `node dist/backend/src/main.js` (production build) |
| `npm run start:dev` | `ts-node src/main.ts` |
| `npm run test` | jest unit suites (8 suites, 55 tests) |
| `npm run test:e2e` | compiles with `tsc`, then runs the full lifecycle against `zenskill_test` (67 checks) |
| `npm run test:whatsapp` | compiles with `tsc`, then runs the WhatsApp suite against `zenskill_test` (41 checks, in-memory client, `BAILEYS_DISABLE=true` — no network) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | currently typecheck only — ESLint is not configured yet |
| `npm run build` | `nest build` → `dist/backend/` |

Build output lands in `dist/backend/` because the TS project also compiles
`../database/src/orderNumber.ts`.

## What Phase 3 built

- Config, JSON logging, `/health` + `/ready` (version-neutral, at the root),
  helmet, CORS, rate limiting, global validation pipe, exception filter.
- Admin auth: login, JWT, RBAC (`OWNER`/`FINANCE`/`SUPPORT`/...), TOTP 2FA
  (AES-256-GCM encrypted secrets).
- Exact 19-state customer state machine (illegal transitions rejected).
- Customers, products, plans, coupons, draft orders → explicit confirmation →
  final orders. Prices always read from the DB, integer paisa.
- Manual payment flow: proof screenshot upload → private 0600 storage →
  authorized admin approval → `PAID`. Screenshots never mark payment `PAID`.
- Provider-abstracted payments: complete `PaymentProvider` interface
  (`createPayment`, `refundPayment`, `verifyWebhookSignature`,
  `parseWebhook`, `getPaymentStatus`); HMAC webhook verification, append-only
  event log, idempotent confirmation, concurrent-duplicate race handled;
  amount/currency mismatch → manual review; payment-window expiry sweeper
  (15-min cron + `POST /api/v1/automation/payments/expire`); transfer
  instructions via `GET /api/v1/payments/:id/instructions` from the
  `payment.instructions` setting.
- Fulfillment tasks with atomic claims (exactly one worker wins),
  subscriptions with renewal that preserves prepaid time (one ACTIVE each).
- Support tickets, approvals (PRICE_CHANGE / REFUND / POLICY_CHANGE /
  CREDENTIAL_CHANGE) with expiry + stale-price guard, refunds (manual
  execution), notifications, settings/business hours, analytics.
- AI: exactly 9 tools, ownership-checked (a customer can never see another
  customer's order/payment), answers only from verified KB content.
- WhatsApp via Baileys WebSocket (no public webhook to forge — the legacy
  `/webhooks/whatsapp` route returns 404): QR pairing on first boot,
  session persisted in `BAILEYS_AUTH_DIR`, opt-in/out, service-window
  rules, deterministic conversation engine.

## What Phase 4 added (Baileys refactor 2026-09-26: Meta Cloud API replaced)

- Baileys WhatsApp client (`@whiskeysockets/baileys`): QR pairing printed
  to logs, multi-file auth state, typed retryable errors, exponential
  backoff with jitter (network/retryable errors retried up to 3x, logout
  never retried), interactive messages, media upload + send, JID
  normalization (`<digits>@s.whatsapp.net`).
- Delivery receipts (`sent`/`delivered`/`read`/`failed`) from socket events
  applied to stored outbound messages; statuses move forward monotonically;
  provider `failed` schedules a retry through the backoff path.
- Atomic inbound dedupe (create-first on unique `whatsapp_message_id`),
  atomic customer/session creation (create-first + Postgres advisory lock).
- Outbound retry sweeper: failed sends persist the exact outbound payload
  and are retried with 1m → 5m → 30m → 2h → 8h backoff (max 5 attempts,
  then dead-lettered). In-process `@nestjs/schedule` cron runs it every 2
  minutes and the subscription expiry sweeper every 15 minutes.
- OWNER-only diagnostics: `GET /api/v1/admin/whatsapp/status`,
  `POST /api/v1/admin/whatsapp/test-send` (live delivery probe for the
  real-connection verification step).
- New migration `20260924043500_add_message_retry_fields` and regenerated
  Prisma client (see repo `AGENTS.md` for the sync procedure).

## What Phase 5 added (n8n automation)

- n8n as thin scheduler/dispatcher; backend authoritative for candidates,
  timing, opt-in, 24h-window/template policy, atomic claims, audits.
- Service-token guard (`x-service-token` = `AUTOMATION_SERVICE_TOKEN`;
  401 on bad token, 503 when unset). All endpoints under
  `/api/v1/automation/*`.
- Pure dispatch-policy module + unit tests (free-form needs active window,
  templates need opt-in; 8-combo matrix).
- Migrations: `orders.abandonment_reminder_stage` (+`_at`),
  `support_tickets.alerted_at`, `subscriptions.renewal_reminder_stage_at`.
- Abandoned orders (2h/24h stages, conditional-`updateMany` atomic claim,
  template sends, anti-burst gaps), renewal reminders (7d/3d/1d buckets,
  atomic stage advance), ticket alerts (atomic `alertedAt` claim + admin
  webhook), expiry sweeper delegation, `pg_dump`+gzip backups with retention
  (audited, age-encrypted to `BACKUP_AGE_RECIPIENTS` when set — `.sql.gz.age`).
- 6 versioned n8n workflows in `workflows/n8n/` + validator
  (`npm run test:workflows`, 104/104) + E2E (`npm run test:n8n`, 59/59 incl.
  10-way claim races).
- New env vars: `AUTOMATION_SERVICE_TOKEN`, `BACKUP_DIR`,
  `BACKUP_RETENTION_COUNT` (see `.env.example`).

## What Phase 6 added (AI agent)

- Deterministic stub answers price/order/subscription/FAQ questions from the
  database + knowledge base with no AI key — prices always from `get_plan`,
  never invented; order lookups enforce customer ownership.
- Exactly 9 restricted tools (allowlist enforced in code); injection
  scanning (EN/Roman/Urdu), output guards, per-customer rate limiting,
  PII-redacted audit logs, KB-only grounding (DRAFT docs never served).
- Any AI failure falls back to the deterministic numbered menu
  (EN/Roman/Urdu) — the customer is never left with a dead end.
- OpenAI-compatible embeddings (dormant unless `AI_EMBEDDING_API_KEY` is
  set) + content-word KB search; eval suite `npm run test:ai` (55/55).
- Admin ticket-alert outbox with retry (1m→5m→30m→2h→8h, then DEAD):
  atomic claim+enqueue, lease-based delivery outside any DB transaction,
  1-minute safety-net cron; `ticket-alerts.v2.json` supersedes v1
  (n8n no longer delivers alerts itself).
- New env vars: `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`,
  `AI_EMBEDDING_API_KEY`, `AI_EMBEDDING_BASE_URL`, `AI_EMBEDDING_MODEL`,
  `AI_EMBEDDING_DIMENSIONS`, `ZENSKILL_ADMIN_ALERT_URL` (see `.env.example`).

## What Phase 7 added (Payment abstraction)

- Completed the `PaymentProvider` interface (`createPayment`,
  `refundPayment`) — future gateways plug in without touching the
  order/fulfillment core.
- `GET /api/v1/payments/:id/instructions`: amount + transfer details from
  the `payment.instructions` setting + deadline + proof guidance; the
  WhatsApp flow reads the same method (single source of truth).
- Payment-window expiry sweeper: 15-minute in-process cron plus
  `POST /api/v1/automation/payments/expire` (service token); past-deadline
  unpaid payments → `FAILED`, orders → `CANCELLED`, audited; payments under
  human review are never touched.
- New E2E suite `npm run test:payments` (52/52): mismatch→manual review,
  unverified states never confirm, sequential + concurrent replay → exactly
  one confirmation, HTTP RBAC (401/403/201), expiry paths.

## What Phase 8 added (Fulfillment)

- Completion-only customer notification: `FulfillmentService.completeTask()`
  is the single place that queues the `order_fulfilled` template
  notification — the test suite asserts no delivery message exists at
  payment confirmation, claim, or failure.
- Task payload snapshot at payment confirmation: product name, plan name,
  price, currency, and the product's `fulfillmentNotes`, so the admin queue
  is self-contained.
- `Product.fulfillmentNotes` (new migration + `PATCH /catalog/products/:id`
  support): the owner's per-product "what does the customer receive"
  definition, editable without code.
- Worker wiring: 5-minute in-process cron, `POST
  /api/v1/automation/fulfillment/process` (service token), and the
  `fulfillment-processor.v1.json` n8n workflow. The manual provider defers
  every task to the admin queue; atomic claim (exactly one winner).
- New E2E suite `npm run test:fulfillment` (54/54): full lifecycle,
  never-delivered-early, retry idempotency, 5-way claim race, illegal
  transitions, manual review, sweep deferral, automation guard, HTTP RBAC.

## API surface

`/api/v1/...` for the API; `/health` and `/ready` stay at the root (outside
the versioned prefix on purpose — load balancers hit the plain paths).

Key routes: `/auth/*`, `/customers`, `/catalog/*` (products/plans),
`/coupons`, `/orders`, `/payments/*` (incl. `/:id/proof` download and
`/:id/instructions` for OWNER/FINANCE/SUPPORT/VIEWER), `/fulfillment`, `/subscriptions`, `/support`,
`/approvals`, `/refunds`, `/notifications`, `/settings`, `/analytics`,
`/knowledge`, `/ai`, `/admin/whatsapp`
(`status`, `test-send` — OWNER only), `/automation/*` (service-token only:
notifications/orders/subscriptions/support/payments/maintenance).

## Evidence (Baileys refactor, 2026-09-26)

- Unit: **133/133** green (`npm test`) — incl. Baileys normalization
  (text/media/buttons/lists), status mapping, JID rules (@lid/@g.us/
  malformed rejected — never stripped into fake numbers), QR/open state,
  non-logout reconnect, logout no-reconnect, `fromMe`/history filtering,
  socket send paths (exact JID + body), `creds.update` wiring, template
  rendering (`{{n}}` substitution, fail-loud on unknown template/missing
  variable), and the no-Meta static guard.
- WhatsApp E2E (`npm run test:whatsapp`): **46/46 checks** against real
  PostgreSQL with the in-memory client — simulated order conversation in
  English/Roman Urdu/Urdu, opt-out silencing, 24h window policy, 10-way
  replay-dedupe race, 10-way session race, 10-way customer race, delivery
  statuses, retry sweeper, interactive buttons, proof image flow, raw
  Baileys `messages.upsert` ingress through the real socket-event path
  (notify → persisted + replied; `append` history and `fromMe` ignored),
  plus full template rendering (body persisted and sent verbatim; unknown
  template and missing variable throw).
- Business E2E (`npm run test:e2e`): **64/64** — no regressions.
- n8n E2E 88/88, AI 55/55, payments 52/52, fulfillment 54/54, staging 52/52,
  security 16/16, workflow validator 113/113.
- `npm run typecheck`, `npm run lint`, `npm run build` clean; production
  build boots and serves `/health` + `/ready`.
- Defects found and fixed by testing: Baileys ESM build broke jest's CJS
  resolver → global manual mock via `moduleNameMapper` (`test/mocks/`
  mirrors real enum values); `WhatsappModule` missing `AuthModule` for the
  new admin controller → DI failure at boot; template sends shipped bare
  variable fragments → local rendering from `message_templates` with
  fail-loud semantics; double "PKR" prefix in abandoned/renewal reminder
  variables; `@lid` JIDs stripped into fake phone numbers → rejected at
  normalization; invalid `undefined` version fallback → conditional socket
  options.

## Earlier evidence (Phase 3, 2026-09-24) — kept for history

- Unit: 7 suites / 46 tests green (`npm test`).
- E2E (`npm run test:e2e`): **67/67 checks** against real PostgreSQL —
  order→proof→approval→`PAID`→fulfillment→subscription, webhook idempotency
  + 10-way race, approval 5-way race, fulfillment claim race, renewal
  preservation, attribution, WhatsApp HTTP behavior (401/403/200), AI tool
  ownership.
- `npm run typecheck`, `npm run lint`, `npm run build` clean; production
  build boots and serves `/health` + `/ready`.
- Defects found and fixed by testing: webhook race (P2002 → duplicate),
  non-atomic fulfillment claim → conditional claim, attribution query on a
  nonexistent column, health endpoints hijacked by URI versioning,
  unsupported proof MIME accepted as `.bin` → rejected.

## Boundaries (HUMAN ACTION REQUIRED)

- WhatsApp pairing: scan the QR printed in the server logs
  (WhatsApp → Linked devices); `BAILEYS_AUTH_DIR` on persistent storage;
  exactly one backend replica owns the session.
- AI provider/model choice + API key.
- Payment gateway credentials; refund execution is manual (an approved refund
  must be executed through the bank/wallet provider and the reference recorded).
- Production database credentials, SMTP, n8n credentials, proof-storage
  object storage + backup, VPS, domain/DNS.
- Refund policy, support hours/operators, approved content (About/product/
  delivery/payment/refund/support/legal/FAQ), logo/name/brand colors.
- `npm install` needed `--ignore-scripts` once after a Prisma engine
  `ECONNRESET`; verify a normal clean install when network access is stable.
