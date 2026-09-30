# Phase 10 — Security: Report & Sign-off Gate

Date: 2026-09-24. Owner approved Phase 9 and authorized Phase 10 (Security) immediately.

## What was built

Applied the threat model (`analysis/05-threat-model.md`) across the backend and admin panel:

1. **Password hashing → argon2id (T6).** New hashes use argon2id (t=3, m=65536, p=4,
   exceeds OWASP interactive guidance). Legacy bcrypt (cost 12) hashes verify via
   bcryptjs and are rehashed to argon2id on successful login (audited). Malformed
   hashes fail closed. (`backend/src/auth/password.util.ts`)
2. **Login brute-force lockout (T6).** 5 consecutive failures → 15-minute lockout,
   checked before password verification; generic error (no user enumeration);
   `auth.login_failed` / `auth.login_locked` audited. DB columns
   `failed_login_attempts`, `locked_until` + migration
   `20260924083000_admin_login_security` (**written, NOT applied — DB was down;
   runs on next `prisma migrate deploy`; do not deploy without it**).
3. **CSRF protection (admin panel).** Double-submit cookie: `GET /api/auth/csrf`
   issues a 256-bit token; the admin proxy rejects state-changing requests with
   mismatched `X-CSRF-Token` (403, backend never called); client attaches the
   header automatically with single retry on rotation. `SameSite=lax` is the
   second layer. Justification (why double-submit over synchronizer) in
   `SECURITY.md` §4.
4. **Security headers (admin).** `next.config.mjs` `headers()`: HSTS (prod-only),
   `X-Frame-Options: DENY`, nosniff, `Referrer-Policy: same-origin`, minimal
   Permissions-Policy.
5. **Rate limiting hardened.** `ThrottlerGuard` registered as `APP_GUARD`
   (Phase-10 security-suite finding: without this, every `@Throttle()`
   decorator was inert). WhatsApp + payment webhooks 60/min, automation
   120/min (on top of service-token guard), TOTP endpoints 20/min, login
   10/min. Per-customer WhatsApp cap `WHATSAPP_MAX_PER_CUSTOMER_PER_HOUR`
   (default 30), enforced at `persistAndSend()`, trips audited.
6. **Session hardening (T6).** `tv` (token version) claim in JWT; `JwtAuthGuard`
   rejects mismatches (`auth.session_revoked`); `POST /auth/logout-all` bumps
   the version (sidebar Sign-out calls it). Cookie: httpOnly, Secure-in-prod,
   SameSite=lax; maxAge fixed 12h → 8h to match JWT lifetime. Idle-timeout
   posture documented honestly (stateless JWT; 8h absolute + logout-all).
7. **Webhook secret rotation (T1).** `verifyHmacSha256(rawBody, header,
   [primary, previous])` — constant-time, fails closed. WhatsApp:
   `WHATSAPP_APP_SECRET` + `WHATSAPP_APP_SECRET_PREVIOUS`. Payment:
   `PAYMENT_WEBHOOK_SECRET[_PREVIOUS]` convention documented for future
   gateways (day-one manual_transfer has no webhooks). Rotation procedure in
   `SECURITY.md` §9 — zero rejected webhooks when done in order (rolling
   restart required; documented honestly).
8. **Log redaction audit (T8).** `SENSITIVE_KEY` extended with
   `phone|whatsapp|msisdn|mobile` (Phase-10 finding: WhatsApp numbers reached
   JSON logs unredacted — fixed). Asserted in the security suite.
