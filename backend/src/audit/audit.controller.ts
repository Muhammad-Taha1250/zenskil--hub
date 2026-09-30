import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { ActorType, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

class ListAuditLogQuery {
  @IsOptional() page?: number;
  @IsOptional() pageSize?: number;
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() entityType?: string;
  @IsOptional() @IsUUID() entityId?: string;
  @IsOptional() @IsEnum(ActorType) actorType?: ActorType;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}

/**
 * Read-only audit trail. The underlying table is append-only (Postgres RULEs
 * reject UPDATE/DELETE), so this controller exposes GET only.
 */
@Controller('audit-log')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  async list(@Query() query: ListAuditLogQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
    const where: Prisma.AuditLogWhereInput = {};
    if (query.action?.trim()) where.action = { contains: query.action.trim(), mode: 'insensitive' };
    if (query.entityType?.trim()) where.entityType = query.entityType.trim();
    if (query.entityId) where.entityId = query.entityId;
    if (query.actorType) where.actorType = query.actorType;
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.from) {
      const d = new Date(query.from);
      if (!Number.isNaN(d.getTime())) createdAt.gte = d;
    }
    if (query.to) {
      const d = new Date(query.to);
      if (!Number.isNaN(d.getTime())) createdAt.lte = d;
    }
    if (createdAt.gte || createdAt.lte) where.createdAt = createdAt;
    const [total, items] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, page, pageSize, items };
  }
}
