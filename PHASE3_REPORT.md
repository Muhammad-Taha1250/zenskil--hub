# Phase 3 — Backend: delivery report & sign-off gate

**Date:** 2026-09-24 (Asia/Karachi)
**Goal:** `goal_a709fcce2724` — ZenSkil Hub automation platform
**Authorization:** owner approved "start Phase 3 (Backend)" on 2026-09-23 UTC.
**Status: complete — awaiting owner sign-off. Do not begin Phase 4 until signed.**

## What was built

Full NestJS backend (`backend/`, Prisma against `database/`):

- Platform: config with fail-fast env validation, JSON logging, `/health` +
  `/ready` (version-neutral, root paths), helmet, CORS, rate limiting, global
  validation pipe, exception filter.
- Auth: admin login, JWT, RBAC (OWNER/FINANCE/SUPPORT/…), TOTP 2FA with
  AES-256-GCM encrypted secrets.
- Domain: exact 19-state customer state machine; customers, products, plans,
  coupons; draft orders → explicit customer confirmation → final orders;
  manual payment (proof screenshot → private 0600 storage → authorized admin
  approval → `PAID`); provider-abstracted payments with HMAC webhooks,
  append-only event log, idempotent confirmation; fulfillment tasks with
  atomic claims; subscriptions with renewal preserving prepaid time
  (one ACTIVE per product); support tickets; approvals (PRICE_CHANGE,
  REFUND, POLICY_CHANGE, CREDENTIAL_CHANGE) with expiry + stale-price guard;
  manual refunds; notifications; settings/business hours; analytics
  (incl. attribution from the `attributions` table).
- WhatsApp: Meta verification challenge, HMAC-SHA256 signature verification
  (invalid → **401**), payload normalization, opt-in/out, service-window
  rules, deterministic conversation/menu engine.
- AI: exactly 9 permitted tools, ownership-checked per customer, answers only
  from verified KB content, injection guardrails.

## Evidence (all against real PostgreSQL, `zenskill_test`)

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 7 suites / **46 passed** |
| E2E (`npm run test:e2e`) | **67/67 checks**, 84 audit rows |
| Database verify (`database`, `npx tsx tests/verify.ts`) | **22/22 checks** |
| `npm run typecheck` | clean |
| `npm run lint` | clean (typecheck only — ESLint not configured) |
| `npm run build` | clean → `dist/backend/` |
| Clean boot of production build | `/health` 200, `/ready` 200 |
| Clean `prisma migrate deploy` on fresh DB | both migrations applied, 29 tables |
| Seed idempotency | `seed()` × 2, no drift |
| 100 concurrent order numbers | unique, gapless, `ZSH-YYYYMMDD-XXXXX` |

E2E flows covered: order → proof → approval → `PAID` → fulfillment →
subscription; provider webhook idempotency + **10-way concurrent race**
(exactly one confirms); **5-way parallel approval decisions** (one decision,
idempotent side effect); **5-way fulfillment claim race** (one winner,
`ConflictException` losers, `attempts == 1`); renewal preserving prepaid
time; approval retry idempotency; stale `PRICE_CHANGE` rejection; attribution
grouping with paid revenue; WhatsApp verify-challenge (200+echo) / bad token
(403) / bad signature (401) / missing signature (401) / valid signature
(200); AI cross-customer order/payment reads blocked, own reads allowed,
unknown tool rejected.

## Defects found by testing and fixed

1. **Webhook concurrent-delivery race** — two workers could both pass the
   dedupe check; the loser's insert hit unique `eventId` and threw P2002.
   Now caught → reported as `duplicate`; exactly-once processing preserved.
2. **Fulfillment claim was not atomic** — read-then-write allowed two workers
   to both "claim" a task. Now a conditional `PENDING → PROCESSING`
   `updateMany`; losers get `ConflictException`. Proven by the 5-way race.
3. **Attribution query referenced `orders.utm`** — a column that doesn't
   exist. Rewritten against the `attributions` table; proven with a seeded
   row in E2E.
4. **Health endpoints hijacked by URI versioning** — `/health` and `/ready`
   were served at `/v1/health`, invisible to load balancers. Controller is
   now `VERSION_NEUTRAL`; plain `/health`, `/ready` return 200.
5. **Proof storage accepted unsupported MIME** as `.bin`. Now rejected at
   store time (jpg/png/webp/pdf only, ≤10 MB, 0600 files).
6. Earlier in the phase: webhook UUID/human-order-number lookup crash,
   audit `entityId` UUID typing, missing `AuthModule` imports in 13 feature
   modules, `tsx` decorator-metadata DI failure (dev now `ts-node`, E2E
   compiles with `tsc` + runs on node), build output path `dist/backend/`.

## Known limits (stated plainly)

- Approval `decide` uses retry-convergent idempotent side effects, not a
  single atomic transaction across the decision + side effect. Concurrent
  double-decide converges safely (proven), but it is not one atomic unit.
- `npm run lint` is TypeScript checking only; ESLint is not configured.
- `npm install` once needed `--ignore-scripts` after a Prisma engine
  `ECONNRESET`; verify a normal clean install when network access is stable.
- Refund execution is manual by design (see guide).

## HUMAN ACTION REQUIRED (not started, not faked)

Meta Business verification, WhatsApp Business Account, dedicated phone
number, Meta developer app + Cloud API credentials, approved WhatsApp
templates, AI provider/model + key, payment gateway credentials, production
Postgres credentials, SMTP credentials, n8n credentials, VPS, domain/DNS,
private proof object storage + backups, JWT/TOTP secrets for production.

## Owner decisions still open

1. Exact fulfillment definition and delivery mechanism.
2. Day-one bank/JazzCash/Easypaisa workflow confirmation.
3. AI provider/model and secret.
4. Refund policy.
5. Support hours and operators.
6. Approved About/product/delivery/payment/refund/support/legal/FAQ content.
7. Logo, final display name, brand colors.

## Sign-off

- [ ] Owner reviews this report + `ADMIN_USER_GUIDE.md`
- [ ] Owner signs off Phase 3 → Phase 4 (WhatsApp integration) may begin
