# Phase 11 — Testing: Report & Sign-off Gate

Date: 2026-09-24. Owner approved Phase 10 and authorized Phase 11 (Testing) immediately:
"Please proceed to Phase 11 (Testing) immediately."

## Environment events (honest record)

1. **VM rebuilt during Phase 11.** PostgreSQL was gone entirely (no binaries, no
   cluster, no data — same class of event as the 2026-09-24 outage). Reprovisioned
   from local apt cache: postgresql-16 + postgresql-16-pgvector installed via dpkg,
   cluster created, role/DBs recreated, all migrations applied, seed + business-data
   script run. **This reprovisioning surfaced a real defect (see below)** — exactly
   the kind of thing the owner meant by "why live testing was necessary."
2. **Defect found: SQL_ASCII cluster broke Urdu KB search.** The fresh cluster
   defaulted to `SQL_ASCII` encoding (container locale is POSIX). Under SQL_ASCII,
   `to_tsvector('simple', <urdu>)` silently drops every Urdu token (verified:
   only `'24'` indexed), so the AI Urdu KB path returned the generic fallback and
   `test:ai` went 54/55. **Fix:** dropped the cluster, recreated with
   `--locale=C.utf8`, reprovisioned both DBs — now UTF8, Urdu tokens index
   correctly (verified `'ادائیگی':4 'رسائی':3` etc.), `test:ai` back to 55/55.
   **Deployment lesson (carried to Phase 12): production Postgres MUST be created
   with UTF8 encoding / a UTF-8 locale, or Urdu search silently degrades.**
3. **Stale `backend/.env`:** contains no `DATABASE_URL` (tests inject it; boot used
   `database/.env`, which points at a nonexistent `zenskill_dev` — boot needed an
   explicit override to `zenskill_test`). Owner to decide the canonical local-dev
   DB name before deployment config is frozen.
4. **`backend/.env` AI_API_KEY is a placeholder** — the VM rebuild wiped the real
   key the owner supplied on 2026-09-24. **HUMAN ACTION REQUIRED:** owner must
   re-enter the real `AI_API_KEY` in `backend/.env` (chmod 600, gitignored) before
   any live-AI use. Until then the deterministic stub is active (tests prove it).

## §40 — full suite battery (all against live PostgreSQL, UTF8)

| Suite | Command | Result |
|---|---|---|
| Unit (20 suites) | `npm test` | **129/129** |
| Business E2E | `npm run test:e2e` | **67/67** |
| WhatsApp E2E | `npm run test:whatsapp` | **40/40** |
| n8n/automation | `npm run test:n8n` | **88/88** |
| Workflow validation | `npm run test:workflows` | **113/113** |
| AI agent | `npm run test:ai` | **55/55** |
| Payments | `npm run test:payments` | **52/52** |
| Fulfillment | `npm run test:fulfillment` | **54/54** |
| Security | `npm run test:security` | **16/16 PASS, 0 SKIP** |
| §41 staging journey | `npm run test:staging` | **52/52** |

Total: **646 checks, 0 failures.** `tsc`/`lint`/backend build clean; admin
(`next build`) clean; backend boots for real — `/health` 200, `/ready` 200
(DB reachable). Database verification (`tests/verify.ts`): **ALL CHECKS PASSED**
on both `zenskill_test` and `zenskill_fresh`; seed + business-data script
re-run = idempotent (no changes).

AI-suite note: `tests/ai-flow.ts` explicitly blanks `AI_API_KEY` before boot, so
the deterministic stub is guaranteed regardless of `backend/.env` contents
(Phase 11 fix from the first run: 40/55 → 55/55).

## §41 — end-to-end staging journey (52/52)

`backend/tests/staging-flow.ts` boots the full Nest application graph against
`zenskill_test` with an in-memory WhatsApp client and walks one continuous
customer journey:

1. **Greeting/menu** — customer greeted, menu offered.
2. **Product + plan selection** — plan chosen, price read from the live DB.
3. **Summary + explicit `YES`** — draft confirmed only after explicit confirmation.
4. **Payment instructions** — owner's NayaPay details (Chand Zohaib,
   `03709104250`) rendered; proof-upload guidance given.
