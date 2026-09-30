# ZenSkil Hub — Deployment Guide (Phase 12)

Date: 2026-09-24. This is the final phase's deployment playbook: it takes a
fresh Ubuntu VPS to a live, verified ZenSkil Hub system. Steps are ordered;
later steps assume earlier ones. Commands target **Ubuntu 22.04/24.04 LTS**.

Companion documents: `SETUP_CHECKLIST.md` (tick-off list for go-live),
`ADMIN_USER_GUIDE.md` (day-to-day operations), `SECURITY.md` (security
posture), `backend/.env.example` (every env var with notes).

## 0. What you need before you start (all HUMAN ACTION REQUIRED)

- A VPS: Ubuntu LTS, **2 vCPU / 4 GB RAM minimum**, SSH key access, firewall
  (allow 22, 80, 443 only to start). This is H-13.
- A domain with an `A` record pointing at the VPS (H-14).
- A private Git repository holding this monorepo (H-15).
- A smartphone with the business WhatsApp number (H-1…H-4). No Meta
  Business verification, no developer app, no templates needed — the
  backend pairs over WhatsApp Web (Baileys). Longest lead time used to be
  Meta approval; pairing now takes minutes, but the phone must stay
  online and the number must not be banned for automation use.
- Your AI provider API key (H-7), admin-alert webhook URL
  (`ZENSKILL_ADMIN_ALERT_URL`), and the two age keypairs for encrypted backups
  (`SECURITY.md` §12) (H-16).
- S3-compatible bucket + credentials for offsite backup copies (H-16).

## 1. Server baseline

```bash
# As root on the VPS
apt-get update && apt-get upgrade -y
apt-get install -y curl git ufw fail2ban
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable
# Node 24 (matches the build) + PostgreSQL 16 + pgvector
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs postgresql-16 postgresql-16-pgvector
```

## 2. PostgreSQL — UTF8 is mandatory

**Phase 11 lesson: the cluster MUST be created with a UTF-8 locale.** A
SQL_ASCII cluster silently breaks Urdu full-text search (the AI's Urdu KB
answers fail with no error). Verify before going further.

```bash
# Create the cluster with a UTF-8 locale (check `locale -a` for availability;
# C.utf8 ships on Ubuntu and is sufficient)
pg_dropcluster --stop 16 main 2>/dev/null
pg_createcluster 16 main --locale=C.utf8 --start

# Role + databases
su -s /bin/bash postgres -c "psql -c \"CREATE ROLE zenskill WITH LOGIN PASSWORD '<STRONG_PASSWORD>' CREATEDB;\""
su -s /bin/bash postgres -c "psql -c 'CREATE DATABASE zenskill OWNER zenskill;'"
su -s /bin/bash postgres -c "psql -d zenskill -c 'CREATE EXTENSION IF NOT EXISTS vector;'"

# Verify — both lines must say UTF8:
PGPASSWORD='<STRONG_PASSWORD>' psql -h localhost -U zenskill -d zenskill -tAc "SHOW server_encoding;"
PGPASSWORD='<STRONG_PASSWORD>' psql -h localhost -U zenskill -d zenskill -tAc "SELECT to_tsvector('simple', 'ادائیگی رسائی');"
# expected: 'ادائیگی':1 'رسائی':2  (if you only see numbers, the locale is wrong — stop and fix)
```

Keep the database local to the VPS on day one (no public Postgres port).
Put the password in the backend `.env` only.

## 3. Backend (NestJS API)

```bash
git clone <your-private-repo> ~/zenskill-hub && cd ~/zenskill-hub
cd database && npm ci
# Point Prisma at production:
#   DATABASE_URL="postgresql://zenskill:<STRONG_PASSWORD>@localhost:5432/zenskill"
npx prisma migrate deploy          # applies every migration, including the security one
cd ../backend && npm ci
npx prisma generate --schema ../database/prisma/schema.prisma   # see note below
npm run build
```

**Prisma engine note (learned in Phase 4):** `prisma generate` needs its
engines; if it tries to download them, run it inside `database/` (engines
are cached there) and copy the client over:
`cp -r database/node_modules/.prisma/client/. backend/node_modules/.prisma/client/`.

### 3a. Environment (`backend/.env`, chmod 600, never in git)

Copy from `backend/.env.example` and set at minimum:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `postgresql://zenskill:<STRONG_PASSWORD>@localhost:5432/zenskill` |
| `JWT_SECRET` | ≥ 32 random chars |
| `TOTP_ENCRYPTION_KEY` | base64 of 32 random bytes |
| `CORS_ORIGINS` | `https://<your-domain>` |
| `AI_API_KEY` | your real provider key (deterministic stub otherwise) |
| `AUTOMATION_SERVICE_TOKEN` | long random secret, **must match** the n8n credential |
| `BACKUP_AGE_RECIPIENTS` | your age recipients — backups are plaintext without them |
| `ZENSKILL_ADMIN_ALERT_URL` | your admin webhook (ticket alerts are queued but unsent without it) |
| WhatsApp vars | `BAILEYS_AUTH_DIR` (persistent disk path), `BAILEYS_LOG_LEVEL` (step 6) |

### 3b. Seed + business data

```bash
cd database
DATABASE_URL="postgresql://zenskill:<STRONG_PASSWORD>@localhost:5432/zenskill" npx tsx prisma/seed.ts
DATABASE_URL="postgresql://zenskill:<STRONG_PASSWORD>@localhost:5432/zenskill" npx tsx scripts/apply-business-data-update.ts
# Verify everything:
DATABASE_URL="postgresql://zenskill:<STRONG_PASSWORD>@localhost:5432/zenskill" npx tsx tests/verify.ts
# expected: ALL CHECKS PASSED (idempotent — safe to re-run)
```

