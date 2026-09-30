import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';

// Enforces @Roles(...) after JwtAuthGuard has attached req.admin.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const req = context.switchToHttp().getRequest();
    const admin = req.admin as { role?: string } | undefined;
    if (!admin?.role || !required.includes(admin.role as Role)) {
      throw new ForbiddenException('Insufficient role for this action');
    }
    return true;
  }
}