5. **Screenshot submission → `MANUAL_REVIEW_REQUIRED`** — proof never
   auto-marks PAID (suite asserts PAID is unreachable from this path).
6. **Admin payment approval** — review → approve, payment `PAID`, order advances.
7. **Signed provider webhook + duplicate replay** — exactly one confirmation,
   replay deduplicated (`webhook.duplicate_skipped`).
8. **Fulfillment claim → completion** — atomic claim, task completed, order
   `FULFILLED` → `ACTIVE`, customer + subscription `ACTIVE`.
9. **Renewal reminder** — candidate detected, template reminder queued.
10. **Support ticket + admin reply** — ticket created, authenticated admin reply
    sent over WhatsApp (201 accepted by the test; honest opt-out/24h verdict —
    never phantom delivery).
11. **Audit trail** — `payment.confirmed`, `fulfillment.completed`,
    `webhook.processed`, `webhook.duplicate_skipped` all present.

One test-only fix during the run: the journey asserted HTTP 200 for the new
ticket-reply endpoint; the endpoint correctly returns **201 Created** — the
assertion was corrected (no application change).

## Load / race evidence (Phase 11 requirement)

- **Webhook burst:** 10 parallel deliveries of the same event → exactly one
  confirms, 9 deduplicated, exactly one webhook row, one subscription (e2e Flow
  G1). Security suite: 65-request webhook burst → rate limiter engaged
  (9 × 429 observed), service stays up.
- **Concurrent order numbers:** 100 concurrent generations → unique
  (`database/tests/verify.ts` "order numbers: concurrent uniqueness").
- **Approval race:** 5 parallel decisions → one decision, idempotent side effect.
- **Fulfillment claim race:** 5 parallel claims → exactly one winner
  (`attempts == 1`).
- **Ticket alert race:** covered in Phase 6 n8n suite (no double-send).

## §53 acceptance mapping (evidence, not compilation)

- Deterministic business behavior: AI stub 55/55; every price from DB
  (price-tampering prompts escalate before tool use).
- Money safety: screenshot/manual review can never set PAID (staging S6 +
  payments suite); webhook exactly-once (10-way race + duplicate replay);
  refunds manual-documented; approval idempotency (5-way race).
- Customer honesty: delivery announced only from `fulfillment.completed`
  (staging S8; suite proves the negative at payment/claim/failure);
  opt-out + 24h window honored, verdicts honest (whatsapp 40/40 + staging S12).
- Multilingual: EN/Roman-Urdu/Urdu journeys green; Urdu KB search verified at
  the SQL level after the encoding fix.
- Auditability: append-only audit rows verified per flow (e2e: 87 rows);
  `GET /api/v1/audit-log` live (Phase 9).
- Owner operability: no source changes needed for products/prices/orders/
  payments/subscriptions/support/FAQs/policies (admin panel + catalog PATCH).

## Database hygiene (post-battery)

Suites truncate/reseed `zenskill_test`; after the battery: canonical seed
re-run → `apply-business-data-update.ts` re-run → `tests/verify.ts`
**ALL CHECKS PASSED** (payment.instructions exact keys, 7 × 24/7 business-hours
rows, refund-policy PUBLISHED + chunk). `zenskill_fresh`: clean
`migrate deploy` + seed + verify green; seed idempotency holds.

## Known limits / HUMAN ACTION REQUIRED before go-live

- Owner staging walkthrough on a real deployment (local live-DB testing is not a
  production/staging deployment).
- Re-enter real `AI_API_KEY` in `backend/.env` (placeholder after VM rebuild).
- Production Postgres must be UTF8-encoded (see defect above).
- Decide canonical local-dev DB name (`database/.env` → `zenskill_dev`
  nonexistent; tests/boot use `zenskill_test`).
- Real Meta/WhatsApp connection, template approvals, n8n deploy, secrets,
  2FA, backup drills — as listed in `analysis/07-human-actions.md` and
  `SECURITY.md`.

## Sign-off

Phase 11 testing is complete: 646/646 checks green against a live database,
one real defect found and fixed by the testing itself, full §41 journey
verified end-to-end. **Awaiting owner sign-off. Do not begin Phase 12
(Deployment) without explicit authorization.**
