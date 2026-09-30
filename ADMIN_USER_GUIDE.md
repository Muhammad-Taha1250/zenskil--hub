# ZenSkil Hub — Admin User Guide (Phase 12)

Everything below is done in the **admin panel** web UI
(`https://<your-domain>`), which mirrors the backend API 1:1. The API
endpoints are listed under each section as a reference (for scripting or
troubleshooting) — you don't need them for daily work. Nothing requires
source-code edits. Base URL for API calls: `https://<your-domain>/api/v1`.
Authenticate first (the panel handles this for you; for API calls):

```bash
curl -X POST https://<your-domain>/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@example.com","password":"..."}'
# -> { "accessToken": "..." }  (use -H "Authorization: Bearer <token>")
```

Sign in to the panel and enable 2FA on your account (Account → enable 2FA)
before going live. Roles: `OWNER` (everything), `FINANCE`
(payments/refunds), `SUPPORT` (customers/orders/support). Panel navigation:
Dashboard · Catalog · Orders · Payments · Fulfillment · Tickets · Knowledge ·
Coupons · Refunds · Approvals · Settings · Audit · Attribution · Account.

## Daily operations

### Reviewing payment proofs (manual day-one flow)

1. Customer sends a bank/JazzCash/Easypaisa transfer screenshot on WhatsApp.
2. The proof is stored privately (never a public URL). Open the review queue:
   `GET /payments?status=MANUAL_REVIEW_REQUIRED`.
3. Download the proof: `GET /payments/:id/proof` (OWNER/FINANCE/SUPPORT only).
4. Verify the amount matches the order in your bank/wallet app.
5. Approve or reject: `POST /payments/:id/review` with
   `{"decision":"APPROVE"|"REJECT","reason":"…"}` — **OWNER/FINANCE only,
   reason mandatory**.
6. On approval the payment becomes `PAID`, a fulfillment task is created,
   and the subscription activates. On rejection the payment returns to
   `PENDING` so the customer can send a better screenshot. **The screenshot
   alone never marks a payment PAID — only your approval (or a verified
   provider webhook) does.**

### Setting your receiving accounts (transfer details)

Customers are told where to send money by the `payment.instructions`
setting — change it any time, no code or deploy needed:

1. Open Settings and edit the key `payment.instructions` (JSON object),
   e.g. `{"JazzCash": "0300-1234567 (Your Name)", "Bank IBAN":
   "PK00YOURIBAN"}`.
2. Every new payment message on WhatsApp and `GET /payments/:id/instructions`
   picks it up immediately. Until you set it, customers see an explicit
   "not configured yet" placeholder — nothing is faked.

### Payment expiry (automatic)

Confirmed orders have a payment deadline (`PAYMENT_WINDOW_HOURS`, default
24h). Every 15 minutes the sweeper marks past-deadline unpaid (`PENDING`)
payments `FAILED` and cancels their orders (`payment.expired` in the audit
log). Payments you are already reviewing are never touched. You can also
trigger it manually: `POST /api/v1/automation/payments/expire` (service
token).

### Fulfillment — delivering the service (manual day-one flow)

When a payment is approved, a fulfillment task appears in your queue. **The
customer is NOT told anything about delivery until you complete the task**
— never at payment confirmation. Only your completion sends the delivery
message.

1. Open the queue: `GET /fulfillment/tasks?status=PENDING`. Each task shows
   the order, customer, product/plan, price, and the product's fulfillment
   notes telling you exactly what to deliver.
2. Claim it: `POST /fulfillment/tasks/:id/claim` (OWNER/FINANCE/SUPPORT).
3. Deliver the service in the real world (e.g. create the account, share
   login credentials, send the invite link — whatever the product's
   fulfillment notes say).
4. Complete it: `POST /fulfillment/tasks/:id/complete` with an optional
   `{"note":"..."}`. This moves the order to `ACTIVE`, keeps the
   subscription active, and sends the customer their delivery message
   (through the normal notification rules — opt-in and the 24h window apply).
5. If delivery fails: `POST /fulfillment/tasks/:id/fail` with
   `{"error":"..."}`; fix the problem, then `POST
   /fulfillment/tasks/:id/retry` to put it back in the queue. Retrying is
   safe to repeat.
6. If you need input before delivering: `POST
   /fulfillment/tasks/:id/manual-review` with `{"note":"..."}` (note
   mandatory); complete it from there when ready.

