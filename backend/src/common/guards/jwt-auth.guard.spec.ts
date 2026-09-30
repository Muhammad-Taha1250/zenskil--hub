import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

// Phase 10 (T6): token-version revocation. Nest DI is bypassed — the guard
// is constructed directly with mocked collaborators (no DB).

function makeGuard(adminRow: any, payload: any) {
  const jwt = { verifyAsync: jest.fn(async () => payload) };
  const prisma = {
    adminUser: { findUnique: jest.fn(async () => adminRow) },
  };
  const audit = { log: jest.fn(async () => ({})) };
  const guard = new JwtAuthGuard(jwt as any, prisma as any, audit as any);
  const ctx: any = {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: 'Bearer tok' }, ip: '1.2.3.4' }),
    }),
  };
  const auditActions = () => (audit.log as jest.Mock).mock.calls.map((c) => c[0].action);
  return { guard, ctx, jwt, prisma, audit, auditActions };
}

const baseRow = {
  id: 'admin-1',
  email: 'a@x.test',
  name: 'A',
  role: 'OWNER',
  isActive: true,
  tokenVersion: 0,
};

describe('JwtAuthGuard token-version revocation (Phase 10, T6)', () => {
  it('accepts a token whose tv matches the row and attaches the admin', async () => {
    const { guard, ctx } = makeGuard(baseRow, { sub: 'admin-1', email: 'a@x.test', role: 'OWNER', tv: 0 });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('accepts a pre-Phase-10 token (no tv claim) while tokenVersion is still 0', async () => {
    const { guard, ctx } = makeGuard(baseRow, { sub: 'admin-1', email: 'a@x.test', role: 'OWNER' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects a pre-Phase-10 token after a revocation bumped the version', async () => {
    const { guard, ctx, auditActions } = makeGuard(
      { ...baseRow, tokenVersion: 1 },
      { sub: 'admin-1', email: 'a@x.test', role: 'OWNER' }, // no tv -> treated as 0
    );
    const err = await guard.canActivate(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toMatch(/revoked/i);
    expect(auditActions()).toContain('auth.session_revoked');
  });

  it('rejects a token whose tv no longer matches (logout-all)', async () => {
    const { guard, ctx, auditActions } = makeGuard(
      { ...baseRow, tokenVersion: 2 },
      { sub: 'admin-1', email: 'a@x.test', role: 'OWNER', tv: 1 },
    );
    await expect(guard.canActivate(ctx)).rejects.toThrow(/revoked/i);
    expect(auditActions()).toContain('auth.session_revoked');
  });

  it('still rejects inactive admins', async () => {
    const { guard, ctx } = makeGuard(
      { ...baseRow, isActive: false },
      { sub: 'admin-1', email: 'a@x.test', role: 'OWNER', tv: 0 },
    );
    await expect(guard.canActivate(ctx)).rejects.toThrow('Admin account is disabled');
  });
});
