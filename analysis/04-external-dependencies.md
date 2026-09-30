# 04 — External-Account Dependency Map (Phase 1)

Per spec §54, every external dependency below stops at a HUMAN ACTION
REQUIRED boundary: what to create, where, what info/credential is needed,
where it goes, how to test it, and security precautions. Nothing here is
assumed done; several items are on the critical path and should start in
parallel with the build.

## Dependency summary

| # | Dependency | Blocks | Lead time | Human action |
|---|---|---|---|---|
| D1 | Meta Business Account + verification | WhatsApp | days–weeks | create + verify business |
| D2 | WhatsApp Business Account + phone number | WhatsApp | days | dedicated number, display name |
| D3 | Meta developer app (Cloud API) | WhatsApp | hours | app, token, webhook |
| D4 | WhatsApp message templates | reminders/proactive msgs | days | submit, get approved |
| D5 | AI provider account + API key | AI agent | hours | choose provider, key, budget cap |
| D6 | Payment rails (manual vs gateway) | payments | manual: none; gateway: weeks | choose path; merchant onboarding if gateway |
| D7 | VPS | deployment | hours | provision, SSH hardening |
| D8 | Domain + DNS | HTTPS/webhooks | hours–1d | buy domain, A record |
| D9 | GitHub | version control | minutes | repo (private) |
| D10 | Backup storage (S3-compatible) | backups | hours | bucket + keys |
| D11 | SMTP (optional) | email notifications | hours | provider account |
| D12 | n8n (self-hosted) | automation | none | none — runs in Compose |

---

### D1 — Meta Business Account + verification ⛔ REQUIRES HUMAN ACTION
1. **Create:** a Meta Business Account at business.facebook.com.
2. **Where:** Meta Business settings → Business info.
3. **Info needed:** legal business name, address, phone, website/domain,
   business documents for verification (requirements vary by country).
4. **Credential:** none directly; the verified account unlocks D2/D3.
5. **Goes:** nowhere in code — it gates the Meta UI.
6. **Test:** Business settings shows "Verified".
7. **Security:** enable 2FA on every Meta admin account; least-privilege
   roles. **Start this now — it is the longest lead-time item.**

### D2 — WhatsApp Business Account + phone number ⛔ REQUIRES HUMAN ACTION
1. **Create:** WhatsApp Business Account under the verified Meta Business;
   connect a phone number.
2. **Where:** Meta Business settings → WhatsApp Accounts.
3. **Info needed:** a **dedicated** phone number (it cannot stay on the
   regular WhatsApp app); display name "ZenSkil Hub" (must follow Meta's
   display-name policy).
4. **Credential:** phone-number verification via OTP during setup.
5. **Goes:** Meta UI only.
6. **Test:** account shows "Connected", test message sendable from Meta UI.
7. **Security:** the number's SIM/eSIM stays under owner control; document
   who can access it.

### D3 — Meta developer app: Cloud API access ⛔ REQUIRES HUMAN ACTION
1. **Create:** app at developers.facebook.com → add the WhatsApp product.
2. **Where:** App Dashboard → WhatsApp → API Setup.
3. **Info needed:** webhook endpoint URL (from D7/D8, e.g.
   `https://<domain>/webhook/whatsapp`).
4. **Credentials:** `WHATSAPP_ACCESS_TOKEN` (system-user token for
   production — never the short-lived test token), `WHATSAPP_PHONE_NUMBER_ID`,
   `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_VERIFY_TOKEN` (a random string
   you invent for the webhook handshake), `WHATSAPP_APP_SECRET` (for
   `X-Hub-Signature-256` verification).
5. **Goes:** production `.env` (never Git); verify-token must match the value
   configured in the Meta app.
6. **Test:** Meta's webhook "Verify and Save" succeeds; send a test message
   to the number and confirm ingress in n8n + backend logs.
7. **Security:** system-user token with minimum scopes; rotate if exposed;
   never paste tokens into chat, docs, or screenshots.

### D4 — WhatsApp message templates ⛔ REQUIRES HUMAN ACTION
1. **Create:** templates for: renewal reminders, abandoned-order reminders,
   payment confirmation, delivery confirmation, support follow-ups — in
   English, Roman Urdu, and Urdu as needed.