A background worker also scans the queue every 5 minutes (plus
`POST /api/v1/automation/fulfillment/process`, service token). With manual
fulfillment it simply leaves tasks for you — it never pretends to deliver.

### Defining what each product delivers (fulfillment notes)

The task queue tells your staff what to deliver from each product's
**fulfillment notes** — write them once per product, no code needed:

`PATCH /api/v1/catalog/products/:id` with e.g.
`{"fulfillmentNotes": "Enroll the student in the LMS and share the login credentials by email."}`

Every new task snapshots these notes, so the queue stays correct even if
you change them later. Until you define automation for a product,
fulfillment stays a manual task per order — honest, no fake automation.

### Orders & customers

- `GET /orders?status=...` — filter by state; `GET /orders/:orderNumber`.
- `GET /customers` — search; `GET /customers/:id` shows the exact state
  (one of 19). State changes go through guarded transitions only — the API
  rejects illegal jumps.
- Final orders require the customer's explicit confirmation on WhatsApp;
  there is no way to skip it.

### Products, plans & prices

Prices are database-managed — the AI and the checkout always read them from
the DB, never from code.

- `GET /catalog/products`, `POST /catalog/products` (OWNER).
- `GET /catalog/plans`, `POST /catalog/plans` with `pricePaisa` (integer
  paisa, e.g. 83000 = PKR 830).
- Changing a live plan's price creates a **pending approval**
  (`PRICE_CHANGE`) — a second authorized admin must approve it, and the
  approval is rejected if the price moved since the request (stale-guard).
  Day-one learning plans: 1mo PKR 830 / 2mo 1,500 / 3mo 2,100 / 6mo 3,600 /
  12mo 6,000.

### Coupons

`POST /coupons` (OWNER) — set code, discount, usage limits, validity window.
`GET /coupons` lists active/inactive.

### Subscriptions

- `GET /subscriptions?customerId=...` — status, expiry.
- Renewals anchor at the old expiry (prepaid time is never lost); only one
  subscription is ACTIVE per product at a time.
- The expiry sweeper and renewal/expiring-soon reminders run on their
  schedules — configure days via settings (`EXPIRING_SOON_DAYS`,
  `RENEWAL_REMINDER_DAYS`, `EXPIRY_GRACE_DAYS`).

### Refunds

Refunds need an approval (`POST /refunds` → `/approvals/:id/decide`).
**Executing the money movement is manual:** after approval, transfer the
amount through your bank/wallet app, then record the provider reference with
`POST /refunds/:id/record-execution`. The refund policy itself is still an
owner decision — write it down before the first refund.

### Support

- `GET /support/tickets?status=OPEN` — `POST /support/tickets/:id/reply`.
- The AI can create tickets and hand off to a human, but can never resolve
  money issues itself.
- `GET /support/tickets/:id` shows the full conversation.

### Knowledge base / FAQs

- `POST /knowledge/documents` — add; documents start as `DRAFT`.
- Review and publish: `POST /knowledge/documents/:id/publish`.
- The AI answers **only** from published documents. If the answer isn't in
  the KB, it escalates to a human — it will not invent one.
- Approved About/product/delivery/payment/refund/support/legal/FAQ content
  is still pending from you (marked DRAFT until you provide it).
- Tip: write FAQs the way customers ask ("What is your refund policy?") —
  the search matches on content words, so natural questions find the right
  document.

### The AI assistant (Phase 6)

Free-text WhatsApp questions are answered by the AI; the numbered menus keep
working exactly as before. Rules the AI always follows:

- Prices come from your plans in the database — change a price in
  Products/plans and the AI's answer changes immediately, no code needed.
- Order questions need the order number (e.g. `ZSH-20260924-00001`); a
  customer can only see their **own** orders.
- If the AI can't answer confidently, it opens a HIGH-priority support
  ticket and tells the customer a team member will reply — plus it shows
  the numbered menu so they can keep going themselves.
- It speaks English, Roman Urdu, and Urdu automatically.
- It can never approve refunds/payments, change prices, delete anything, or
  claim official partnerships — those requests go to a human.
- Until you choose an AI provider (see "Still pending from you"), a
  deterministic assistant answers from the database + KB — no AI key, no
  invented content.

### Ticket alerts — never miss a ticket (Phase 6)

Every unalerted HIGH/URGENT ticket (and unassigned MEDIUM+) is queued in a
durable outbox and posted to your admin webhook (`ZENSKILL_ADMIN_ALERT_URL`
in the backend `.env`) with automatic retry: 1 minute → 5 minutes → 30
minutes → 2 hours → 8 hours, then marked `DEAD` for human follow-up. A
1-minute safety net runs even if n8n is down.