9. **Injection scanner fix (T3).** `mark_paid` pattern extended to catch
   "mark my payment as successful" (the threat model's literal example).
10. **Backup encryption (T12).** `pg_dump | gzip | age-encrypt` →
    `.sql.gz.age` when `BACKUP_AGE_RECIPIENTS` set; unset → plaintext + loud
    warning in logs AND the audit row (never silent). Pure-JS `age-encryption`
    (no binary). Retention prunes both extensions. Restore path documented
    (`workflows/n8n/README.md`).
11. **Dependency audit (T13).** Snyk-based audit (npm audit endpoint
    policy-blocked here): backend 4 findings, admin 23, database 1; 0
    malicious packages. Fixed postcss (4 vulns via `overrides`). Residual:
    next@14.2.35 (23 advisories, incl. 2 critical — major upgrade deferred,
    needs owner approval + QA), deepmerge-ts@7.1.5 (Prisma-pinned; config-load
    only), deepmerge/uri-js (no patch exists; dev-only). Full detail in
    `/tmp/phase10c-audit.md`; summary in `SECURITY.md` §13.

## Tests

- **New `npm run test:security`** (`backend/tests/security.ts`): 16 named
  cases traced to threats T1–T14. **16 PASS / 0 FAIL / 0 SKIP** — verified
  2026-09-24 with PostgreSQL live (the 4 previously DB-gated cases now run:
  payment-webhook signature, replay, duplicate-payment, authenticated role
  matrix).
- The suite found **3 real defects**, all fixed and re-verified:
  (1) ThrottlerGuard never registered → rate limits inert;
  (2) `mark_paid` regex missed "mark my payment as successful";
  (3) WhatsApp numbers unredacted in logs.
- Running it against the live DB exposed **2 more real issues**, both fixed:
  (4) payment webhook returned 201 where the threat-model contract says
  200 + DUPLICATE → `@HttpCode(200)` on `POST /payments/webhooks/:provider`;
  (5) per-IP login throttle let one attacker's burst 429 innocent users on
  shared NAT IPs (and broke the suite's own multi-user logins) →
  `AppThrottlerGuard` buckets login attempts per (IP, email); per-account
  lockout + global 120/min per-IP backstop unchanged.
- Unit: **129/129** (20 suites) green — no regressions (incl. 4 new
  `AppThrottlerGuard` tracker tests).
- `tsc --noEmit` clean; `nest build` clean; backend booted for real:
  `/health` ok, `/ready` database reachable; `/api/v1/audit-log`,
  `/api/v1/orders/by-number/:n` present (401 unauthenticated, as designed).

## Files added/changed

- Backend: `src/auth/password.util.ts` (+spec), `src/auth/auth.service.ts`,
  `src/auth/jwt-auth.guard.ts` (+spec), `src/auth/auth.controller.ts`
  (logout-all), `src/app.module.ts` (APP_GUARD), `src/ai/injection-detection.ts`,
  `src/common/utils/sanitize.ts`, `src/common/utils/webhook-hmac.util.ts`
  (+spec), `src/whatsapp/whatsapp.service.ts` (rotation + per-customer cap),
  `src/automation/backup-crypto.ts` (+spec), `src/automation/maintenance.service.ts`,
  `src/config/configuration.ts`, `src/common/guards/app-throttler.guard.ts`
  (+spec — per-(IP,email) login buckets), `tests/security.ts`, `package.json`
  (test:security, argon2, age-encryption), `database/prisma/schema.prisma` +
  migration `20260924083000_admin_login_security` (APPLIED 2026-09-24).
- Admin: `app/api/auth/csrf/route.ts`, `app/api/admin-proxy/[...path]/route.ts`
  (CSRF enforcement), `lib/csrf.ts`, `lib/api-client.ts` (auto header),
  `next.config.mjs` (security headers), `package.json` (postcss override).
- Docs: `SECURITY.md` (new, complete), `PHASE10_REPORT.md` (this file),
  `README.md`, `ADMIN_USER_GUIDE.md`, `backend/.env.example` (5 new vars,
  placeholders only), `workflows/n8n/README.md` (restore section).

## Human actions required

- [ ] **Owner sets admin 2FA** on every admin account before production.
- [ ] **Owner reviews `SECURITY.md`** and accepts the residual risks.
- [ ] **Meta-side 2FA** on the Meta Business account.
- [ ] **AI provider DPA** reviewed by owner.
- [ ] **Backup restore drill**: quarterly, from an encrypted backup to a
      scratch DB (alternating server/offsite copies).
- [ ] **Production secrets**: `CORS_ORIGINS` = real panel origin;
      `BACKUP_AGE_RECIPIENTS` = owner's age public key(s); webhook secrets.
- [ ] **Decide on Next 15 upgrade** (23 advisories on next@14.2.35 incl. 2
      critical; internal-only panel mitigates but doesn't eliminate).
- [x] ~~Run `prisma migrate deploy`~~ — done 2026-09-24 (all migrations incl.
      `20260924083000` applied to a fresh cluster).
- [x] ~~Re-run `npm run test:security` with PostgreSQL up~~ — done 2026-09-24:
      16/16 PASS, 0 SKIP.

## Caveats

- `npm audit` could not run here (registry audit endpoint policy-blocked);
  the Snyk-based snapshot is point-in-time — CI must run `npm audit`.
- No end-to-end encrypted-backup run yet (crypto path fully unit-tested);
  the quarterly restore drill covers it.
- **Environment note (2026-09-24):** PostgreSQL was down because the VM had
  been rebuilt — the stock PG16 cluster existed but was never started, and
  `/var/lib/postgresql` is ephemeral, so the old role/databases were gone.
  Fixed by: `pg_ctlcluster 16 main start`, recreating the `zenskill` role +
  `zenskill_test`/`zenskill_fresh` databases, `prisma migrate deploy`, seed,
  and the business-data script. If the VM is rebuilt again, the DB must be
  reprovisioned the same way (documented here, not automated — the cluster
  does not autostart in this environment).

## Sign-off gate

Security tests pass (12/12 runnable, 4 DB-gated skips documented);
`SECURITY.md` complete; residual risks documented with owners. **Awaiting
owner sign-off — do not present as signed off.**
