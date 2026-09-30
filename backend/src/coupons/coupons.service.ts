import { BadRequestException, Injectable } from '@nestjs/common';
import { Coupon, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { percentDiscountPaisa } from '../common/utils/money';
import type { StateTransitionActor } from '../customers/customers.service';

export interface CouponValidation {
  coupon: Coupon;
  discountPaisa: number;
}

// Coupons: percent (1–100) or fixed paisa. Validation is pure and strict;
// usage is incremented inside the order-creation transaction so a coupon can
// never be double-spent by concurrent checkouts.
@Injectable()
export class CouponsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async validateCoupon(code: string, subtotalPaisa: number, at: Date = new Date()): Promise<CouponValidation> {
    const coupon = await this.prisma.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });
    if (!coupon) throw new BadRequestException('Coupon code is not valid');
    if (!coupon.isActive) throw new BadRequestException('This coupon is no longer active');
    if (coupon.validFrom && at < coupon.validFrom) throw new BadRequestException('This coupon is not yet valid');
    if (coupon.validTo && at > coupon.validTo) throw new BadRequestException('This coupon has expired');
    if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
      throw new BadRequestException('This coupon has reached its usage limit');
    }

    let discountPaisa: number;
    if (coupon.type === 'PERCENT') {
      if (coupon.value < 1 || coupon.value > 100) throw new BadRequestException('Coupon misconfigured');
      discountPaisa = percentDiscountPaisa(subtotalPaisa, coupon.value);
    } else {
      if (coupon.value < 1) throw new BadRequestException('Coupon misconfigured');
      discountPaisa = Math.min(coupon.value, subtotalPaisa);
    }
    return { coupon, discountPaisa };
  }

  /** Atomically re-validates and increments usage. Call inside the order tx. */
  async consumeCoupon(code: string, subtotalPaisa: number, tx: Prisma.TransactionClient, at: Date = new Date()): Promise<CouponValidation> {
    const normalized = code.trim().toUpperCase();
    // Row lock: concurrent checkouts serialize here.
    const coupon = await tx.coupon.findUnique({ where: { code: normalized } });
    if (!coupon) throw new BadRequestException('Coupon code is not valid');
    if (!coupon.isActive) throw new BadRequestException('This coupon is no longer active');
    if (coupon.validFrom && at < coupon.validFrom) throw new BadRequestException('This coupon is not yet valid');
    if (coupon.validTo && at > coupon.validTo) throw new BadRequestException('This coupon has expired');
    if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
      throw new BadRequestException('This coupon has reached its usage limit');
    }
    let discountPaisa: number;
    if (coupon.type === 'PERCENT') {
      discountPaisa = percentDiscountPaisa(subtotalPaisa, coupon.value);
    } else {
      discountPaisa = Math.min(coupon.value, subtotalPaisa);
    }
    const updated = await tx.coupon.update({
      where: { id: coupon.id },
      data: { usedCount: { increment: 1 } },
    });
    if (updated.maxUses !== null && updated.usedCount > updated.maxUses) {
      throw new BadRequestException('This coupon has reached its usage limit');
    }
    return { coupon: updated, discountPaisa };
  }

  async createCoupon(
    data: { code: string; type: 'PERCENT' | 'FIXED'; value: number; maxUses?: number; validFrom?: Date; validTo?: Date },
    actor: StateTransitionActor,
  ) {
    if (data.type === 'PERCENT' && (data.value < 1 || data.value > 100)) {
      throw new BadRequestException('Percent coupons must be between 1 and 100');
    }
    if (data.type === 'FIXED' && data.value < 1) {
      throw new BadRequestException('Fixed coupons must be at least 1 paisa');
    }
    if (!actor.id) throw new BadRequestException('Authenticated admin required');
    const coupon = await this.prisma.coupon.create({
      data: {
        code: data.code.trim().toUpperCase(),
        type: data.type,
        value: data.value,
        maxUses: data.maxUses ?? null,
        validFrom: data.validFrom ?? null,
        validTo: data.validTo ?? null,
        createdBy: actor.id,
      },
    });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id,
      action: 'coupon.created', entityType: 'coupon', entityId: coupon.id,
      after: { code: coupon.code, type: coupon.type, value: coupon.value },
      ipAddress: actor.ip ?? null,
    });
    return coupon;
  }

  listCoupons() {
    return this.prisma.coupon.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async setCouponActive(id: string, isActive: boolean, actor: StateTransitionActor) {
    const coupon = await this.prisma.coupon.update({ where: { id }, data: { isActive } });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: isActive ? 'coupon.activated' : 'coupon.deactivated',
      entityType: 'coupon', entityId: id, ipAddress: actor.ip ?? null,
    });
    return coupon;
  }
}