- `GET /api/v1/automation/support/alerts/outbox` (service token) — see how
  many alerts are pending / permanently failed.
- If `ZENSKILL_ADMIN_ALERT_URL` is empty, alerts queue safely (nothing is
  lost) but nobody is notified — set it before launch.

### Settings & policies

- `GET /settings`, `PATCH /settings/:key` — business hours, messaging
  windows, template toggles. `POLICY_CHANGE` and `CREDENTIAL_CHANGE` go
  through approvals like price changes.
- WhatsApp opt-in/out is honored automatically; the 24-hour service window
  is enforced (outside it, only approved templates go out).

### Analytics

`GET /analytics/overview` (orders/revenue), `/analytics/attribution`
(grouped by marketing source/campaign from the attributions table),
`/analytics/funnel`.

## Safety rules the system enforces (not optional)

- No CNIC, passwords, or full card numbers are ever requested on WhatsApp.
- Payment operations are never blindly retried.
- High-risk actions need an approval + a second authorized human where
  configured; self-approval is blocked when more than one admin exists.
- Every money/state change writes an append-only audit row — nothing is
  edited or deleted afterward.
- Logs never contain credentials, secrets, or card data.

## Automated reminders & n8n (Phase 5)

n8n acts as a scheduler — it calls the backend's `/api/v1/automation/*`
endpoints with a service token (`x-service-token` header,
`AUTOMATION_SERVICE_TOKEN` in `.env`). The backend decides who is due,
enforces opt-in and the 24-hour/template policy, and audits everything.

What runs automatically once n8n is connected:

- **Abandoned-order reminders** (every 30 min): `AWAITING_PAYMENT` orders get
  template reminder 1 after 2 hours, template reminder 2 after 24 hours.
  Opted-out customers never get them.
- **Renewal reminders** (daily 09:00): subscriptions expiring in 7 / 3 / 1
  days get a renewal template nudge. Stages never fire back-to-back — a
  20-hour gap is enforced.
- **Notification dispatcher** (every 5 min): anything queued by the system
  (payment confirmations, support follow-ups) is sent respecting the
  window/template rules.
- **Ticket alerts** (every 5 min): unalerted HIGH/URGENT tickets (and
  unassigned MEDIUM+) are queued in a durable outbox; the backend posts to
  your admin webhook with retry (1m→5m→30m→2h→8h, then DEAD for human
  follow-up). No failed webhook can silently lose a ticket.
- **Expiry sweeper** (every 15 min): subscriptions move to `EXPIRING_SOON` /
  `EXPIRED` on schedule.
- **Database backup** (nightly 02:00): `pg_dump` + gzip into `BACKUP_DIR`,
  age-encrypted to `BACKUP_AGE_RECIPIENTS` (`.sql.gz.age`) when set —
  plaintext (`.sql.gz`) with a loud `BACKUP UNENCRYPTED` warning logged and
  audited when unset; keeps the newest 7, audited as `maintenance.db_backup`.

**HUMAN ACTION REQUIRED** — connecting n8n (do this once, in this order):

1. Deploy self-hosted n8n (Docker on your VPS is fine).
2. In n8n, create an **HTTP Header Auth** credential named exactly
   `ZenSkil Backend API`: header `x-service-token`, value = a long random
   secret you generate.
3. Put the **same** secret in the backend `.env` as
   `AUTOMATION_SERVICE_TOKEN` and restart the backend. (If the backend
   variable is empty, every `/api/v1/automation/*` endpoint answers 503 —
   closed by default.)
4. In n8n, set the workflow variable / env value:
   `ZENSKILL_API_BASE_URL` (e.g. `https://<your-domain>/api/v1`).
   (`ZENSKILL_ADMIN_ALERT_URL` is a **backend** `.env` variable since the
   Phase 6 outbox — the backend owns alert delivery with retry; n8n only
   triggers processing.)
5. Import the six workflows from `workflows/n8n/` (use
   `ticket-alerts.v2.json` — v1 is retired), assign the
   `ZenSkil Backend API` credential where prompted, and activate them.
6. No message templates to approve — Baileys sends WhatsApp text directly
   (draft texts still in `workflows/n8n/message-templates.draft.md` for
   reference). The backend still enforces opt-in/out, the 24-hour service
   window, and the per-customer send cap.

