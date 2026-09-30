import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';

// Verifies the Bearer JWT and attaches the admin identity to req.admin.
// Inactive admins are rejected even with a valid token.
//
// Session revocation (Phase 10, T6): the JWT payload carries `tv` (the
// admin_users.token_version at issue time). The guard compares it against
// the live row; a mismatch means the admin hit POST /auth/logout-all (or a
// post-compromise revocation) after this token was issued, and the token is
// rejected. Tokens issued before Phase 10 have no `tv` claim — they are
// treated as tv 0, so any post-Phase-10 revocation still kills them, and
// they expire on their own 8h absolute lifetime anyway.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    let payload: { sub: string; email: string; role: string; tv?: number };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, name: true, role: true, isActive: true, tokenVersion: true },
    });
    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Admin account is disabled');
    }
    if ((payload.tv ?? 0) !== admin.tokenVersion) {
      await this.audit
        .log({
          actorType: 'ADMIN',
          actorId: admin.id,
          action: 'auth.session_revoked',
          entityType: 'admin_user',
          entityId: admin.id,
          after: { reason: 'token_version_mismatch' },
          ipAddress: req.ip ?? null,
        })
        .catch(() => {
          /* audit must never break auth */
        });
      throw new UnauthorizedException('Session revoked — please sign in again');
    }
    (req as unknown as { admin: typeof admin }).admin = admin;
    return true;
  }
}
