import { UnauthorizedException } from '@nestjs/common';
import { hashSync } from 'bcryptjs';
import { AuthService } from './auth.service';
import { hashPassword } from './password.util';

// Phase 10 (T6): login lockout + bcrypt->argon2id rehash + logout-all.
// Prisma is fully mocked (no DB); the admin row is an in-memory fake.

interface FakeRow {
  id: string;
  email: string;
  name: string;
  role: string;
  passwordHash: string;
  totpEnabled: boolean;
  totpSecret: string | null;
  isActive: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  tokenVersion: number;
  lastLoginAt: Date | null;
}

function applyUpdate(row: FakeRow, data: Record<string, any>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in v) {
      (row as any)[k] = ((row as any)[k] ?? 0) + (v as any).increment;
    } else {
      (row as any)[k] = v;
    }
  }
}

function makeDeps(initial: FakeRow | null) {
  const store: { row: FakeRow | null } = { row: initial ? { ...initial } : null };
  const findUnique = jest.fn(async ({ where }: any): Promise<FakeRow | null> => {
    if (!store.row) return null;
    if (where.email !== undefined) return store.row.email === where.email ? { ...store.row } : null;
    if (where.id !== undefined) return store.row.id === where.id ? { ...store.row } : null;
    return null;
  });
  const prisma = {
    adminUser: {
      findUnique,
      findUniqueOrThrow: jest.fn(async ({ where }: any): Promise<FakeRow> => {
        const r = await findUnique({ where });
        if (!r) throw new Error('not found');
        return r;
      }),
      update: jest.fn(async ({ data }: any): Promise<FakeRow> => {
        if (!store.row) throw new Error('not found');
        applyUpdate(store.row, data);
        return { ...store.row };
      }),
    },
  };
  const jwt = { signAsync: jest.fn(async (payload: any) => `jwt:${JSON.stringify(payload)}`) };
  const audit = { log: jest.fn(async () => ({})) };
  const svc = new AuthService(
    prisma as any,
    jwt as any,
    audit as any,
  );
  const auditActions = () => (audit.log as jest.Mock).mock.calls.map((c) => c[0].action);
  return { svc, store, prisma, jwt, audit, auditActions };
}

async function argon2Row(overrides: Partial<FakeRow> = {}): Promise<FakeRow> {
  return {
    id: 'admin-1',
    email: 'admin@zenskill.test',
    name: 'Admin',
    role: 'OWNER',
    passwordHash: await hashPassword('correct-pw'),
    totpEnabled: false,
    totpSecret: null,
    isActive: true,
    failedLoginAttempts: 0,
    lockedUntil: null,
    tokenVersion: 0,
    lastLoginAt: null,
    ...overrides,
  };
}

describe('AuthService login lockout (Phase 10, T6)', () => {
  it('locks the account for 15 minutes after 5 consecutive failures', async () => {
    const { svc, store, auditActions } = makeDeps(await argon2Row({ failedLoginAttempts: 4 }));
    await expect(svc.login('admin@zenskill.test', 'wrong', undefined, '1.2.3.4')).rejects.toThrow(
      'Invalid email or password',
    );
    expect(store.row!.failedLoginAttempts).toBe(5);
    expect(store.row!.lockedUntil).toBeInstanceOf(Date);
    const skew = store.row!.lockedUntil!.getTime() - (Date.now() + 15 * 60 * 1000);
    expect(Math.abs(skew)).toBeLessThan(5000);
    expect(auditActions()).toContain('auth.login_failed');
  });

  it('rejects even the correct password while locked, with a generic message + auth.login_locked audit', async () => {
    const { svc, auditActions } = makeDeps(
      await argon2Row({ failedLoginAttempts: 5, lockedUntil: new Date(Date.now() + 10 * 60 * 1000) }),
    );
    const err = await svc
      .login('admin@zenskill.test', 'correct-pw', undefined, '1.2.3.4')
      .catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toBe('Invalid email or password'); // no enumeration
    expect(auditActions()).toContain('auth.login_locked');
  });

  it('resets the counter on success and embeds the token version in the JWT', async () => {
    const { svc, store, jwt, auditActions } = makeDeps(
      await argon2Row({ failedLoginAttempts: 2, tokenVersion: 3 }),
    );
    const res = await svc.login('admin@zenskill.test', 'correct-pw', undefined, null);
    expect(res.admin.email).toBe('admin@zenskill.test');
    expect(store.row!.failedLoginAttempts).toBe(0);
    expect(store.row!.lockedUntil).toBeNull();
    const payload = (jwt.signAsync as jest.Mock).mock.calls[0][0];
    expect(payload.tv).toBe(3);
    expect(auditActions()).toContain('auth.login');
  });

  it('rehashes a legacy bcrypt password to argon2id on successful login', async () => {
    const legacy = hashSync('old-bcrypt-pw', 4);
    const { svc, store, audit } = makeDeps(await argon2Row({ passwordHash: legacy }));
    const res = await svc.login('admin@zenskill.test', 'old-bcrypt-pw', undefined, null);
    expect(res.admin.id).toBe('admin-1');
    expect(store.row!.passwordHash.startsWith('$argon2id$')).toBe(true);
    const loginAudit = (audit.log as jest.Mock).mock.calls.find((c) => c[0].action === 'auth.login');
    expect(loginAudit[0].after).toEqual({ passwordRehashed: 'bcrypt->argon2id' });
  });

  it('does not rehash an already-argon2id password', async () => {
    const before = await hashPassword('correct-pw');
    const { svc, store } = makeDeps(await argon2Row({ passwordHash: before }));
    await svc.login('admin@zenskill.test', 'correct-pw', undefined, null);
    expect(store.row!.passwordHash).toBe(before);
  });

  it('returns a generic error for unknown emails (no enumeration) and audits it', async () => {
    const { svc, audit } = makeDeps(null);
    await expect(svc.login('nobody@zenskill.test', 'whatever', undefined, '9.9.9.9')).rejects.toThrow(
      'Invalid email or password',
    );
    const call = (audit.log as jest.Mock).mock.calls.find((c) => c[0].action === 'auth.login_failed');
    expect(call[0].after).toEqual({ email: 'nobody@zenskill.test', unknownAccount: true });
  });
});

describe('AuthService.logoutAll (Phase 10, T6)', () => {
  it('bumps token_version, invalidating all previously issued tokens', async () => {
    const { svc, store, auditActions } = makeDeps(await argon2Row({ tokenVersion: 2 }));
    await svc.logoutAll('admin-1', '1.2.3.4');
    expect(store.row!.tokenVersion).toBe(3);
    expect(auditActions()).toContain('auth.logout_all');
  });
});
