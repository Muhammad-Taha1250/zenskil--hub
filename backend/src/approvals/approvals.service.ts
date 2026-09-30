import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ApprovalActionType, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RefundsService } from '../refunds/refunds.service';
import { SettingsService } from '../settings/settings.service';
import type { StateTransitionActor } from '../customers/customers.service';

// General approval workflow (spec §49/§51):
//   - Anything the AI (or an admin) may not do alone lands here as PENDING:
//     refunds, price changes, policy/credential changes, manual payment
//     decisions (recorded for audit, not double-decided).
//   - Decider must be OWNER/FINANCE, must differ from the requester, and
//     cannot self-decide unless they are the ONLY admin on record.
//   - Idempotent: deciding twice returns the first outcome; expired approvals
//     are rejected (stale approval).
//   - Decision reason is mandatory on REJECT (and recorded on APPROVE).
//   - On APPROVE the matching side effect is applied through the owning
//     service; on REJECT only the rejection side effect runs.
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly refunds: RefundsService,
    private readonly settings: SettingsService,
  ) {}

  private async actorHasDecideRights(adminId: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    if (!['OWNER', 'FINANCE'].includes(admin.role) || !admin.isActive) {
      throw new ForbiddenException('Approval decisions require an active OWNER or FINANCE admin');
    }
  }

  async getApproval(id: string) {
    const approval = await this.prisma.pendingApproval.findUnique({
      where: { id },
      include: {
        requester: { select: { id: true, name: true, email: true } },
        decider: { select: { id: true, name: true, email: true } },
      },
    });
    if (!approval) throw new BadRequestException('Approval not found');
    return approval;
  }

  async listApprovals(params: { page?: number; pageSize?: number; status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'; actionType?: string }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const where: Prisma.PendingApprovalWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.actionType) where.actionType = params.actionType as ApprovalActionType;
    const [total, items] = await this.prisma.$transaction([
      this.prisma.pendingApproval.count({ where }),
      this.prisma.pendingApproval.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          requester: { select: { id: true, name: true, email: true } },
          decider: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);
    return { total, page, pageSize, items };
  }

  async createApproval(
    actionType: 'REFUND' | 'PRICE_CHANGE' | 'POLICY_CHANGE' | 'CREDENTIAL_CHANGE' | 'MANUAL_PAYMENT',
    entityType: string,
    entityId: string,
    payload: unknown,
    requesterId: string,
    reason: string,
    expiresAt: Date | null,
    ip: string | null,
  ) {
    const approval = await this.prisma.pendingApproval.create({
      data: {
        actionType,
        entityType,
        entityId,
        payload: payload as Prisma.InputJsonValue,
        requestedBy: requesterId,
        reason,
        expiresAt,
      },
    });
    await this.audit.log({
      actorType: 'ADMIN', actorId: requesterId,
      action: 'approval.requested', entityType: 'pending_approval', entityId: approval.id,
      after: { actionType, entityType, entityId },
      ipAddress: ip,
    });
    return approval;
  }

  async decide(
    approvalId: string,
    deciderId: string,
    decision: 'APPROVE' | 'REJECT',
    reason: string,
    ip: string | null,
  ) {
    await this.actorHasDecideRights(deciderId);
    if (decision === 'REJECT' && !reason?.trim()) {
      throw new BadRequestException('A rejection reason is mandatory');
    }

    // Update the approval row and mark self-decision under a single row lock.
    const outcome = await this.prisma.$transaction(async (tx) => {
      const approval = await tx.pendingApproval.findUniqueOrThrow({ where: { id: approvalId } });
      if (approval.status !== 'PENDING') {
        return { alreadyDecided: true, approval };
      }
      if (approval.expiresAt && approval.expiresAt < new Date()) {
        await tx.pendingApproval.update({ where: { id: approvalId }, data: { status: 'EXPIRED' } });
        throw new BadRequestException('This approval has expired');
      }

      let selfDecided = false;
      if (approval.requestedBy === deciderId) {
        const adminCount = await tx.adminUser.count({ where: { isActive: true } });
        if (adminCount > 1) {
          throw new ForbiddenException('Self-decision is not allowed while more than one admin exists');
        }
        selfDecided = true;
      }

      const updated = await tx.pendingApproval.update({
        where: { id: approvalId },
        data: {
          status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          decidedBy: deciderId,
          decidedAt: new Date(),
          decisionNote: reason?.trim() || null,
        },
      });

      await this.audit.log(
        {
          actorType: 'ADMIN', actorId: deciderId,
          action: decision === 'APPROVE' ? 'approval.approved' : 'approval.rejected',
          entityType: 'pending_approval', entityId: approvalId,
          before: { status: 'PENDING' },
          after: { status: updated.status, selfDecided, note: reason?.trim() ?? null },
          ipAddress: ip,
        },
        tx,
      );
      return { alreadyDecided: false, approval: updated, selfDecided };
    });

    // Side effects are idempotent, so a retry after a partial failure
    // re-applies them instead of leaving the approval stuck as decided.
    const actor: StateTransitionActor = { type: 'ADMIN', id: deciderId, ip };
    if (outcome.alreadyDecided) {
      if (outcome.approval.status === 'APPROVED') {
        await this.applyApprovalSideEffect(outcome.approval, actor);
      } else if (outcome.approval.status === 'REJECTED') {
        await this.applyRejectionSideEffect(outcome.approval, actor);
      }
      return { idempotent: true, approval: outcome.approval };
    }

    // Apply the side effect OUTSIDE the lock transaction (each handler is its own transaction).
    if (decision === 'APPROVE') {
      await this.applyApprovalSideEffect(outcome.approval, actor);
    } else {
      await this.applyRejectionSideEffect(outcome.approval, actor);
    }
    return { idempotent: false, approval: outcome.approval };
  }

  private async applyApprovalSideEffect(
    approval: { actionType: string; payload: unknown; id: string },
    actor: StateTransitionActor,
  ): Promise<void> {
    const payload = approval.payload as Record<string, unknown>;
    switch (approval.actionType) {
      case 'REFUND':
        await this.refunds.applyApproval(approval.id, actor.id!, actor.ip ?? null);
        break;
      case 'POLICY_CHANGE':
        await this.settings.applyPolicyChange(
          payload as { settingKey: string; value: unknown }, actor,
        );
        break;
      case 'CREDENTIAL_CHANGE':
        await this.settings.applyCredentialChange(
          payload as { settingKey: string; value: unknown; note?: string }, actor,
        );
        break;
      case 'PRICE_CHANGE': {
        // Applies the already-approved price directly — never routes back
        // through CatalogService.updatePlan (which would mint a NEW approval).
        // Concurrency guard: the price must still be what the requester saw
        // (or already the approved value, for idempotent retries).
        const p = payload as { planId: string; newPricePaisa: number; oldPricePaisa: number };
        const before = await this.prisma.plan.findUniqueOrThrow({ where: { id: p.planId } });
        if (before.pricePaisa !== p.newPricePaisa && before.pricePaisa !== p.oldPricePaisa) {
          throw new BadRequestException(
            `Plan price changed since approval was requested (expected ${p.oldPricePaisa}, found ${before.pricePaisa}) — request a new approval`,
          );
        }
        if (before.pricePaisa !== p.newPricePaisa) {
          await this.prisma.plan.update({ where: { id: p.planId }, data: { pricePaisa: p.newPricePaisa } });
          await this.audit.log({
            actorType: actor.type, actorId: actor.id ?? null,
            action: 'catalog.price_changed', entityType: 'plan', entityId: p.planId,
            before: { pricePaisa: before.pricePaisa }, after: { pricePaisa: p.newPricePaisa },
            ipAddress: actor.ip ?? null,
          });
        }
        break;
      }
      case 'MANUAL_PAYMENT':
        // Manual payment decisions are executed at decision time by the
        // payments module; the approval row is the audit record. Nothing more
        // to apply here.
        break;
      default:
        throw new BadRequestException(`Unknown approval action type: ${approval.actionType}`);
    }
  }

  private async applyRejectionSideEffect(
    approval: { actionType: string; id: string },
    actor: StateTransitionActor,
  ): Promise<void> {
    switch (approval.actionType) {
      case 'REFUND':
        await this.refunds.applyRejection(approval.id, actor.id!, undefined, actor.ip ?? null);
        break;
      default:
        // Other action types have no rejection side effect.
        break;
    }
  }
}
