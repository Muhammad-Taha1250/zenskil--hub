# 00 — Specification Analysis (Phase 1)

Date: 2026-09-24. Source: the 55-section master project prompt for ZenSkil Hub.

## 1. What the spec asks for

A production-ready, modular business-automation platform for ZenSkil Hub
(Pakistan, PKR, Asia/Karachi, WhatsApp-first) covering the full customer
lifecycle: discovery → plan selection → order → payment → fulfillment →
active subscription → renewal, plus AI support with human escalation, an
admin panel operable by a non-technical owner, and full security/audit
discipline. Twelve build phases, each gated.

## 2. What is well-defined (strengths of the spec)

- The 19 customer states are enumerated explicitly — a real state machine
  can be built from them without guesswork.
- Exact plan prices are given (PKR 830 / 1,500 / 2,100 / 3,600 / 6,000 for
  1/2/3/6/12 months) with the rule that they live in the database.
- Order ID format is specified (`ZSH-20260918-10482`).
- Payment verification policy is strict and correct: never mark PAID on
  customer claim, screenshot, or button click — only provider webhook or
  authorized admin approval.
- The AI tool allowlist is explicit (9 tools); financial/config decisions are
  explicitly forbidden to the AI.
- 23 minimum tables are named; 12 phases and acceptance criteria are defined.
- §54/§55 draw a hard boundary: stop at external accounts/secrets/legal
  decisions, mark HUMAN ACTION REQUIRED, and wait for approval. This is the
  right rule and it is respected throughout this plan.

## 3. Gaps, ambiguities, and missing requirements

