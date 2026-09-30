# 07 — Human Action Required (consolidated checklist)

Nothing below is done or assumed. Each item follows spec §54: what, where,
what info, what credential, where it goes, how to test, security precautions.

## A. Start now (parallel track — longest lead times)

### H-1 ⛔ Meta Business Account + verification
See `04-external-dependencies.md` D1. **Begin immediately** — verification
can take days to weeks and gates all WhatsApp work.

### H-2 ⛔ WhatsApp Business Account + dedicated phone number
D2. The number must be dedicated (not your personal WhatsApp). Keep the
SIM/eSIM under your control.

### H-3 ⛔ Meta developer app + Cloud API credentials
D3. Produces `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_VERIFY_TOKEN`,
`WHATSAPP_APP_SECRET` → production `.env` only. Use a system-user token, not
a test token. Test with Meta's "Verify and Save" + a live test message.

### H-4 ⛔ WhatsApp message templates
D4. Needed for: renewal reminders, abandoned-order reminders, payment and
delivery confirmations, support follow-ups — in English, Roman Urdu, Urdu.
Submit early; rejections are common on first try (category/language issues).

## B. Decisions I need from you (answer in chat or at the gate)

### H-5 ⛔ What does the customer actually receive? (G-1)
For each product (starting with the learning service): what exactly is
delivered, and how (login credentials? invite link? email? something else?)?
This determines whether fulfillment can ever be automated. Until you define
it, fulfillment = manual admin task per order (honest, no fake automation).

**Phase 8 update:** the mechanism is ready. Set each product's
**fulfillment notes** via `PATCH /api/v1/catalog/products/:id` (e.g.
`{"fulfillmentNotes": "Enroll the student in the LMS and share the login credentials"}`).
Every new fulfillment task snapshots those notes, so your staff always see
exactly what to deliver in the task queue — no code, no deploy. The
customer only hears "delivered" after an admin completes the task. If you
later define an automatable delivery, an API provider plugs into the
existing `FulfillmentProvider` interface.

### H-6 ⛔ Day-one payment path (G-2)
Confirm: manual bank / JazzCash / Easypaisa transfer + screenshot + your
approval — yes? If yes, send the receiving account/wallet details to display
to customers (they go into `system_settings`, never code). A card gateway is
a later, separate onboarding (business verification required).

**Phase 7 update:** the mechanism is ready. Set the `payment.instructions`
setting (JSON, e.g. `{"JazzCash": "0300-XXXXXXX (Name)", "Bank IBAN":
"PK…"}`) and every WhatsApp payment message plus `GET
/api/v1/payments/:id/instructions` picks it up immediately — no deploy.
Unpaid orders now expire automatically (15-min sweeper, default 24h window
via `PAYMENT_WINDOW_HOURS`). Refund execution stays human: approve in the
queue, move the money via bank/wallet, record the reference.

### H-7 ⛔ AI provider choice (G-3)
Which LLM provider should the system use (or shall I recommend one with
cost/quality trade-offs)? I need the `AI_API_KEY` and a monthly budget cap
set in the provider dashboard.

**Phase 6 update:** the system runs today with *no* AI key — the
deterministic stub answers price/order/subscription/FAQ questions from the
database + KB (eval 55/55). Choosing a provider upgrades answer quality for
open-ended questions; it is no longer a launch blocker for basic operation.
If you also want semantic KB search, provide `AI_EMBEDDING_API_KEY`
(OpenAI-compatible `/embeddings`, 1536 dims); otherwise keyword search is
used.

### H-8 ⛔ Refund policy (G-4)
Time window, conditions, who approves, partial refunds allowed? I'll ship a
marked DRAFT; you finalize before launch.

### H-9 Business hours + support staffing (G-10)
Your support hours (Asia/Karachi) and who staffs the ticket inbox. Outside
hours, tickets queue with an auto-reply.

## C. Content you must provide (KB + policies — launch blockers for AI quality)

### H-10 ⛔ Knowledge base content (G-7)
The AI may only answer from verified documents. I'll seed titled DRAFT
documents; you (or your team) write the real copy in the admin editor:
About ZenSkil Hub · Products · Plans & Prices · How it works · What the
customer receives · Payment methods · Refund policy · Delivery policy ·
Support policy · Terms · Privacy · FAQs. Until a topic is documented, the AI
escalates to support instead of answering — by design.

### H-11 ⛔ Legal documents (G-12)
Terms, Privacy Policy, Refund and Delivery policies ship as clearly-marked
DRAFT templates. Have them reviewed (lawyer if you prefer) before launch.

### H-12 Brand assets
Logo, exact display name "ZenSkil Hub", brand colors for the admin panel and
message formatting.

## D. Infrastructure (before Phase 12)

### H-13 ⛔ VPS (D7)
One VPS (Ubuntu LTS, 2 vCPU / 4 GB RAM minimum), SSH key access, firewall.
Exact setup commands come in `DEPLOYMENT.md`.

### H-14 ⛔ Domain + DNS (D8)
Buy a domain; point an `A` record at the VPS. Caddy provisions HTTPS
automatically.

### H-15 ⛔ GitHub repo (D9)
Private repository for the monorepo.

### H-16 ⛔ Backup storage (D10)
S3-compatible bucket + credentials for encrypted offsite backups.

### H-17 SMTP (optional, D11)
Only if you want email notifications in v1; otherwise WhatsApp-only.

### H-18 ⛔ Self-hosted n8n + automation credentials (Phase 5)
Deploy n8n (Docker on the VPS is fine). Create the `ZenSkil Backend API`
HTTP Header Auth credential (`x-service-token` = a long random secret) and
put the same secret in backend `.env` as `AUTOMATION_SERVICE_TOKEN`.
Set `ZENSKILL_API_BASE_URL` (`https://<domain>/api/v1`), import the six
workflows from `workflows/n8n/` (use `ticket-alerts.v2.json` — v1 is
retired), and activate them. Set `ZENSKILL_ADMIN_ALERT_URL` in the **backend**
`.env` (Phase 6: the backend owns ticket-alert delivery with retry; n8n only
triggers it). Without a matching token, all `/api/v1/automation/*` endpoints
answer 503 by design. Template sends need H-4 approved first.

## E. At launch

- [ ] Complete the setup checklist (§46) — every item verifiable, none assumed.
- [ ] Run a live test order end-to-end (§41 scenario).
- [ ] Enroll admin 2FA; confirm RBAC roles for your team.
- [ ] Confirm renewal/abandoned-reminder timings in settings.
- [ ] Review first-week audit logs and backup restore drill.

**Security precautions for all credentials:** generated/stored in the
provider dashboards, pasted only into the server `.env`, never into chat,
docs, screenshots, or Git. Rotate immediately if ever exposed.
