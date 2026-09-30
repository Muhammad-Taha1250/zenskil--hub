# Phase 7 — Payment abstraction: delivery report & sign-off gate

**Date:** 2026-09-24 (Asia/Karachi)
**Goal:** `goal_a709fcce2724` — ZenSkil Hub automation platform
**Authorization:** owner approved Phase 5 **and** Phase 6 on 2026-09-24 and
authorized Phase 7 (Payment Abstraction) immediately.
**Status: complete — awaiting owner sign-off.**

## Architecture decision (the important one)

Phase 3 built the money core (state machine, §16 webhook pipeline, manual
review with mandatory reason, transactional confirmation). Phase 7 finishes
the **abstraction around it** — the provider contract is now complete, and
every path money can take is either automated-with-proof or
human-with-audit-trail:

- **The `PaymentProvider` interface is complete**: `createPayment`,
  `refundPayment`, `verifyWebhookSignature`, `parseWebhook`,
  `getPaymentStatus`. A future card/wallet gateway implements the same five
  methods — the order/fulfillment core never changes.
- **The customer always knows exactly what to do.** `createPayment` for the
  manual provider returns amount + owner-configured transfer details +
  deadline + proof guidance. One service method (`getPaymentInstructions`)
  feeds the WhatsApp flow *and* the new admin endpoint — the transfer details
  live in the `payment.instructions` setting (D6/H-6), never in code, and can
  be changed by the owner without a deploy.
- **Unpaid orders now actually expire.** `paymentExpiresAt` was set on every
  confirmed order since Phase 3 but nothing enforced it — an order could sit
  in `AWAITING_PAYMENT` forever. The new sweeper fails the payment, cancels
  the order, moves the customer out, and writes the audit row. It is
  idempotent and deliberately spares payments a human is already reviewing.
- **The invariants still hold, and are now tested end-to-end:** customer
  input (screenshots, claims, button clicks) can never set PAID; webhook
  claims are re-verified with the provider; amount/currency mismatch routes
  to manual review instead of auto-confirming; replayed webhooks confirm
  exactly once; only OWNER/FINANCE can approve, with a mandatory reason.

## What was built

**Completed provider interface** (`payments/providers/payment-provider.interface.ts`):
- `createPayment(input)` → `PaymentInstructions` (provider, amountPaisa,
  currency, deadline, transferDetails, proofGuidance). `ManualTransferProvider`
  reads the transfer details from the `payment.instructions` setting via an
  injected source; without one it returns the explicit DRAFT placeholder —
  it never invents account numbers.
- `refundPayment(paymentId)` → `RefundDescriptor { mode, detail }`. Manual
  mode documents the day-one reality: a human moves the money through the
  bank/wallet and records the provider reference via the refunds module's
  `markExecuted` (which already exists and is approval-gated).

**Payment instructions** (`PaymentsService.getPaymentInstructions` + `GET
/api/v1/payments/:id/instructions`, OWNER/FINANCE/SUPPORT/VIEWER):
- Single source of truth for "how do I pay": amount, transfer details,
  deadline, proof guidance.
- The WhatsApp conversation flow (`confirmDraftOrder`) now calls it instead
  of its own settings read — one code path, no drift. The unused
  `SettingsService` injection was removed from `ConversationsService`.

**Payment-window expiry sweeper** (`PaymentsService.runPaymentExpirySweeper`):
- Finds `PENDING` payments whose order `paymentExpiresAt` passed and whose
  order is still `AWAITING_PAYMENT`; per payment, in one transaction: payment
  → `FAILED` ("Payment window expired without proof"), order → `CANCELLED`,
  `payment.expired` audit row. Re-checks status inside the transaction so a
  proof/approval that landed concurrently wins the race.
- Moves the customer `AWAITING_PAYMENT` → `CANCELLED` when the state machine
  allows it (best-effort; money state is already final).
- **Deliberately spares** `MANUAL_REVIEW_REQUIRED` (a human is handling it),
  future-deadline, and `PAID` payments.
- Runs on the in-process cron every 15 minutes (`SchedulerService`,
  alongside the subscription sweeper) and via the service-token endpoint
  `POST /api/v1/automation/payments/expire` for n8n.

**Module wiring**: `PaymentsModule` imports `SettingsModule` (transfer
details); `SchedulerModule` and `AutomationModule` import `PaymentsModule`.
No dependency cycles (verified by clean production boot).

## Defects found and fixed by testing

- **Stale JWT env vars in test setup**: the test harnesses set
  `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`, but the app only reads
  `JWT_SECRET` — HTTP login in tests returned 500 (`secretOrPrivateKey must
  have a value`). Fixed in the new suite (uses `JWT_SECRET`); the old vars
  are dead everywhere in `src/`. Worth a cleanup pass later.
