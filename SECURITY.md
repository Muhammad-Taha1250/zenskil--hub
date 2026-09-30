# ZenSkil Hub — Security Posture (Phase 10)

Date: 2026-09-24. This document applies the threat model from
`analysis/05-threat-model.md` and records exactly what is implemented,
what is accepted risk, and what the owner must still do.

## 1. Threat model coverage

| Threat | Mitigation | Status |
|---|---|---|
| T1 Webhook forgery | HMAC verification on payment webhooks; 401 on invalid; primary+secondary secret rotation support. The WhatsApp webhook was removed in the Baileys refactor — no public ingress exists to forge against (404 on the legacy path, asserted in the security suite) | Implemented Phase 10, updated Baileys refactor |
| T2 Replay attacks | Atomic dedupe by provider event/message ID (`webhook_events.event_id` unique → 200 + DUPLICATE); idempotency keys on payments/fulfillment | Phases 3–5 |
| T3 Prompt injection | 9-tool allowlist, injection scanner (EN/Roman/Urdu), output guards, PII-redacted audit; §43 eval suite | Phase 6 |
| T4 AI hallucination | PUBLISHED-only KB grounding; prices only from DB; mandatory escalation script | Phase 6 |
| T5 Fake payment claims | PAID requires verified webhook or admin approval; screenshots → MANUAL_REVIEW_REQUIRED | Phases 3, 7 |
| T6 Admin takeover | argon2id hashing (bcrypt legacy rehash on login), TOTP 2FA, RBAC, login lockout, token-version revocation, audit | Phases 3 + 10 |
| T7 SQL injection | Prisma parameterized queries only; global ValidationPipe; SQLi test cases | Phases 3 + 10 |
| T8 Secret leakage | Env-only config; log redaction; secrets never in code/logs/exports | Phases 3 + 10 |
| T9 Insider abuse | Least-privilege roles; mandatory reason + pending_approvals; immutable audit | Phases 3, 9 |
| T10 Proof tampering | Private proof storage, signed expiring URLs, hash stored, decision audit | Phase 3 |
| T11 Social engineering | Order-number + WhatsApp-number identity check; no money ops from chat | Phase 8 |
| T12 Backup theft/loss | age-encrypted backups, retention, offsite copy, restore drill | Phase 10 |
| T13 Supply chain | Lockfiles committed; npm audit in CI policy; pinned images (Phase 12) | Phase 10 |
| T14 WhatsApp policy | Opt-in/out honored; 24h window; per-customer rate caps. Baileys sends text directly (no Meta template registry); outbound policy stays backend-enforced | Phases 4 + 10, Baileys refactor |

## 2. HTTP headers & transport

- Backend (`backend/src/main.ts`): `helmet()` with defaults (HSTS,
  X-Frame-Options SAMEORIGIN, X-Content-Type-Options, Referrer-Policy, etc.).
- Admin panel (`admin/next.config.mjs` `headers()`): HSTS (production),
  X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy
  strict-origin-when-cross-origin, minimal Permissions-Policy.
