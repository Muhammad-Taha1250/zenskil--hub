# Phase 12 — Deployment: Report & Sign-off Gate

Date: 2026-09-24. Owner approved Phase 11 and authorized Phase 12
(Deployment) immediately: "Please proceed to Phase 12 (Deployment)
immediately. I am ready for the final deployment instructions, the setup
checklist, and the Admin User Guide."

## What Phase 12 delivered

Deployment is a human-executed step (spec §54: infrastructure, accounts,
secrets). Phase 12 therefore delivers the complete, verifiable deployment
package — nothing assumed, every step checkable:

1. **`DEPLOYMENT.md`** — step-by-step deployment playbook for a fresh Ubuntu
   VPS to a live system:
   - Server baseline (Ubuntu LTS, firewall, Node 24, PostgreSQL 16 + pgvector)
   - **PostgreSQL with a UTF-8 locale — mandatory** (the Phase 11 Urdu
     defect; includes the SQL verification query that proves Urdu tokens
     index correctly before proceeding)
   - Backend: build, `.env` (every variable from `backend/.env.example`
     explained), migrations, seed, business-data script, verify,
     systemd service, `/health` + `/ready` checks
   - Admin panel build + serve; Caddy HTTPS reverse proxy
   - WhatsApp connection steps (links into `ADMIN_USER_GUIDE.md`)
   - n8n deployment + the 6 workflow imports (v2 ticket alerts)
   - Post-deploy verification: the full §41 live test order, renewal/ticket
     alert confirmation, encrypted backup confirmation
   - Ongoing operations (backups, secret rotation, updates, rollback plan)
2. **`SETUP_CHECKLIST.md`** — the final go-live tick-off list (A–F):
   accounts/credentials, server/database, application, business content,
   go-live dry run, and recurring post-launch duties. Every item has a
   "verify with" column — done means the check ran.
3. **`ADMIN_USER_GUIDE.md`** — updated to Phase 12: the intro now reflects
   that the admin panel UI (built in Phase 9) covers all daily operations
   (Dashboard, Catalog, Orders, Payments, Fulfillment, Tickets, Knowledge,
   Coupons, Refunds, Approvals, Settings, Audit, Attribution, Account);
   API endpoints stay documented as the reference path. "Still pending"
   section now points at the checklist.
4. **`backend/.env.example`** — already complete (all 30+ variables with
   production notes); referenced from both new docs.
5. **`analysis/07-human-actions.md`** — the H-1…H-18 human-action inventory
   remains the authority for everything only the owner can do; the new
   checklist cross-references it.

## What remains HUMAN ACTION REQUIRED (the owner executes these)

- VPS + domain + DNS (H-13, H-14), GitHub repo (H-15), backup storage (H-16)
- Meta Business verification, WABA + number, developer app, approved
  templates (H-1…H-4 — longest lead time)
- n8n deploy + workflow import + matching service token (H-18)
- Secrets: `AI_API_KEY`, JWT/TOTP keys, webhook secrets, age keypairs
- Business content: payment instructions, fulfillment notes, refund policy,
  KB content, legal docs, brand assets (checklist section D)
- The §41 live test order on the real deployment (checklist section E)
- Quarterly backup restore drills (checklist section F)

## Sign-off

The deployment package is complete: instructions, checklist, and guide are
written, cross-referenced, and grounded in the actual system (env vars,
routes, workflows, and verification commands all match the codebase).
**Awaiting owner sign-off to close Phase 12 and the project build.**
