# Phase 6 — AI agent: delivery report & sign-off gate

**Date:** 2026-09-24 (Asia/Karachi)
**Goal:** `goal_a709fcce2724` — ZenSkil Hub automation platform
**Authorization:** owner approved Phase 5 and authorized Phase 6 immediately on
2026-09-24, and explicitly requested outbox retry for admin ticket alerts
("I want to ensure no customer ticket goes unnoticed").
**Status: complete — awaiting owner sign-off.**

## Architecture decision (the important one)

The AI is an **assistant inside a deterministic machine**, not the machine
itself. Phase 3 already built that foundation (provider-neutral LLM adapter,
exactly 9 restricted tools, injection scanning, output guards, KB-only
grounding, rate limiting, escalation); Phase 6 completes it:

- **No AI provider key is required to run.** With `AI_API_KEY` unset, the
  deterministic stub answers price/order/subscription/FAQ questions from the
  database and knowledge base — never from memory, never invented.
- **Every price in every reply comes from `get_plan` / the database** at
  answer time. Change a plan's price in the admin panel and the AI's answer
  changes with zero code edits. The known price list is not encoded anywhere
  in AI logic.
- **AI failure is a menu, not a dead end.** Any provider error, rate-limit
  hit, injection block, or unanswerable question returns the deterministic
  fallback *plus* the numbered menu options (EN/Roman/Urdu), so the customer
  always has the working menu flow.
- **The 9-tool allowlist is enforced in code**, not in the prompt. Unknown
  tool names throw; the AI cannot approve payments/refunds, change prices,
  delete data, or touch unrestricted DB functions — those capabilities do not
  exist in its tool set.

## What was built

**Admin alert outbox** (`automation/admin-alert.service.ts`, migration
`20260924054500_add_admin_alert_outbox` + `20260924070000_admin_alert_outbox_lease`):
- `admin_alert_outbox` table — one row per ticket (`UNIQUE(ticket_id)`),
  `PENDING | SENT | DEAD`, attempt count, backoff schedule, last error,
  delivery lease (`locked_until`).
- Claim + enqueue + audit are **one database transaction**
  (`AutomationService.claimTicketAlert`) — a crash can never leave a ticket
  marked "alerted" with no queued alert.
- Delivery claims rows with an **atomic lease** (`UPDATE … FOR UPDATE SKIP
  LOCKED` sets `locked_until`); the webhook POST runs **outside any
  transaction**, so a slow admin endpoint never holds a DB lock. Concurrent
  processors never double-send; stale leases from crashed workers are
  reclaimed each sweep (at-least-once after a crash — receivers dedupe on
  `ticket_id`).
- Retry ladder 1m → 5m → 30m → 2h → 8h, max 5 attempts, then `DEAD` with an
  audit trail for human follow-up. Missing `ZENSKILL_ADMIN_ALERT_URL` leaves
  rows PENDING without burning attempts. In-process 1-minute cron safety net
  plus service-token endpoints `POST …/support/alerts/process` and
  `GET …/support/alerts/outbox`.
- `ticket-alerts.v1.json` retired → **`ticket-alerts.v2.json`**: n8n fetches
  unalerted tickets, claims (backend enqueues), then triggers the backend
  processor. n8n never delivers alerts itself anymore.

**PII redaction in AI audit logs** (`ai/pii-redaction.ts`): phone/CNIC/card
digit runs, emails, and sensitive JSON keys (password, cnic, otp, pin, card,
token, secret, api key) are masked in `ai.tool_call` args/results and the
`ai.invocation` reply preview. Prices and order numbers stay readable.

**OpenAI-compatible embeddings** (`knowledge/embeddings.ts`): dormant unless
`AI_EMBEDDING_API_KEY` is set (defaults: `https://api.openai.com/v1`,
`text-embedding-3-small`, 1536 dims matching `vector(1536)`). Write-time
chunk embedding after commit, null-embedding backfill, keyword search
continues on any embedding failure. Service-token endpoints
`POST …/kb/reindex-embeddings` and `GET …/kb/embeddings-status`.

**Deterministic stub intents** (`ai/providers/stub.provider.ts`): order
number → `get_order`; subscription/expiry wording → `get_subscription_status`;
price/plan wording → `get_plan`; everything else → `search_knowledge_base`.
Answers are rendered from tool results only (`answerFromPlans`,
`answerFromOrder`, `answerFromSubscriptions`, `answerFromKb`); tool failure
or no confident answer escalates to a human with a HIGH ticket.

**KB keyword search fix** (`knowledge/knowledge.service.ts`): natural
questions ("What is your refund policy?") previously matched nothing because
`plainto_tsquery` ANDs every word ("what" AND "is" AND "your"…). Search now
extracts content words (unicode tokens, stop words removed for EN/Roman/Urdu)
and OR-matches them, ranked by `ts_rank`. Empty/no-content queries return []
→ the AI escalates instead of guessing. (Found by the Phase 6 eval, fixed in
Phase 6.)

**AI failure → deterministic menu fallback**: `AiService` now reports
`fallback: true` whenever it returns the generic fallback (rate limit,
injection block, output-guard block, no answer, provider error, tool
failure); `ConversationsService.aiAssist()` appends the localized numbered
menu (`T.menuHint`) so the deterministic menu flow takes over.

## Defects found and fixed by testing

