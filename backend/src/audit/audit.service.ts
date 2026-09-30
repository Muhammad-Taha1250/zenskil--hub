import { Injectable } from '@nestjs/common';
import { ActorType, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { currentRequestId } from '../common/logger/request-context';

export interface AuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
}

type DbClient = PrismaService | Prisma.TransactionClient;

// Append-only audit writer. audit_logs rows can never be updated or deleted
// (Postgres RULEs from the Phase 2 migration); this service only inserts.
// Pass the transaction client as the second argument to write atomically
// inside a $transaction block.
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry, db: DbClient = this.prisma): Promise<void> {
    await db.auditLog.create({
      data: {
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: (entry.before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (entry.after ?? undefined) as Prisma.InputJsonValue | undefined,
        ipAddress: entry.ipAddress ?? null,
        requestId: currentRequestId() ?? null,
      },
    });
  }
}