- **Test DB password drift**: the `zenskill` DB role's password no longer
  matched any suite's hardcoded URL (all four pre-existing suites use
  `zenskill_dev`). Reset to `zenskill_dev` and aligned the new suite —
  convention restored.
- **Nest POST defaults**: review/automation POST endpoints return 201, not
  200 — test expectations corrected (behavior is correct; the earlier
  suites' 200-vs-201 fixes in Phase 5 were the same class of issue).

## Evidence (all against real PostgreSQL `zenskill_test` unless noted)

| Check | Result |
|---|---|
| Payment flow (`npm run test:payments`, **new**) | **52/52**: instructions carry owner-configured transfer details + amount + deadline; bare provider returns DRAFT placeholder; proof→review→approve→PAID with audit triple (proof_submitted, manual_approved, confirmed); reason mandatory; proof on PAID rejected; double-approve blocked; reject→PENDING + reason recorded; amount mismatch→manual review (never auto-confirmed); currency mismatch→manual review; unverified PENDING/FAILED→pending_verification (never confirmed); bad webhook signature rejected; sequential + concurrent replay→exactly one confirmation; HTTP 401 unauthenticated / 403 SUPPORT / 201 OWNER on review; instructions 401/200; automation expire 401/201; sweeper expires past-deadline PENDING→FAILED + order CANCELLED + customer CANCELLED + audit, idempotent, spares under-review/future/PAID |
| Unit (`npm test`) | 11 suites, **75/75**, no regression |
| Business E2E (`npm run test:e2e`) | **67/67**, no regression |
| WhatsApp E2E (`npm run test:whatsapp`) | **40/40**, no regression (validates the centralized instructions refactor) |
| n8n E2E (`npm run test:n8n`) | **88/88**, no regression |
| AI eval (`npm run test:ai`) | **55/55**, no regression |
| Workflow validation (`npm run test:workflows`) | **99/99** |
| `tsc --noEmit`, `nest build` | clean |
| Production boot (`dist`, real DB) | `/health` 200, `/ready` 200, `POST …/automation/payments/expire` 503 without token configured (guard), `GET …/payments/:id/instructions` 401 without auth, 0 boot errors |

Note: `npm run lint` still has no configured target (ESLint not set up —
unchanged); `tsc` + `nest build` are the static gates.

## Delivered guarantee (payments)

- **No money moves on customer say-so.** Screenshots, claims, and button
  clicks can only put a payment into `MANUAL_REVIEW_REQUIRED`; PAID requires
  a verified provider webhook or an OWNER/FINANCE decision with a written
  reason. Tested: proof on PAID rejected, double-approve blocked.
- **No silent auto-confirmation.** Amount or currency mismatch routes to
  manual review; unverified provider states stay pending. The webhook claim
  is never trusted alone (independent `getPaymentStatus` check).
- **No double-processing.** Webhook dedupe by event id (append-only) and by
  transaction idempotency key; concurrent duplicate delivery confirmed
  exactly once by test.
- **No zombie orders.** The payment window is now enforced: unpaid orders
  expire to `CANCELLED` with a full audit trail, and the sweeper is safe to
  run as often as scheduled.
- **The owner can change how customers pay without code.** Transfer details
  (`payment.instructions` setting), prices (catalog), and the payment window
  (`PAYMENT_WINDOW_HOURS`) are all configuration.

## HUMAN ACTION REQUIRED before live activation

- **H-6 (D6) — receiving account/wallet details**: the mechanism is ready.
  Set the `payment.instructions` setting (Settings → `payment.instructions`,
  JSON like `{"JazzCash": "0300-XXXXXXX (Account Title)", "Bank IBAN":
  "PK…"}`) and every payment message + the admin instructions endpoint
  picks it up immediately. Until you set it, customers see the explicit
  DRAFT placeholder — nothing is faked.
- **H-7**: unchanged — AI provider key optional (stub runs without one).
- **H-5 (G-1)**: unchanged — fulfillment definition still pending (Phase 8).
- Real Meta/WhatsApp connection still pending (unchanged from Phase 4).
- Refund execution remains human: approve in the refunds queue, execute
  through the bank/wallet, record the provider reference
  (`refunds.markExecuted`).

## Sign-off

Phase 7 acceptance per the implementation plan: full simulated payment
lifecycle including manual review — **done** (52/52 payment tests, all
suites green, production boot clean). No duplicate processing under replay
— **done** (sequential + concurrent replay tests). Awaiting owner sign-off
before Phase 8 (Fulfillment).