| # | Found by | Defect | Fix |
|---|---|---|---|
| 1 | Outbox race test | Row selected with `FOR UPDATE SKIP LOCKED` in a standalone query — the implicit transaction ended before webhook delivery, so two processors could both send the same rows. | Row lock held through select→deliver→update in one interactive transaction. |
| 2 | Design review | `claimTicketAlert` set `alertedAt` before enqueueing in separate operations — a crash between them lost the alert silently. | Claim + enqueue + audit in **one** DB transaction. |
| 3 | Design review | Webhook POST ran while an interactive transaction/row lock was open (15s HTTP timeout vs shorter Prisma tx defaults). | **Lease-based delivery**: atomic lease claim, network I/O outside any transaction, stale-lease recovery each sweep. |
| 4 | AI eval A2/A9 | `plainto_tsquery` AND-semantics: "What is your refund policy?" matched zero docs → every natural question escalated. | Content-word extraction + OR matching + `ts_rank` (`extractSearchTerms`). |
| 5 | AI eval A6/A11 | Per-customer rate limit masked injection-block audits and the provider-error test (21st call returns rate-limit fallback). | Eval uses fresh customers per attack; also proved the rate limiter works. |
| 6 | AI eval A4 | Order-number regex required strict `ZSH-YYYYMMDD-XXXXX`; customer-typed variants (`ZSH-AI-00001`) missed. | Regex accepts canonical + `ZSH-<2-8 alnum>-<2-8 digits>` variants. |
| 7 | AI eval A5 | `\bsubscri\b` never matches "subscription" (no word boundary mid-word) — subscription questions fell through to KB search and escalated. | Prefix matching: `\b(subscri\w*|expir\w*|renew\w*|…)`. |
| 8 | AI eval A2/A4 | Stub-path escalations (no KB answer, order not found/owned) returned `fallback: false` — `aiAssist` would not show the menu. | `fallback` flag now set on every escalation path that breaks to the shared return. |

## Evidence (all against real PostgreSQL `zenskill_test` unless noted)

| Check | Result |
|---|---|
| AI eval (`npm run test:ai`, **new**) | **55/55**: en/roman/ur detection; PUBLISHED-only KB grounding (EN+UR), DRAFT invisible, unknown question → HIGH ticket; exact DB prices (830 / 2,100 / 6,000), no invented numbers; order status+total from DB, foreign order refused; subscription expiry from DB; 16/16 §43 injection attacks blocked + audited; output-guard 6/6; 21st message/min → fallback; KB phone number shown to customer but absent from all audit rows; unknown tool rejected; provider failure → fallback + audited, never throws |
| Unit (`npm test`) | 11 suites, **75/75** (new: pii-redaction 6, embeddings 5) |
| n8n E2E (`npm run test:n8n`) | **88/88**, incl. outbox: claim enqueues exactly one row, reclaim no-op, unique ticket constraint, service-token guard, failure→retry schedule, success→SENT, payload delivered, endpoint processing, status counts, 2-processor race (3 rows sent once each), 5th failure→DEAD, DEAD never retried, missing URL keeps PENDING |
| Business E2E (`npm run test:e2e`) | **67/67**, no regression |
| WhatsApp E2E (`npm run test:whatsapp`) | **40/40**, no regression |
| Workflow validation (`npm run test:workflows`) | **99/99** (ticket-alerts v2 registered, no secrets) |
| Fresh-DB migration (`prisma migrate deploy` on empty `zenskill_fresh`) | all migrations apply cleanly, incl. both outbox migrations |
| DB verify (`database/tests/verify.ts`) on fresh DB | **ALL CHECKS PASSED**; seed idempotent (ran twice) |
| `tsc --noEmit`, `nest build` | clean |
| Production boot (`dist`, real DB) | `/health` 200, `/ready` 200, outbox endpoint 401 without token / 200 with token, KB status endpoint 401 without token, WhatsApp verify 403 on bad token, 0 boot errors |

Note: `npm run lint` has no configured target (ESLint not set up — unchanged
from Phase 5); `tsc` + `nest build` are the static gates.

## Delivered guarantee (outbox)

- No ticket alert is lost because the admin webhook failed: claim and enqueue
  are atomic; delivery retries 1m→5m→30m→2h→8h then goes DEAD *with an audit
  trail* for human follow-up (the DEAD state is visible in the outbox status
  endpoint).
- No alert is delivered twice by two live processors (atomic lease claims,
  verified by the 2-processor race test).
- After a *process crash* mid-delivery, the next sweep reclaims the stale
  lease and redelivers — at-least-once in that corner; receivers should
  dedupe on `ticket_id` (included in every payload).

## HUMAN ACTION REQUIRED before live activation

- **AI provider choice (H-7, still open):** pick the chat provider/model and
  the embedding provider, store `AI_API_KEY` / `AI_EMBEDDING_API_KEY`
  (and `AI_BASE_URL` / `AI_EMBEDDING_BASE_URL` for OpenAI-compatible hosts),
  and define a spend cap. Until then the deterministic stub serves customers
  with DB-backed answers — no key, no model calls, no invented content.
- **Knowledge base content (H-10):** approve and publish the real
  About/product/delivery/payment/refund/support/legal/FAQ documents. The AI
  answers *only* from PUBLISHED docs; unapproved topics escalate to humans.
- **`ZENSKILL_ADMIN_ALERT_URL`:** set the backend env var to the admin
  channel webhook (Slack/Telegram/email). Without it, alerts queue safely but
  nobody is notified.
- n8n: deploy, matching `AUTOMATION_SERVICE_TOKEN` both sides,
  `ZENSKILL_API_BASE_URL`, import/activate the 6 workflows (note
  `ticket-alerts.v2.json` supersedes v1 — do not activate v1).

## Open owner decisions (unchanged from Phase 5)

Fulfillment definition and delivery mechanism; day-one bank/JazzCash/Easypaisa
workflow details; AI provider/model and secret; refund policy; support hours
and operators; approved content; logo, final display name, brand colors.
Drafts and placeholders remain; nothing invented.

**Phase 7 must not begin until this report is explicitly approved.**
