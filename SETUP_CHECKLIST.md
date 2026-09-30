# ZenSkil Hub — Final Setup Checklist

Date: 2026-09-24 (Phase 12). Work through top to bottom; nothing here is
optional for a production launch. Each item is verifiable — "done" means you
ran the check in the right column.

## A. Accounts & credentials (all HUMAN ACTION REQUIRED)

| # | Item | Verify with |
|---|---|---|
| A1 | Business WhatsApp number on a phone that stays online | Phone shows the backend as a linked device |
| A2 | `BAILEYS_AUTH_DIR` on a persistent disk; exactly one backend replica | Restart does not require a fresh QR scan |
| A3 | QR scanned from the backend logs; `GET /api/v1/admin/whatsapp/status` → `connected: true` | Status endpoint shows `connected: true`, `awaitingQrScan: false` |
| A4 | Test message delivered via `POST /api/v1/admin/whatsapp/test-send` | Message arrives on your phone |
| A5 | AI provider key in `AI_API_KEY` (+ budget cap in provider dashboard) | Ask the bot a free-text question; no fallback flag in logs |
| A6 | `AUTOMATION_SERVICE_TOKEN` set **identically** in backend `.env` and n8n | An `/api/v1/automation/*` call with the token → 200 (not 503) |
| A7 | `ZENSKILL_ADMIN_ALERT_URL` set in backend `.env` | Create a test HIGH ticket → alert arrives |
| A8 | Age keypairs generated; public keys in `BACKUP_AGE_RECIPIENTS`; private keys in your password manager (never on the server) | `SECURITY.md` §12 |
| A9 | S3-compatible bucket + credentials for offsite backup copies | Manual upload test succeeds |
| A10 | `JWT_SECRET` ≥ 32 chars; `TOTP_ENCRYPTION_KEY` = base64 of 32 random bytes | Backend boots without the "insecure default" warning |

## B. Server & database

| # | Item | Verify with |
|---|---|---|
| B1 | Ubuntu LTS VPS, firewall allows 22/80/443 only | `ufw status` |
| B2 | PostgreSQL 16 cluster created with a **UTF-8 locale** | `SHOW server_encoding;` → `UTF8`; Urdu `to_tsvector` test returns Urdu tokens (see `DEPLOYMENT.md` §2) |
| B3 | `vector` extension installed | `SELECT * FROM pg_extension WHERE extname='vector';` → 1 row |
| B4 | All migrations applied via `prisma migrate deploy` | `npx prisma migrate status` → no pending |
| B5 | Seed + business-data script applied | `npx tsx tests/verify.ts` → **ALL CHECKS PASSED** |
| B6 | Backups encrypted (`.sql.gz.age`) and landing in `BACKUP_DIR` | Trigger a backup; file exists and is not plaintext |
| B7 | Caddy serving the domain with valid TLS | `https://<domain>/health` → 200, padlock in browser |

## C. Application

| # | Item | Verify with |
|---|---|---|
| C1 | Backend systemd service enabled and running | `systemctl is-active zenskill-backend` → `active`; `/ready` → 200 |
| C2 | Admin panel builds and serves | Panel loads in browser; login works |
| C3 | OWNER 2FA enabled (and every admin account) | Login prompts for TOTP code |
| C4 | n8n deployed; 6 workflows imported, credential assigned, **activated** | n8n shows all workflows "Active" |
| C5 | Proof storage dir is private (0700/0600) or private object storage | Permissions check; proof URLs never public |

## D. Business content (all owner decisions)

| # | Item | Verify with |
|---|---|---|
| D1 | `payment.instructions` holds your real receiving accounts | Test order shows your accounts on WhatsApp |
| D2 | Business hours set (currently 24/7) | `GET /api/v1/settings/business_hours` |
| D3 | Product fulfillment notes describe what each product delivers | Fulfillment task shows the notes |
| D4 | Refund policy published (owner-approved text) | KB shows refund policy `PUBLISHED` |
| D5 | KB documents published (about, plans, payment, delivery, support, FAQs) | Ask the bot each topic; no escalation fallback |
| D6 | Legal documents reviewed (Terms, Privacy) | Published and linked |

## E. Go-live dry run (do not skip)

| # | Item | Verify with |
|---|---|---|
| E1 | Full §41 live test order on WhatsApp end-to-end | Customer receives the delivery message **only** after you complete the fulfillment task |
| E2 | Screenshot → `MANUAL_REVIEW_REQUIRED`, never auto-PAID | Payment stays in review until **you** approve |
| E3 | Duplicate provider webhook deduplicated | One confirmation, audit shows `webhook.duplicate_skipped` |
| E4 | Renewal + abandoned reminders send on schedule | Template messages arrive; opt-out respected |
| E5 | Support ticket → admin alert arrives via webhook | Alert hits `ZENSKILL_ADMIN_ALERT_URL` |
| E6 | First-week audit log review | `GET /api/v1/audit-log` shows sane rows |
| E7 | Backup restore drill on a throwaway DB | Restore completes; app boots against it |

## F. After launch (recurring)

- Quarterly encrypted-backup restore drill (alternating server/offsite copies).
- Review `SECURITY.md`; schedule the Next.js 15 upgrade.
- Rotate any credential the moment it is exposed; webhook rotation in
  `SECURITY.md` §9.
- Monitor the ticket-alert outbox for `DEAD` alerts
  (`GET /api/v1/automation/support/alerts/outbox`).