2. **Where:** WhatsApp Manager → Message templates.
3. **Info needed:** template text with `{{1}}` variables; correct category
   (utility vs marketing — marketing templates are restricted and cost more).
4. **Credential:** none; approval state tracked in `message_templates`.
5. **Goes:** template names referenced by the dispatcher; bodies live at Meta.
6. **Test:** Meta approval status = Approved; test send per language.
7. **Security/cost:** templates are billable per Meta's conversation pricing
   — the owner should review current WhatsApp Business pricing for Pakistan.

### D5 — AI provider account + API key ⛔ REQUIRES HUMAN ACTION
1. **Create:** account with the chosen LLM provider.
2. **Where:** provider's dashboard → API keys.
3. **Info needed:** which provider/model (decision for the owner; the code is
   provider-agnostic).
4. **Credentials:** `AI_API_KEY` (+ `AI_EMBEDDING_MODEL`,
   `AI_CHAT_MODEL`, `AI_EMBEDDING_DIMENSIONS`).
5. **Goes:** production `.env`; monthly budget cap set in the provider
   dashboard.
6. **Test:** Phase 6 integration test — tool-calling, KB retrieval, and the
   adversarial eval suite (§43 attacks) must pass.
7. **Security:** key rotation procedure documented; per-key spend limits;
   never log prompts containing customer PII beyond the minimum needed.

### D6 — Payment rails ⛔ REQUIRES HUMAN ACTION (decision + possibly onboarding)
- **Day-one (no account needed):** manual bank / JazzCash / Easypaisa
  transfer details shown to the customer + screenshot upload + admin approval
  (§15). The owner supplies the receiving account/wallet details that get
  shown — these live in `system_settings`, not code.
- **Later (gateway):** choose a Pakistan-capable gateway; complete merchant
  onboarding (business verification, bank settlement account); obtain
  `PAYMENT_API_KEY` + `PAYMENT_WEBHOOK_SECRET`. The `PaymentProvider`
  interface is built from day one, so this plugs in without order-flow changes.
- **Security:** webhook secrets verified on every call; amounts re-checked
  against the order; idempotency on everything.

### D7 — VPS ⛔ REQUIRES HUMAN ACTION
1. **Create:** one VPS (2 vCPU / 4 GB RAM minimum to start; Ubuntu LTS).
2. **Info needed:** SSH key (generate locally; never password-only SSH).
3. **Goes:** your inventory only; server provisioned per `DEPLOYMENT.md`
   (Phase 12): Docker, Compose, Caddy, firewall (80/443 only), fail2ban,
   automatic security updates.
4. **Test:** `docker compose up -d` + `/health` green.
5. **Security:** non-root deploy user, SSH key-only, UFW, unattended-upgrades.

### D8 — Domain + DNS ⛔ REQUIRES HUMAN ACTION
1. **Buy:** a domain from any registrar.
2. **Where:** registrar DNS → `A` record pointing at the VPS IP.
3. **Goes:** `DOMAIN=` in `.env`; Caddy obtains Let's Encrypt automatically.
4. **Test:** `https://<domain>/health` returns 200.
5. **Security:** DNS registrar account with 2FA.

### D9 — GitHub ⛔ REQUIRES HUMAN ACTION
Private repo for the monorepo; branch protection on `main`; secrets only in
GitHub Actions secrets if CI is added later. No credentials in the repo — ever.

### D10 — Backup storage ⛔ REQUIRES HUMAN ACTION
S3-compatible bucket (separate provider/region from the VPS ideally);
`BACKUP_S3_*` credentials in `.env`; nightly encrypted `pg_dump` + weekly
restore drill (documented in `BACKUP.md`, Phase 12).

### D11 — SMTP (optional)
Only if email notifications are wanted in v1; otherwise WhatsApp-only.
Any transactional provider; `SMTP_*` in `.env`.

### D12 — n8n
Self-hosted in Docker Compose; no external account. Credentials live in
n8n's credential store (backed by env). Note: n8n Community Edition is
self-hosted under its fair-code license — fine for internal business use.

## Critical path

D1 → D2 → D3 → D4 is the longest chain and the only one that can stall
WhatsApp go-live. **Begin D1 immediately, in parallel with Phase 2.**
Everything else can proceed without it using the WhatsApp simulator and
test doubles built in Phase 4.
