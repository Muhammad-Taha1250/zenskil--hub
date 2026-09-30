import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { StateTransitionActor } from '../customers/customers.service';

// Catalog is the ONLY source of product/plan/price truth. The AI and the
// WhatsApp flows read prices from here — never from prompts, never from the
// client. Plan price changes go through the high-risk approval flow
// (PendingApproval PRICE_CHANGE) instead of applying immediately.
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  listProducts(activeOnly = true) {
    return this.prisma.product.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: { sortOrder: 'asc' },
      include: { plans: { where: activeOnly ? { isActive: true } : {}, orderBy: { sortOrder: 'asc' } } },
    });
  }

  async getProduct(slug: string) {
    const product = await this.prisma.product.findUnique({
      where: { slug },
      include: { plans: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } },
    });
    if (!product) throw new NotFoundException(`Product not found: ${slug}`);
    return product;
  }

  listPlans(productId: string, activeOnly = true) {
    return this.prisma.plan.findMany({
      where: { productId, ...(activeOnly ? { isActive: true } : {}) },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async getPlan(id: string) {
    const plan = await this.prisma.plan.findUnique({
      where: { id },
      include: { product: true },
    });
    if (!plan) throw new NotFoundException('Plan not found');
    return plan;
  }

  /** The plan the AI / menus may sell: active plan on an active product. */
  async getSellablePlan(planId: string) {
    const plan = await this.getPlan(planId);
    if (!plan.isActive || !plan.product.isActive) {
      throw new BadRequestException('This plan is not currently available');
    }
    return plan;
  }

  async createProduct(
    data: { slug: string; name: string; category: string; shortDescription?: string; longDescription?: string; sortOrder?: number; metadata?: unknown },
    actor: StateTransitionActor,
  ) {
    const product = await this.prisma.product.create({
      data: {
        slug: data.slug,
        name: data.name,
        category: data.category,
        shortDescription: data.shortDescription,
        longDescription: data.longDescription,
        sortOrder: data.sortOrder ?? 0,
        metadata: (data.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'catalog.product_created', entityType: 'product', entityId: product.id,
      after: { slug: product.slug, name: product.name }, ipAddress: actor.ip ?? null,
    });
    return product;
  }

  async updateProduct(id: string, data: { name?: string; category?: string; shortDescription?: string; longDescription?: string; fulfillmentNotes?: string | null; isActive?: boolean; sortOrder?: number }, actor: StateTransitionActor) {
    const before = await this.prisma.product.findUniqueOrThrow({ where: { id } });
    const updated = await this.prisma.product.update({ where: { id }, data });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'catalog.product_updated', entityType: 'product', entityId: id,
      before: { name: before.name, isActive: before.isActive },
      after: { name: updated.name, isActive: updated.isActive },
      ipAddress: actor.ip ?? null,
    });
    return updated;
  }

  async createPlan(
    data: { productId: string; name: string; durationMonths: number; durationDays: number; pricePaisa: number; sortOrder?: number },
    actor: StateTransitionActor,
  ) {
    if (!Number.isInteger(data.pricePaisa) || data.pricePaisa <= 0) {
      throw new BadRequestException('pricePaisa must be a positive integer');
    }
    const plan = await this.prisma.plan.create({ data: { ...data, sortOrder: data.sortOrder ?? 0 } });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'catalog.plan_created', entityType: 'plan', entityId: plan.id,
      after: { name: plan.name, pricePaisa: plan.pricePaisa }, ipAddress: actor.ip ?? null,
    });
    return plan;
  }

  /**
   * Plan updates. Price changes NEVER apply directly — they create a
   * PRICE_CHANGE pending approval (spec §42/§51). Everything else applies now.
   * Returns the plan plus, when applicable, the created approval id.
   */
  async updatePlan(
    id: string,
    data: { name?: string; durationMonths?: number; durationDays?: number; pricePaisa?: number; isActive?: boolean; sortOrder?: number },
    actor: StateTransitionActor,
  ): Promise<{ plan: Awaited<ReturnType<CatalogService['getPlan']>>; priceChangeApprovalId: string | null }> {
    const plan = await this.prisma.plan.findUniqueOrThrow({ where: { id } });
    const { pricePaisa, ...rest } = data;
    let priceChangeApprovalId: string | null = null;

    if (pricePaisa !== undefined && pricePaisa !== plan.pricePaisa) {
      if (!Number.isInteger(pricePaisa) || pricePaisa <= 0) {
        throw new BadRequestException('pricePaisa must be a positive integer');
      }
      if (actor.type !== 'ADMIN' || !actor.id) {
        throw new BadRequestException('Price changes require an authenticated admin');
      }
      const approval = await this.prisma.pendingApproval.create({
        data: {
          actionType: 'PRICE_CHANGE',
          entityType: 'plan',
          entityId: id,
          requestedBy: actor.id,
          payload: { planId: id, oldPricePaisa: plan.pricePaisa, newPricePaisa: pricePaisa },
          reason: 'Price change requested via catalog update',
        },
      });
      priceChangeApprovalId = approval.id;
      await this.audit.log({
        actorType: actor.type, actorId: actor.id,
        action: 'catalog.price_change_requested', entityType: 'pending_approval', entityId: approval.id,
        before: { pricePaisa: plan.pricePaisa }, after: { pricePaisa },
        ipAddress: actor.ip ?? null,
      });
    }

    const result = await this.prisma.plan.update({ where: { id }, data: rest });
    if (Object.keys(rest).length > 0) {
      await this.audit.log({
        actorType: actor.type, actorId: actor.id ?? null,
        action: 'catalog.plan_updated', entityType: 'plan', entityId: id,
        after: rest, ipAddress: actor.ip ?? null,
      });
    }
    void result;
    return { plan: await this.getPlan(id), priceChangeApprovalId };
  }

  /** Applies an approved price change. Called only by the approvals flow. */
  async applyPriceChange(planId: string, newPricePaisa: number, db: PrismaService | Prisma.TransactionClient = this.prisma) {
    return db.plan.update({ where: { id: planId }, data: { pricePaisa: newPricePaisa } });
  }
}
