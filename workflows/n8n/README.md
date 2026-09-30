# n8n Automation Workflows — ZenSkil Hub (Phase 5)

**Architecture: n8n is a thin dispatcher; the backend is authoritative.**

Every workflow below fires on a schedule, calls a backend
`/api/v1/automation/*` endpoint, and loops over the returned candidates.
All decisions — candidate selection, reminder stages, 24h-window/opt-in
policy, template choice, idempotency — live in the backend
(`backend/src/automation/`) and are covered by backend tests. The WhatsApp
service remains the final policy enforcer for every actual send.

Inbound WhatsApp messages do **not** flow through n8n: the backend handles
them over the Baileys WebSocket (authenticated socket events, race-tested).
Keeping n8n out of the real-time path removes a failure hop from message
delivery.

## Workflows

| File | Schedule | What it does |
|---|---|---|
| `notification-dispatcher.v1.json` | every 5 min | Fetches `QUEUED` notifications → dispatches each via `POST …/notifications/:id/dispatch`. Backend enforces opt-in for templates. |
| `abandoned-reminders.v1.json` | every 30 min | Fetches abandonment candidates (2h → reminder 1, 24h → final) → sends approved template. Opted-out customers are excluded permanently. |
| `renewal-reminders.v1.json` | daily 09:00 Asia/Karachi | Fetches renewal candidates (7d / 3d / 1d buckets) → sends approved renewal template. |
| `expiry-sweeper.v1.json` | every 15 min | Triggers `POST …/subscriptions/sweeper/run` (ACTIVE→EXPIRING_SOON→EXPIRED). Idempotent; also runs in-process — overlapping runs are safe. |
| `ticket-alerts.v2.json` | every 5 min | Fetches unalerted OPEN HIGH/URGENT (or unassigned) tickets → atomically claims each alert (claim + outbox enqueue in one DB transaction) → triggers backend outbox processing. The backend POSTs to the admin channel with retry (v1's direct n8n POST is retired — it could lose alerts). |
| `db-backup.v1.json` | nightly 02:00 Asia/Karachi | Triggers `POST …/maintenance/db-backup` (pg_dump → gzip → **age encryption** when `BACKUP_AGE_RECIPIENTS` is set → retention, writes `.sql.gz.age`; plaintext `.sql.gz` with a loud warning otherwise). Verify restores with the Phase 12 restore drill (owner runs it quarterly — see restore commands below). |
| `fulfillment-processor.v1.json` | every 5 min | Triggers `POST …/fulfillment/process` — runs PENDING fulfillment tasks through the provider. The manual provider defers to the admin task queue. Idempotent; also runs in-process. |

## Setup (HUMAN ACTION REQUIRED — self-hosted n8n)

1. Deploy n8n per `analysis/04-external-dependencies.md` (D12): self-hosted
   Docker Compose, credentials in n8n's credential store backed by env.
2. In n8n, create an **HTTP Header Auth** credential named exactly
   `ZenSkil Backend API`: header `x-service-token`, value = the server's
   `AUTOMATION_SERVICE_TOKEN` (production `.env` only — never commit it).
3. Set on the n8n instance:
   - `ZENSKILL_API_BASE_URL` — e.g. `https://api.zenskill.example.com`
   (`ZENSKILL_ADMIN_ALERT_URL` is a **backend** env var since v2 — the backend
   owns delivery with retry; n8n never posts alerts itself anymore.)
4. Import each workflow file (Workflows → ⋯ → Import from file), attach the
   credential when prompted, and **activate** the workflow.
5. On the backend, set `AUTOMATION_SERVICE_TOKEN` (≥32 chars) and
   `BACKUP_DIR`; without the token every automation endpoint returns 503.
6. For backup encryption (T12), set `BACKUP_AGE_RECIPIENTS` to the
   comma-separated age recipient(s) (`age1…`), e.g.
   `BACKUP_AGE_RECIPIENTS="age1abc…"` — see "Restore from backup" below.
   Unset => plaintext `.sql.gz` backups with a loud `BACKUP UNENCRYPTED`
   warning in logs and the audit row. (`.env.example` is owned by the phase
   coordinator — ask them to add the variable.)

## Restore from backup (HUMAN ACTION REQUIRED — owner runs this)

Backups live in `BACKUP_DIR` as `zenskill-backup-<ts>.sql.gz.age` (encrypted)
or `zenskill-backup-<ts>.sql.gz` (plaintext — only when
`BACKUP_AGE_RECIPIENTS` was unset). The private age identity
(`AGE-SECRET-KEY-1…`) lives **only** in the owner's password manager / offline
storage — never on the server.

```bash
# 1. Decrypt (needs the age CLI; install: apt install age / brew install age)
age -d -i /path/to/backup-key.txt \
  -o zenskill-backup.sql.gz \
  zenskill-backup-20260924-020000-000.sql.gz.age

# 2. Verify gzip integrity
gzip -t zenskill-backup.sql.gz

# 3. Restore into a DATABASE (test on staging FIRST; it overwrites data)
gunzip -c zenskill-backup.sql.gz | psql "$DATABASE_URL"
```

Node alternative (same age-encryption library the backend uses):

```js
const { readFileSync, writeFileSync } = require('fs');
const { Decrypter } = require('age-encryption');
(async () => {
  const d = new Decrypter();
  d.addIdentity(process.env.BACKUP_AGE_IDENTITY); // AGE-SECRET-KEY-1… — handle carefully
  const gz = await d.decrypt(readFileSync('zenskill-backup-<ts>.sql.gz.age'));
  writeFileSync('zenskill-backup.sql.gz', gz);
})();
```

The quarterly restore drill (owner-only, never faked) is documented in
SECURITY.md (Phase 10) under the backup key-management notes.

## Versioning

- Workflows are versioned by filename (`*.v1.json`) and a `version` field.
- Regenerate with `node build-workflows.mjs` after editing the builder —
  never hand-edit the JSON (it is a build artifact of the script).
- Backend endpoint changes require a workflow version bump.

## Message templates (D4 — HUMAN ACTION REQUIRED)

Template *names* are configurable in `system_settings`
(`templates.abandoned_reminder_1`, `templates.abandoned_reminder_2`,
`templates.renewal_reminder`, `templates.payment_confirmation`,
`templates.support_followup`). Message *bodies* are rendered locally from the
`message_templates` table (seeded from `message-templates.draft.md`,
owner-editable via the admin panel) — no Meta submission or approval needed
since the 2026-09-26 Baileys refactor.
