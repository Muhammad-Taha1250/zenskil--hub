import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { decryptSecret, encryptSecret } from './totp-crypto';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp.service';
import { hashPassword, verifyPassword } from './password.util';

// Brute-force lockout policy (Phase 10, T6): 5 consecutive failures -> the
// account is locked for 15 minutes. The counter lives on admin_users so it
// survives process restarts and is shared across instances. All failures
// return the generic "Invalid email or password" to avoid user enumeration
// (an attacker can't distinguish "no such account" from "wrong password" or
// "locked" — the audit log is the only place the distinction appears).
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export interface LoginResult {
  accessToken: string;
  admin: { id: string; email: string; name: string; role: string; totpEnabled: boolean };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  /** New hashes are argon2id (see password.util.ts). */
  static async hashPassword(password: string): Promise<string> {
    return hashPassword(password);
  }

  async validateAdmin(email: string, password: string): Promise<{
    id: string;
    email: string;
    name: string;
    role: string;
    totpEnabled: boolean;
    totpSecret: string | null;
    tokenVersion: number;
    needsRehash: boolean;
  } | null> {
    const admin = await this.prisma.adminUser.findUnique({ where: { email: email.toLowerCase() } });
    if (!admin || !admin.isActive) return null;
    const { ok, needsRehash } = await verifyPassword(password, admin.passwordHash);
    if (!ok) return null;
    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      totpEnabled: admin.totpEnabled,
      totpSecret: admin.totpSecret,
      tokenVersion: admin.tokenVersion,
      needsRehash,
    };
  }

  private async recordFailedAttempt(adminId: string | null, email: string, ip: string | null): Promise<void> {
    if (adminId) {
      const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
      const attempts = (admin?.failedLoginAttempts ?? 0) + 1;
      const data: { failedLoginAttempts: number; lockedUntil?: Date | null } = {
        failedLoginAttempts: attempts,
      };
      if (attempts >= MAX_LOGIN_ATTEMPTS) {
        data.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
      }
      await this.prisma.adminUser.update({ where: { id: adminId }, data });
      await this.audit.log({
        actorType: 'ADMIN',
        actorId: adminId,
        action: 'auth.login_failed',
        entityType: 'admin_user',
        entityId: adminId,
        after: { failedAttempts: attempts, locked: attempts >= MAX_LOGIN_ATTEMPTS },
        ipAddress: ip,
      });
    } else {
      // Unknown email: no counter to bump (nothing to lock), but audit the
      // attempt so enumeration probes are visible. No actor id recorded.
      await this.audit.log({
        actorType: 'ADMIN',
        action: 'auth.login_failed',
        entityType: 'admin_user',
        after: { email: email.toLowerCase(), unknownAccount: true },
        ipAddress: ip,
      });
    }
  }

  async login(email: string, password: string, totpCode: string | undefined, ip: string | null): Promise<LoginResult> {
    const normalizedEmail = email.toLowerCase();
    const row = await this.prisma.adminUser.findUnique({ where: { email: normalizedEmail } });

    // Lockout is checked BEFORE password verification (cheap, and it must
    // hold even for correct passwords). Generic message either way.
    if (row && row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
      await this.audit.log({
        actorType: 'ADMIN',
        actorId: row.id,
        action: 'auth.login_locked',
        entityType: 'admin_user',
        entityId: row.id,
        after: { lockedUntil: row.lockedUntil.toISOString() },
        ipAddress: ip,
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    const admin = await this.validateAdmin(email, password);
    if (!admin) {
      await this.recordFailedAttempt(row?.id ?? null, email, ip);
      throw new UnauthorizedException('Invalid email or password');
    }
    if (admin.totpEnabled) {
      if (!totpCode || !admin.totpSecret || !verifyTotp(decryptSecret(admin.totpSecret), totpCode)) {
        await this.recordFailedAttempt(admin.id, email, ip);
        await this.audit.log({
          actorType: 'ADMIN',
          actorId: admin.id,
          action: 'auth.login_failed_totp',
          entityType: 'admin_user',
          entityId: admin.id,
          ipAddress: ip,
        });
        throw new UnauthorizedException('Invalid two-factor code');
      }
    }
    // Transparent bcrypt -> argon2id migration: the password just verified,
    // so re-hash with argon2id and persist it. One write per legacy account,
    // ever. Also resets the lockout counter.
    const data: {
      lastLoginAt: Date;
      failedLoginAttempts: number;
      lockedUntil: null;
      passwordHash?: string;
    } = {
      lastLoginAt: new Date(),
      failedLoginAttempts: 0,
      lockedUntil: null,
    };
    if (admin.needsRehash) {
      data.passwordHash = await hashPassword(password);
    }
    await this.prisma.adminUser.update({ where: { id: admin.id }, data });
    const accessToken = await this.jwt.signAsync({
      sub: admin.id,
      email: admin.email,
      role: admin.role,
      // Token version: JwtAuthGuard rejects tokens whose tv no longer matches
      // the row (logout-all / post-compromise revocation).
      tv: admin.tokenVersion,
    });
    await this.audit.log({
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'auth.login',
      entityType: 'admin_user',
      entityId: admin.id,
      after: admin.needsRehash ? { passwordRehashed: 'bcrypt->argon2id' } : undefined,
      ipAddress: ip,
    });
    return {
      accessToken,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        totpEnabled: admin.totpEnabled,
      },
    };
  }

  /**
   * "Log out all sessions" for the caller's own account: bumps token_version,
   * invalidating every previously issued JWT (they fail the tv check in
   * JwtAuthGuard within one request). Use after a suspected compromise or a
   * password change. The caller's current token dies too — the client must
   * re-login.
   */
  async logoutAll(adminId: string, ip: string | null): Promise<void> {
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { tokenVersion: { increment: 1 } },
    });
    await this.audit.log({
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'auth.logout_all',
      entityType: 'admin_user',
      entityId: adminId,
      ipAddress: ip,
    });
  }

  /** Step 1 of 2FA enrolment: returns a fresh secret + otpauth URL. Not yet saved. */
  async beginTotpSetup(adminId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    const secret = generateTotpSecret();
    return { secret, otpauthUrl: otpauthUrl(secret, admin.email) };
  }

  /** Step 2: verifies the code against the fresh secret, then enables 2FA. */
  async enableTotp(adminId: string, secret: string, code: string): Promise<void> {
    if (!verifyTotp(secret, code)) throw new UnauthorizedException('Invalid two-factor code');
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { totpSecret: encryptSecret(secret), totpEnabled: true },
    });
    await this.audit.log({
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'auth.totp_enabled',
      entityType: 'admin_user',
      entityId: adminId,
    });
  }

  async disableTotp(adminId: string, password: string, code: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    if (!(await verifyPassword(password, admin.passwordHash)).ok) {
      throw new UnauthorizedException('Invalid password');
    }
    if (admin.totpEnabled && admin.totpSecret && !verifyTotp(decryptSecret(admin.totpSecret), code)) {
      throw new UnauthorizedException('Invalid two-factor code');
    }
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { totpSecret: null, totpEnabled: false },
    });
    await this.audit.log({
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'auth.totp_disabled',
      entityType: 'admin_user',
      entityId: adminId,
    });
  }
}
