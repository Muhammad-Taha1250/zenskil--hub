# ZenSkil Hub — Admin Panel (Phase 9)

Next.js 14 (App Router, TypeScript) admin UI for the ZenSkil Hub NestJS backend.
Plain CSS, no heavy UI dependencies. Desktop-first.

## Run

```bash
cd ~/workspace/zenskill-hub/admin
cp .env.example .env.local   # then set ZENSKILL_API_BASE_URL
npm install
npm run dev                  # http://localhost:3100
npm run build && npm start    # production
```

The backend must be reachable at `ZENSKILL_API_BASE_URL` (default
`http://localhost:3000`) at runtime. `npm run build` does **not** need a
running backend.

## Environment

| Variable | Purpose | Default |
|---|---|---|
| `ZENSKILL_API_BASE_URL` | NestJS backend base URL (no trailing slash) | `http://localhost:3000` |
| `ZENSKILL_ADMIN_COOKIE` | httpOnly session cookie name | `zenskill_admin_token` |

Secrets live in `.env.local` (gitignored). Tokens are never logged and never
exposed to browser JS.

## How auth works

1. `POST /api/auth/login` (Next route) forwards `{ email, password, totpCode? }`
   to backend `POST /api/v1/auth/login`. On success the `accessToken` is stored
   in an **httpOnly** cookie (12h).
2. All backend calls go through `app/api/admin-proxy/[...path]/route.ts`, which
   reads the cookie server-side and forwards `Authorization: Bearer <jwt>` to
   `<backend>/api/v1/<path>`. Binary downloads (payment proofs) stream through.
3. The JWT payload is base64-decoded server-side (no verification — the backend
   is the RBAC authority) to get the role; nav items are hidden by role.
4. TOTP enrolment lives on the **My account** page (`/account`):
   `POST /auth/totp/setup` → enter secret in authenticator app →
   `POST /auth/totp/enable { secret, code }`; disable via
   `POST /auth/totp/disable { password, code }`.

## Role matrix (UI hiding only — backend enforces)

| Area | OWNER | FINANCE | SUPPORT | VIEWER |
|---|---|---|---|---|
| Dashboard, Attribution | ✓ | ✓ | — | ✓ |
| Catalog (read) | ✓ | ✓ | ✓ | ✓ |
| Catalog (create/edit products, plans) | ✓ | ✓ | — | — |
| Orders (read, confirm, cancel) | ✓ | ✓ | ✓ | read |
| Payments (read, proof download) | ✓ | ✓ | read+proof | read |
| Payments (approve/reject, reason mandatory) | ✓ | ✓ | — | — |
| Fulfillment (list/claim/complete/fail/retry/review) | ✓ | ✓ | ✓ | read |
| Tickets (read, reply, assign, status) | ✓ | ✓ | ✓ | read |
| Knowledge (create/edit) | ✓ | — | ✓ | read |
| Knowledge (publish/draft/archive) | ✓ | — | — | — |
| Coupons (read, create, activate) | ✓ | ✓ | read | read |
| Refunds (read, request, mark executed) | ✓ | ✓ | — | read |
| Approvals (read, decide) | ✓ | ✓ | — | read |
| Settings (read) | ✓ | ✓ | — | ✓ |
| Settings + business hours (edit) | ✓ | — | — | — |
| Audit log | placeholder — backend has no read endpoint (see below) |
| My account / 2FA | ✓ | ✓ | ✓ | ✓ |

## Pages ↔ backend endpoints

| Page | Backend endpoints used |
|---|---|
| Dashboard `/` | `GET /analytics/overview`, `GET /analytics/daily?days=` |
| Attribution `/attribution` | `GET /analytics/attribution` |
| Catalog `/catalog` | `GET /catalog/products?activeOnly=`, `POST /catalog/products`, `PATCH /catalog/products/:id`, `POST /catalog/plans`, `PATCH /catalog/plans/:id` |
| Orders `/orders`, `/orders/:id` | `GET /orders?page=&pageSize=&status=&customerId=`, `GET /orders/by-number/:orderNumber`, `GET /orders/:id`, `POST /orders/:id/confirm`, `POST /orders/:id/cancel {reason}` |
| Payments `/payments` | `GET /payments?page=&pageSize=&status=`, `GET /payments/:id`, `GET /payments/:id/instructions`, `GET /payments/:id/proof`, `POST /payments/:id/review {decision, reason}` |
| Fulfillment `/fulfillment` | `GET /fulfillment/tasks?page=&pageSize=&status=`, `GET /fulfillment/tasks/:id`, `POST /fulfillment/tasks/:id/claim|complete|fail|retry|manual-review` |
| Tickets `/tickets`, `/tickets/:id` | `GET /support/tickets?page=&pageSize=&status=&priority=`, `GET /support/tickets/:id`, `POST /support/tickets/:id/reply {bodyText}` → `{ message, whatsapp: { delivered, reason?, messageId? } }` (stores AGENT reply in thread AND sends over WhatsApp), `PATCH /support/tickets/:id/assign {assigneeId}`, `PATCH /support/tickets/:id/status {status}` |
| Knowledge `/knowledge`, `/knowledge/:id` | `GET /knowledge/documents?status=`, `GET /knowledge/documents/:id`, `POST /knowledge/documents`, `PATCH /knowledge/documents/:id`, `POST /knowledge/documents/:id/status {status}` |
| Coupons `/coupons` | `GET /coupons`, `POST /coupons`, `PATCH /coupons/:id/active {isActive}` |
| Refunds `/refunds` | `GET /refunds?page=&pageSize=`, `POST /refunds/request {paymentId, amountPaisa, reason}`, `POST /refunds/:id/mark-executed {providerRefundId}` |
| Approvals `/approvals` | `GET /approvals?status=&actionType=&page=&pageSize=`, `GET /approvals/:id`, `POST /approvals/:id/decide {decision, reason?}` |
| Settings `/settings` | `GET /settings`, `POST /settings {key, value, description?}`, `GET /settings/business-hours`, `PATCH /settings/business-hours {dayOfWeek, openTime?, closeTime?, isClosed?}` |
| Audit `/audit` | `GET /audit-log?page=&pageSize=&action=&entityType=&entityId=&actorType=&from=&to=` |
| Account `/account` | `GET /auth/me`, `POST /auth/totp/setup`, `POST /auth/totp/enable`, `POST /auth/totp/disable` |

## Backend gaps — closed 2026-09-24

All three gaps found during the Phase 9 build were closed in the backend and
wired into the UI (verified: typecheck/lint/build clean, unit 82/82, boot DI
clean, admin build clean):

1. **Audit-log read endpoint** — `GET /api/v1/audit-log` (filters: action,
   entityType, entityId, actorType, from, to; paginated). The `/audit` page is
   fully functional.
2. **Admin WhatsApp-send for ticket replies** — `POST
   /api/v1/support/tickets/:id/reply { bodyText }` stores the AGENT reply in the
   thread and delivers it over WhatsApp. Policy enforced before sending
   (opt-out → `customer_opted_out`; outside 24h window →
   `free_form_outside_24h_window`); blocks return an honest verdict, never a
   phantom delivery. Audited as `whatsapp.admin_reply_sent` /
   `whatsapp.admin_reply_blocked`.
3. **Order lookup by order number** — `GET /api/v1/orders/by-number/:orderNumber`.
   The Orders page has a "Find by #" field.
