-- Phase 10 (Security): admin login hardening (T6).
-- Applies on next `prisma migrate deploy`. Cannot be applied in the current
-- dev environment (PostgreSQL is down) — pending as of 2026-09-24.
--
-- failed_login_attempts / locked_until implement the 5-failures -> 15-minute
-- lockout policy. token_version implements JWT session revocation ("log out
-- all sessions", post-password-change revocation): the JWT payload carries
-- `tv`, and JwtAuthGuard rejects any token whose `tv` no longer matches the
-- row. Bumping token_version invalidates every previously issued token.
ALTER TABLE "admin_users" ADD COLUMN "failed_login_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "admin_users" ADD COLUMN "locked_until" TIMESTAMPTZ(6);
ALTER TABLE "admin_users" ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;