You never need to edit the workflows to change *who* gets reminded — that
logic lives in the backend. n8n only controls *when* the checks run.

## When something looks wrong

1. `GET /analytics/overview` — is revenue/orders sane?
2. Check the audit trail for the entity (`GET /audit?entityType=...`).
3. Webhook deliveries: `GET /webhooks/events` — duplicates are normal and
   deduplicated; failures are logged with payloads.
4. If the app won't boot, it fails fast and says which env var is missing
   (see `backend/.env.example`).

## Connecting the real WhatsApp (QR pairing)

**HUMAN ACTION REQUIRED** — the code is ready; these are your steps. No
Meta Business verification, no developer app, no tokens:

1. Set `BAILEYS_AUTH_DIR` in the backend `.env` to a **persistent disk**
   path (see `DEPLOYMENT.md` §6). Restart the backend and watch the logs —
   a QR code is printed on first boot.
2. On the business phone: WhatsApp → Linked devices → Link a device, then
   scan the QR from the logs.
3. Verify the connection: log in as OWNER and call
   `GET /api/v1/admin/whatsapp/status` — `connected` should be `true` and
   `awaitingQrScan` `false`. Then `POST /api/v1/admin/whatsapp/test-send`
   with `{ "to": "<your own number>" }` — you should receive the test
   message on WhatsApp within seconds. If `ok` is `false`, the `error`
   field says what went wrong.
4. Send a message to the business number and confirm the bot replies;
   check `GET /api/v1/admin/whatsapp/status` and the audit log if not.

⚠️ Baileys is unofficial: keep the phone online, run exactly one backend
replica, and never delete `BAILEYS_AUTH_DIR` unless you intend to re-pair.
If the session is revoked (backend logs say "logged out"), wipe the auth
dir contents, restart, and scan the fresh QR.

Operational notes:

- Failed outbound sends retry automatically (1m → 5m → 30m → 2h → 8h,
  max 5 attempts, then dead-lettered). Messages stuck `FAILED` with no
  `next_retry_at` need your attention — check the `error_code` on the
  message row.
- Free-form replies only go out inside the 24-hour customer-service
  window; outside it, only approved templates to opted-in customers.
  Blocks are recorded in the audit log (`whatsapp.send_blocked`).
- Delivery receipts (`sent`/`delivered`/`read`/`failed`) update each
  outbound message's status automatically.
- Customers can STOP/START any time; opt-out is honored immediately.

## Security — your responsibilities (Phase 10)

The system enforces a lot automatically (see `SECURITY.md` for the full
posture), but these items need **you**:

- **Turn on 2FA for every admin account** (panel → Account → enable 2FA)
  before going live. This is the single most important step.
- **If you suspect an account is compromised:** sign in as OWNER, open the
  sidebar and choose "Sign out" — this revokes *all* sessions for that
  account immediately. Then change the password and check the Audit log
  for unfamiliar actions.
- **Lockouts:** 5 wrong password attempts lock an account for 15 minutes.
  This is brute-force protection working as intended — don't "fix" it by
  restarting the server.
- **Backups:** nightly database backups are now **encrypted**. You need to
  generate the encryption keys once (see `SECURITY.md` §12 — two keypairs:
  primary + offline escrow) and put the public keys in
  `BACKUP_AGE_RECIPIENTS`. The private keys live only in your password
  manager — never on the server. Until you set this, backups are plaintext
  and the system warns loudly in the logs.
- **Restore drill:** once a quarter, restore the newest encrypted backup to
  a throwaway database and confirm it works (alternating server/offsite
  copies). An untested backup is not a backup.
- **Review `SECURITY.md`** and accept the residual risks, including the
  planned Next.js 15 upgrade (23 advisories on the current version; the
  panel is internal-only, which mitigates them, but the upgrade should be
  scheduled).

## Still pending from you (HUMAN ACTION REQUIRED)

The full owner checklist with verification steps is `SETUP_CHECKLIST.md`
(section D). In short: the business WhatsApp number + QR pairing (no Meta
app needed), AI provider/model/key
(+ embedding key if you want semantic KB search — keyword search works
without it), `ZENSKILL_ADMIN_ALERT_URL` (admin webhook for ticket alerts),
payment gateway credentials, production DB/SMTP/n8n credentials, VPS +
domain/DNS, proof object storage + backups, refund policy, support
hours/operators, approved content, logo/name/brand colors.