- TLS terminates at the reverse proxy (Phase 12: Caddy + Let's Encrypt).
  Cookies are `Secure` in production.

## 3. CORS policy

- Backend: `app.enableCors({ origin: <CORS_ORIGINS allowlist>, credentials: true })`.
  Default `http://localhost:3001`. **Production must set `CORS_ORIGINS` to the
  exact admin-panel origin(s) — never `*` with credentials.**
- The admin panel calls the backend only through its same-origin
  `/api/admin-proxy/*` route, so browsers never cross origins in practice.

## 4. CSRF protection

Cookie-authenticated admin panel → CSRF is a real threat (a malicious site
could trigger the browser to send the session cookie).

**Implemented: double-submit cookie** in the admin panel (Next.js):

- `GET /api/auth/csrf` issues a 256-bit random token, sets it as a readable
  (non-httpOnly) `csrf_token` cookie, and returns it in the body.
- `lib/api-client.ts` attaches `X-CSRF-Token` on every state-changing
  request (POST/PATCH/PUT/DELETE), refreshing + retrying once on
  `csrf_mismatch`.
- `app/api/admin-proxy/[...path]/route.ts` rejects mismatches with 403
  **before any backend call** (constant-time comparison). Same check guards
  `POST /api/auth/session`.
- `SameSite=lax` on the session cookie is the second layer; the custom
  header covers older/non-conforming clients.

**Why double-submit, not synchronizer tokens:** the Next.js layer is
deliberately stateless (the session IS the backend JWT; no Redis/session
store). Double-submit counters exactly the CSRF threat model — the attacker
can make the browser *send* cookies but cannot *read* them (same-origin
policy) — without adding a stateful component.

**Out of scope (documented):** XSS (CSRF tokens are not an XSS defense;
React escaping + helmet + security headers are), login CSRF (no session
exists to bind to; forcing login as the attacker's account gains nothing on
an admin-only panel), direct backend CSRF (backend accepts Bearer headers
only — not CSRF-able by construction). Future hardening: `__Host-` prefix
for the CSRF cookie if subdomains ever serve untrusted content.

## 5. Authentication & sessions

- Passwords: **argon2id** for new hashes; legacy bcrypt (cost 12) hashes
  verify and are rehashed to argon2id on next successful login.
- TOTP 2FA: secrets encrypted at rest (`totp-crypto.ts`); enrolment is
  two-step (setup → verify → enable); disable requires password + code.
- Login: 10 req/min throttle + **account lockout** — 5 consecutive failures →
  15-minute lockout (generic error message, no user enumeration); every
  failure and lockout audited (`auth.login_failed`, `auth.login_locked`).
- JWT: 8h absolute expiry (`JWT_EXPIRES_IN`); payload carries `tv`
  (token version). `POST /auth/logout-all` bumps the version and revokes all
  sessions (e.g. after password change or suspected compromise).
- Admin session cookie: httpOnly, `SameSite=lax`, `Secure` in production,
  12h maxAge (`admin/app/api/auth/login/route.ts`).
- Idle timeout: JWTs are stateless; there is no server-side idle expiry.
  The 8h absolute expiry plus logout-all revocation is the accepted control
  (documented tradeoff).

## 6. Authorization

- RBAC: OWNER / FINANCE / SUPPORT / VIEWER. Backend is the authority on every
  request (JwtAuthGuard + RolesGuard); the panel only hides UI.
- Least privilege: SUPPORT cannot touch money/prices; financial actions need
  mandatory reason + `pending_approvals` where applicable.

## 7. Rate limiting

- Global: 120 req/min per IP (ThrottlerModule).
- Login: 10 req/min **per (IP, account)** + lockout (see §5). The bucket key
  is per-account (`AppThrottlerGuard.getTracker`) because a shared per-IP
  bucket lets one attacker's burst 429 innocent users behind the same
  carrier-grade NAT IP — the norm on Pakistani mobile networks. Targeted
  brute force is still stopped by the per-account lockout; IP-level floods by
  the global 120/min backstop.
- Webhooks (WhatsApp + payment): 60 req/min each — legitimate provider
  traffic is far below this; bursts are attacker-shaped. Webhook responses
  are always HTTP 200 (first delivery and `DUPLICATE` replays alike); any
  2xx means "received, do not retry".
- Automation endpoints: service-token guarded + 120 req/min.
- Per-customer WhatsApp sends: capped at `WHATSAPP_MAX_PER_CUSTOMER_PER_HOUR`
  (default 30); trips audited.

## 8. Input validation

- Global `ValidationPipe`: `whitelist: true` (strips unknown props),
  `forbidNonWhitelisted: true` (rejects them), `transform: true`.
- Every controller DTO carries `class-validator` decorators (sweep verified
  Phase 10); query params use DTOs; webhook payloads validated after HMAC
  verification; file uploads restricted by MIME + size (Phase 3).
- Prisma parameterized queries exclusively — no string-concatenated SQL
  (asserted in the security suite).

## 9. Webhook secrets & rotation

Secrets are read from the environment **at boot** — there is no hot-reload.
Rotation needs a rolling restart but causes **zero rejected webhooks** when
done in order, because verification accepts primary OR previous secret.

- **Payment gateways** (future): `PAYMENT_WEBHOOK_SECRET[_PREVIOUS]`
  convention; helper `verifyHmacSha256(rawBody, header, [primary, previous])`
  (`backend/src/common/utils/webhook-hmac.util.ts`) — constant-time, fails
  closed. Day-one `manual_transfer` has no webhooks (nothing to rotate).
- Invalid signature → 401, logged to `webhook_events`, nothing processed.

> Baileys refactor note: the WhatsApp webhook (`/api/v1/webhooks/whatsapp`,
> `WHATSAPP_APP_SECRET[_PREVIOUS]`, verify-token challenge) no longer exists —
> inbound arrives over the authenticated WebSocket only. The rotation
> procedure below now applies to payment webhooks only; WhatsApp "rotation"
> is re-scanning the QR after wiping `BAILEYS_AUTH_DIR`.

### Rotation steps (payment webhooks)

1. Generate the new secret at the payment provider (old stays valid).
2. Stage env: `PAYMENT_WEBHOOK_SECRET=<new>`,
   `PAYMENT_WEBHOOK_SECRET_PREVIOUS=<old>`.
3. Rolling-restart the API. Webhooks signed with either secret now verify.
4. Verify: no `Rejected payment webhook: bad signature` in logs; callbacks
   processed.
5. Clear `PAYMENT_WEBHOOK_SECRET_PREVIOUS`, restart. The old secret is dead.

Rollback: restore old as primary, clear `_PREVIOUS`, restart. If a leak is
suspected, skip the grace window (empty `_PREVIOUS`, accept brief retries —
providers redeliver).

## 10. Secret management

- All secrets via environment only; `backend/.env` is chmod 600 and
  gitignored; `backend/.env.example` carries placeholders, never values.
- Secrets never appear in code, logs, error messages, n8n exports, or docs.
- AI provider key: owner-supplied, lives only in `backend/.env`.

## 11. Log redaction

- `JsonLogger` + `sanitize.ts` redact by key pattern: secrets, tokens,
  passwords, API keys, TOTP/OTP codes, **phone/WhatsApp numbers (`phone`,
  `whatsapp`, `msisdn`, `mobile`)**, card data, private keys, sessions.
  (Phase 10 finding: WhatsApp numbers were not redacted — fixed; the
  security suite now asserts redaction on `whatsappNumber`/`phone` keys.)
- AI audit logs are PII-redacted by policy.
- The security suite asserts redaction on representative payloads.

## 12. Backup encryption & restore

- Backups: `pg_dump | gzip | age-encrypt(recipients)` → `.sql.gz.age`;
  retention keeps newest N (default 7); audited as `maintenance.db_backup`
  (audit row records `encrypted: true/false`).
- If `BACKUP_AGE_RECIPIENTS` is unset, backups stay plaintext and a loud
  warning is logged **and** written to the audit row — **production must set
  it**; treat a plaintext production backup as an incident.
- Encryption library: `age-encryption` (pure JS, no binary); recipients are
  standard `age1…` bech32 strings, compatible with the `age` CLI.
- Malformed recipients fail loudly before any file is written.

### Key management (owner's responsibility)

- Generate **two** keypairs minimum: primary + offline escrow (so one lost
  key doesn't brick all backups). `age-keygen -o ~/backup-key.txt`, or the
  library's `generateIdentity()`/`identityToRecipient()`.
- The private identity (`AGE-SECRET-KEY-1…`) lives ONLY in the owner's
  password manager / offline storage. Never in git, server `.env`, n8n,
  panel, chat, or email. The server needs only the public recipients.
- Rotation: add new recipient → redeploy → verify newest backup decrypts
  with the new key → after 2× retention windows remove the old recipient
  (keep the old private key until its last backup ages out). Rotate on
  suspected compromise, staff change, and at least annually.

### Restore

`age -d -i /path/to/backup-key.txt -o restore.sql.gz
zenskill-backup-<ts>.sql.gz.age` → `gzip -t` → `gunzip -c | psql <url>`.
Exact commands: `workflows/n8n/README.md` → "Restore from backup".

### Residual risk (T12)

Encryption protects backups **at rest**. It does not protect against an
attacker with backend shell access at backup time, nor against deletion of
`BACKUP_DIR` before the offsite copy — the S3-compatible offsite copy is
still HUMAN ACTION REQUIRED (Phase 12 infra).

## 13. Dependency policy

- Lockfiles committed for backend/, admin/, database/.
- `npm audit` runs in CI (policy); high/critical findings fixed or
  documented with justification below.
- Docker images pinned by digest (Phase 12).

### Audit 2026-09-24 (Snyk-based; `npm audit` endpoint policy-blocked here)

| directory | critical | high | medium | low | total |
|---|---|---|---|---|---|
| backend/ | 0 | 3 | 1 | 0 | 4 |
| admin/ | 2 | 10 | 10 | 1 | 23 |
| database/ | 0 | 1 | 0 | 0 | 1 |

- **Fixed:** postcss 8.4.31 → 8.5.28 via `overrides` (4 vulns cleared;
  admin build green). New `age-encryption` + deps: 0 findings.
  Malicious packages installed: none.
- **Residual 1 — `next@14.2.35` (admin), 23 advisories incl. 2 critical
  (CVE-2026-75604, GHSA-2xp9-vwfh-vxw4).** No patched 14.x exists; fix =
  Next 15.5.24+ major (React 19, async-`params` code changes) — deferred
  deliberately: needs owner approval + QA, not a safe `npm audit fix`.
  Mitigated: internal-only panel (TOTP 2FA, RBAC, rate limits, security
  headers). Recommendation: schedule the Next 15 upgrade as a dedicated
  work item; don't let 14.x drift further.
- **Residual 2 — `deepmerge-ts@7.1.5` (backend, database), CVE-2026-40345
  high.** Fixed only in 8.0.0; `@prisma/config` 6.x pins ^7. Reachable only
  at Prisma config-load (migrate/seed), never on a request path. Real fix:
  Prisma 7/8 upgrade with live-DB testing.
- **Residual 3 — `deepmerge@4.3.1` (CVE-2026-93753) and `uri-js@4.4.1`
  (CVE-2026-93690/93751):** no patched versions exist; both are dev-only
  chains (@nestjs/cli, jest), never in the production runtime.
- **Process gap:** re-run `npm audit` in CI where the registry endpoint is
  reachable; this snapshot is point-in-time.

## 14. Incident checklist

1. Suspect admin compromise → owner runs **log out all sessions**
   (`POST /auth/logout-all`), rotates `JWT_SECRET`, reviews audit log.
2. Suspect webhook secret leak → rotate per §9 (secondary-secret window).
3. Suspect DB/backup exposure → rotate DB credentials, re-encrypt backups
   with a new age recipient, review access logs.
4. WhatsApp number/account issue → Meta-side recovery (owner holds SIM).
5. Record everything in `audit_logs`; notify the owner.

## 15. HUMAN ACTION REQUIRED

- [ ] **Owner sets admin 2FA**: every admin account must enable TOTP
      (panel → Account → enable 2FA) before production.
- [ ] **Owner reviews this document** and accepts the residual risks (§16).
- [ ] **Meta-side 2FA**: owner enables 2FA on the Meta Business account and
      uses least-privilege admin roles there.
- [ ] **AI provider DPA**: owner reviews the AI provider's data-processing
      terms (prompts carry minimal PII by design).
- [ ] **Backup restore drill**: owner runs a quarterly restore from an
      encrypted backup to a scratch database and confirms it works.
- [ ] **Production secrets**: owner pastes real secrets into production
      `.env` (Phase 12 checklist); `CORS_ORIGINS` set to the real panel
      origin; `BACKUP_AGE_RECIPIENTS` set to the owner's age public key.

## 16. Residual risks (accepted, monitored)

- Owner's Meta Business account compromise (Meta-side 2FA is the owner's
  responsibility).
- SIM-swap / loss of the business number (owner holds the SIM).
- AI provider's handling of transmitted prompts (PII minimized).
- Zero-days in upstream dependencies/images (updates + monitoring).
- Stateless JWT idle timeout (accepted; see §5).