### 3c. Run it (systemd)

Create `/etc/systemd/system/zenskill-backend.service`:

```ini
[Unit]
Description=ZenSkil Hub backend
After=network.target postgresql.service

[Service]
User=zenskill
WorkingDirectory=/home/zenskill/zenskill-hub/backend
EnvironmentFile=/home/zenskill/zenskill-hub/backend/.env
ExecStart=/usr/bin/node dist/backend/src/main.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now zenskill-backend
curl -s http://localhost:3000/health   # -> {"status":"ok"} (200)
curl -s http://localhost:3000/ready    # -> 200 means the DB is reachable
```

## 4. Admin panel (Next.js)

```bash
cd ~/zenskill-hub/admin && npm ci && npm run build
```

Set `NEXT_PUBLIC_API_BASE_URL=https://<your-domain>/api/v1` (or the panel's
own env mechanism — see `admin/` docs), run it behind the same reverse
proxy (step 5) or as its own systemd unit on port 3001. The panel talks to
the backend's `/api/v1` routes.

## 5. HTTPS reverse proxy (Caddy)

```bash
apt-get install -y caddy
```

`/etc/caddy/Caddyfile`:

```
<your-domain> {
    reverse_proxy /api/* localhost:3000
    reverse_proxy localhost:3001
}
```

Caddy provisions and renews TLS automatically. The backend trusts the
`X-Forwarded-*` headers from localhost.

## 6. Connect real WhatsApp (H-1…H-4)

No Meta app, no tokens, no webhook URL. The backend pairs like WhatsApp Web:

1. Set `BAILEYS_AUTH_DIR` to a path on a **persistent disk** (Render: attach
   a disk and point the variable at it). Ephemeral storage = re-scan the QR
   on every deploy. Run exactly **one** backend replica — two replicas
   sharing one auth dir corrupt the session.
2. Deploy and watch the backend logs: a QR code is printed on first boot.
3. On the business phone: WhatsApp → Linked devices → Link a device → scan.
4. Check `GET /api/v1/admin/whatsapp/status` (as OWNER): `connected: true`,
   `awaitingQrScan: false`.
5. Send a test message with `POST /api/v1/admin/whatsapp/test-send`
   (to your own number) to prove end-to-end delivery.

⚠️ Baileys is unofficial: WhatsApp can change the Web protocol or restrict
the linked number at any time. Keep the phone online; if the session is
revoked (401/loggedOut in logs), wipe `BAILEYS_AUTH_DIR` and re-scan.

## 7. n8n automation (H-18)

1. Deploy n8n (Docker on the same VPS is fine):
   `docker run -d --name n8n -p 5678:5678 n8nio/n8n`.
2. Create the **HTTP Header Auth** credential named exactly
   `ZenSkil Backend API`: header `x-service-token`, value = your
   `AUTOMATION_SERVICE_TOKEN`.
3. Set `ZENSKILL_API_BASE_URL=https://<your-domain>/api/v1` in n8n.
4. Import the six workflows from `workflows/n8n/` (use
   `ticket-alerts.v2.json` — v1 is retired), assign the credential,
   activate them.
5. Baileys sends WhatsApp text directly — no Meta template approval gate.
   The 24-hour service-window and opt-in/out rules are still enforced by the
   backend; reminders outside policy queue and retry, they don't fail silently.

## 8. Post-deploy verification (do not skip)

Run these in order; every one must pass before customers touch the system:

1. `/health` 200, `/ready` 200.
2. Login as OWNER → enable 2FA (`ADMIN_USER_GUIDE.md` → Security).
3. WhatsApp status: `connected: true`, `awaitingQrScan: false`; send yourself a test message.
4. Place a **live test order** on WhatsApp end-to-end (§41 scenario in
   `PHASE11_REPORT.md`): product → YES → payment instructions →
   screenshot → admin approval → fulfillment completion → customer gets
   the delivery message.
5. Confirm a renewal reminder and a ticket alert reach you (check the
   outbox: `GET /api/v1/automation/support/alerts/outbox`).
6. Trigger a backup (`POST /api/v1/automation/maintenance/db-backup`,
   service token) and confirm an encrypted `.sql.gz.age` file lands in
   `BACKUP_DIR` — then copy it offsite.
7. Review the first audit rows for the test order
   (`GET /api/v1/audit-log`).

## 9. Ongoing operations

- **Backups:** nightly via n8n (02:00) or the endpoint; keep 7; copy
  encrypted files offsite; **quarterly restore drill** on a throwaway DB.
- **Secrets:** in server `.env` files only — never chat, docs, screenshots,
  or git. Rotate immediately if exposed. Webhook secret rotation is
  documented in `SECURITY.md` §9.
- **Updates:** `git pull` → `prisma migrate deploy` → `npm ci && npm run build`
  → restart. Migrations are backward-compatible by design; the DB verify
  script catches schema drift.
- **What the owner changes without deploys:** prices, products, plans,
  coupons, payment instructions, business hours, KB content, fulfillment
  notes, settings — all from the admin panel/API (see `ADMIN_USER_GUIDE.md`).

## 10. Rollback plan

- Keep the previous release directory + its `.env`. To roll back: stop the
  service, point systemd at the old directory, restart, verify `/ready`.
- Database: restore the newest encrypted backup to a *new* database,
  verify, then point `DATABASE_URL` at it. Migrations never drop columns
  in place without a deprecation note — check the migration SQL first.
