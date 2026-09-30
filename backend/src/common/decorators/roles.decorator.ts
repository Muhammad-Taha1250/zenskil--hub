import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';

/** Restrict a route to the given admin roles. Combine with JwtAuthGuard. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