**G-1 — Fulfillment is undefined (highest-impact gap).**
The spec says "the administrator must be able to define exactly what the
customer receives," but never says what the learning service *is* or how it
is delivered (login credentials? invite link? email with access? physical
nothing — it's digital). Without this, fulfillment automation cannot be
designed concretely.
*Resolution:* build fulfillment as a provider abstraction; day one it creates
a manual admin task per order (honest, per §44). The owner defines the
deliverable per product in the admin panel. When the delivery mechanism is
known, an API fulfillment provider can be added without touching order flow.

**G-2 — No payment provider selected.**
Pakistan reality: low card penetration; JazzCash/Easypaisa/bank transfer
dominate; card gateways require merchant onboarding with business
verification. The spec anticipates this (§15: "if manual payment is required
initially").
*Resolution:* day-one `ManualTransferProvider` — show transfer details,
customer uploads proof, status `MANUAL_REVIEW_REQUIRED`, admin approves or
rejects with audit trail. The `PaymentProvider` interface (§14) is built from
day one so a gateway adapter plugs in later with zero changes to order flow.

**G-3 — No AI provider selected.**
"Provider-agnostic LLM layer" is specified but no provider, model, or budget.
*Resolution:* build the `LlmProvider` interface (chat + embeddings + tool
calling); owner chooses the provider and supplies the key (human action).
Embeddings dimension is therefore configurable (pgvector).

**G-4 — Refund policy does not exist.**
Tables and admin flows exist, but no policy: time window, conditions, who
approves, partial refunds.
*Resolution:* ship policy documents as clearly-marked DRAFT templates; owner
finalizes before launch. System enforces: refund requests create
`pending_approvals` rows; only Finance/Owner roles can approve; provider
refund attempted only where supported.

**G-5 — Roles and approval thresholds undefined.**
"Appropriate authorization" is required but roles are not named.
*Resolution:* four roles — Owner, Finance, Support, Viewer. Financial ops
(manual payment approval, refunds, price changes, credential changes, policy
changes, customer deletion) require Finance or Owner; refunds additionally
create a pending-approval record. Support can manage tickets and view orders
but cannot touch money or prices.

**G-6 — `users` vs `customers` overlap.**
The minimum table list contains `users`, `customers`, and `admin_users`
without distinguishing the first two.
*Resolution:* `customers` = the business customer, identity = WhatsApp number
(master record). `users` = optional auth identities for the future website
customer portal (nullable 1:1 link to customers; unused on day one).
`admin_users` = staff. Documented in the ERD.

**G-7 — Knowledge base content is empty.**
The spec demands the AI answer only from verified KB documents, but all
content (About, products, how-it-works, payment methods, refund/delivery/
support policies, terms, privacy, FAQs) must be written by the owner.
*Resolution:* seed the KB tables with titled, empty DRAFT documents and an
admin editor; the AI escalates to support whenever no verified document
covers a question (by design, never hallucinates). KB content is a human
action and a launch blocker for AI quality.

**G-8 — Subscription semantics: durations, not recurring billing.**
Plans are fixed durations; "renewal" = repurchase. Grace period,
proration, and upgrade rules are unspecified.
*Resolution:* expiry = starts_at + plan duration; renewal reminders at
configurable offsets (default 7/3/1 days); configurable grace period
(default 3 days, then EXPIRED). No proration in v1.

**G-9 — Coupons have a table but no customer flow.**
*Resolution:* table ships in Phase 2; redemption (enter code at order
summary) ships in Phase 9 admin/customer work unless the owner wants it
earlier. No code changes needed later either way.

**G-10 — Support agent reply channel.**
"Talk to Support" creates a ticket, but how agents reply is unspecified.
*Resolution:* admin panel includes a ticket inbox; agent replies are sent
through the WhatsApp Cloud API from the business number. Staffing the inbox
and defining business hours are human actions.

**G-11 — n8n placement.**
The spec's diagram puts n8n between the webhook and the backend. Putting a
visual automation tool on the synchronous critical path adds a failure hop.
*Resolution:* follow the spec (n8n receives webhooks first) but keep n8n
workflows *thin*: signature verification, dedupe, normalization, then hand
off to the backend, which is authoritative for the state machine and all
business rules. Synchronous conversation replies go backend → WhatsApp API
directly (latency); scheduled/async work (reminders, notifications, ticket
alerts) is dispatched through n8n so the owner can see and adjust it.

**G-12 — Data retention, privacy, and legal.**
No retention periods, no privacy policy, no terms. Pakistan PECA applies;
no GDPR scope assumed (no EU targeting stated).
*Resolution:* retention periods live in `system_settings` (defaults proposed,
owner confirms); legal documents ship as DRAFT templates clearly marked for
owner/legal review — a launch blocker.

## 4. Decisions (defaults; overridable at the approval gate)

- **D-1** Backend: NestJS + TypeScript (modular, opinionated — matches the
  "modular architecture" requirement and is maintainable by future devs).
- **D-2** ORM/migrations: Prisma (type-safe, migration-based).
- **D-3** Database: PostgreSQL 16 + pgvector for KB embeddings.
- **D-4** Admin: Next.js (App Router), RBAC + TOTP 2FA.
- **D-5** Reverse proxy: Caddy (automatic Let's Encrypt, simpler than Nginx).
- **D-6** Money stored as integer paisa (`price_paisa`), never float.
- **D-7** Timestamps in UTC; Asia/Karachi only at presentation.
- **D-8** Order numbers: `ZSH-YYYYMMDD-#####` with a per-day atomic sequence.
- **D-9** Idempotency keys on webhook intake, payment attempts, fulfillment
  tasks, and notification dispatch.
- **D-10** AI: tool-calling only against the 9 approved tools; RAG over
  versioned KB documents; deterministic price/policy retrieval; system prompt
  hardened per §43 with adversarial eval tests in Phase 11.

## 5. Risks

- **R-1 Meta verification lead time.** Business verification and WhatsApp
  template approvals can take days to weeks. Mitigation: start the Meta
  track *now*, in parallel with the build (checklist in `07-human-actions.md`).
- **R-2 Template rejection/misclassification.** Proactive messages (renewal,
  abandoned order) must use approved templates in the right category and
  language. Mitigation: draft templates early, one language at a time.
- **R-3 24-hour customer-service window.** Free-form replies only inside the
  window; outside it, templates only. The dispatcher enforces this.
- **R-4 Prompt injection.** Customers will try §43-style attacks. Mitigation:
  tool allowlist, no direct DB access, hardened system prompt, eval suite.
- **R-5 Scope size.** Twelve phases is a large build. Mitigation: the gated
  cadence — each phase is independently shippable and signed off.
- **R-6 Owner content bottleneck.** KB copy, policies, and product
  definitions gate AI quality and launch. Mitigation: DRAFT templates and an
  admin editor so the owner can fill them without code.

## 6. Out of scope for v1 (proposed)

- Recurring/auto-debit billing (plans are durations; renewal = repurchase).
- Customer web portal login (`users` table reserved for it).
- Multi-currency (PKR only), multi-brand, multi-number WhatsApp.
- Native mobile apps. Secondary channels (FB/IG/TikTok/YouTube) are
  *tracked as ad sources*, not operated as support channels, in v1.
