# Phase 9 Report — Admin Panel

Date: 2026-09-24. Owner approved Phase 8 and authorized Phase 9 (Admin Panel) immediately.

## What was built

A Next.js 14.2 (App Router, TypeScript, React 18) admin app at `~/workspace/zenskill-hub/admin/`,
covering all 12 Phase 9 scope areas from `analysis/06-implementation-plan.md`:

1. **Login + TOTP 2FA** — posts `{email, password, totpCode?}` to `POST /api/v1/auth/login`;
   a 401 mentioning two-factor reveals the 6-digit code field and retries. TOTP
   enrol/setup/disable lives on the **My account** page.
2. **Dashboard** — §26 metrics via `GET /api/v1/analytics/overview` and `/daily`.
3. **Ad-attribution analytics** (§22) — `GET /api/v1/analytics/attribution`.
4. **Catalog CRUD** — products / plans / prices.
5. **Orders** — search + detail (linked by UUID; see gap #3).
6. **Payment review queue** — approve / reject with mandatory reason; proof download
   streams through the proxy preserving content-type.
7. **Fulfillment task queue** — list / claim / complete / fail / retry / manual-review.
8. **Ticket inbox** — thread view + agent reply box (see gap #2).
9. **KB editor** — versioned documents, draft/publish.
10. **Coupons**, **refunds queue**, **`pending_approvals` queue**.
11. **Settings + business hours editor**.
12. **Audit log viewer** — placeholder (see gap #1).

## Architecture

- `/api/admin-proxy/[...path]` forwards to `<ZENSKILL_API_BASE_URL>/api/v1/<path>` with the
  JWT attached from an httpOnly cookie (`zenskill_admin_token`, 12h, sameSite=lax).
  Browser JS never sees tokens; tokens are never logged.
- JWT payload is base64-decoded server-side (no verification — the backend is the RBAC
  authority) to filter nav items by role (OWNER / FINANCE / SUPPORT / VIEWER).
- Plain CSS, desktop-first. All routes/DTOs grounded in `backend/src/**/*.controller.ts`
  — no guessed endpoints. Page↔endpoint table in `admin/README.md`.

## Evidence (2026-09-24)

- `npm run build` clean — 20 routes, no backend required at build time.
- Production-mode smoke test (`next start`, backend absent):
  - `GET /login` → 200
  - `GET /` unsigned → 307 → `/login`
  - `GET /api/admin-proxy/orders` unsigned → 401 `{"message":"Not signed in"}`
- `.env.local` required: `ZENSKILL_API_BASE_URL` (backend base). `.env.example` + `.gitignore` present.

## Backend gaps — CLOSED 2026-09-24 (owner-required for sign-off)

All three gaps were implemented in the backend, wired into the UI, and verified:

1. **Audit-log read endpoint** — `GET /api/v1/audit-log` (`backend/src/audit/audit.controller.ts`):
   filters `action` (contains), `entityType`, `entityId`, `actorType`, `from`/`to`;
   paginated (max 100/page), newest first. Roles OWNER/FINANCE/SUPPORT/VIEWER.
   The `/audit` page is fully functional (filters + before/after detail view).
2. **Admin WhatsApp-send for ticket replies** — `POST /api/v1/support/tickets/:id/reply`
   (`backend/src/whatsapp/whatsapp-support.controller.ts` + `WhatsappService.sendAdminTextToCustomer`):
   stores the AGENT reply in the thread, then delivers it over WhatsApp.
   Policy enforced before sending — opted-out customers are never messaged
   (`customer_opted_out`), free-form text only inside the 24h window
   (`free_form_outside_24h_window`); blocks return an honest verdict, never a
   phantom delivery. Audited as `whatsapp.admin_reply_sent` /
   `whatsapp.admin_reply_blocked`. Roles OWNER/FINANCE/SUPPORT. The ticket reply
   box now sends via WhatsApp and shows the delivery verdict.
3. **Order lookup by order number** — `GET /api/v1/orders/by-number/:orderNumber`
   (delegates to the existing `getOrderByNumber`). The Orders page has a
   "Find by #" field.

## Verification (2026-09-24, gap closure)

- `tsc --noEmit` clean; `npm run lint` clean; `nest build` clean.
- Unit: **82/82** (13 suites) — incl. 7 new tests:
  `audit.controller.spec.ts` (filter mapping, invalid dates, pageSize clamp),
  `whatsapp-support.controller.spec.ts` (thread-store + send orchestration,
  honest block verdict, missing ticket → no phantom writes).
- Boot DI check: all 117 routes mapped incl. the 3 new ones, zero DI errors.
  (Boot then stops at Prisma P1001 — PostgreSQL is down in this environment;
  identical on pristine code, so environmental, not a regression.)
- Admin `npm run build` clean after UI wiring.

## Remaining caveat

Full click-through against a live backend was **not possible**: PostgreSQL is down
in this environment, so the backend cannot boot here. A live walkthrough
(§52 acceptance: audit page loads real rows, ticket reply arrives on WhatsApp,
order-number search resolves) must run once the database is back.

## Docs

- `admin/README.md` — run guide, env vars, role matrix, page↔endpoint table, gaps.
- Root `README.md` — Phase 9 checklist line set to in-progress.
- `ADMIN_USER_GUIDE.md` — admin-panel section to be added during the live walkthrough.
