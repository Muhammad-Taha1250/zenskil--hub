# @zenskill-hub/database — Phase 2

Prisma schema, migrations, seeds, and the deterministic order-number generator
for the ZenSkil Hub automation platform.

## Layout

- `prisma/schema.prisma` — 28 tables, strict enums, UUID PKs, `timestamptz` UTC,
  money in integer paisa. `knowledge_base_chunks.embedding` uses pgvector.
- `prisma/migrations/` — versioned migrations. The init migration also creates
  the `vector` extension and Postgres RULEs that make `audit_logs` and
  `webhook_events` append-only (updates/deletes are silently ignored).
- `prisma/seed.ts` — idempotent seed: 5 learning plans at exact spec prices,
  3 inactive product placeholders, 12 DRAFT knowledge-base skeletons,
  system settings, business-hours placeholder.
- `src/orderNumber.ts` — `generateOrderNumber(prisma, at?)` → `ZSH-YYYYMMDD-XXXXX`.
  Per-day counter in `order_sequences`, incremented by an atomic UPSERT, so
  concurrent callers can never collide. Day boundary is Asia/Karachi.
- `tests/verify.ts` — 22 assertions: seed idempotency, exact prices, all 19
  customer states, 100-way concurrent order-number uniqueness, unique
  constraints, enum rejection, append-only rules, integer paisa.

## Commands

```bash
npm install
npm run db:migrate   # prisma migrate dev (creates DB objects)
npm run db:deploy    # prisma migrate deploy (CI/prod)
npm run db:seed      # idempotent seed (also runs via `prisma db seed`)
npm test             # verification suite (needs migrated DATABASE_URL)
```

`DATABASE_URL` comes from `.env` (local dev only, gitignored). See `/.env.example`
at the repo root for the full variable list.

## Environment notes

- **PostgreSQL 16 + pgvector** is required. The migration runs
  `CREATE EXTENSION IF NOT EXISTS vector;`, so the role running migrations
  needs permission to create extensions (superuser, or a DBA pre-creates it).
  Local dev: the `zenskill` role was granted SUPERUSER for this reason.
- **Prisma engine downloads**: if `npm install` fails in the `@prisma/engines`
  postinstall with `ECONNRESET` (flaky egress proxy), the binaries can be
  fetched with curl into the Prisma cache and copied into place:
  ```bash
  ENG=<engines-commit>  # from node_modules/@prisma/engines-version
  PLAT=debian-openssl-3.0.x
  D=~/.cache/prisma/all_commits/$ENG/$PLAT
  mkdir -p $D
  curl -o $D/se.gz "https://binaries.prisma.sh/all_commits/$ENG/$PLAT/schema-engine.gz"
  curl -o $D/qe.gz "https://binaries.prisma.sh/all_commits/$ENG/$PLAT/libquery_engine.so.node.gz"
  (cd $D && gunzip -f se.gz qe.gz && mv se schema-engine-$PLAT && mv qe libquery_engine-$PLAT.so.node)
  for f in $D/schema-engine-$PLAT $D/libquery_engine-$PLAT.so.node; do
    sha256sum $f | awk '{printf "%s",$1}' > $f.sha256
  done
  cp $D/schema-engine-$PLAT $D/libquery_engine-$PLAT.so.node node_modules/@prisma/engines/
  cp $D/libquery_engine-$PLAT.so.node node_modules/prisma/
  ```
- Seed config currently lives in `package.json#prisma` (deprecated warning in
  Prisma 6.19). Migrate to `prisma.config.ts` before upgrading to Prisma 7.
