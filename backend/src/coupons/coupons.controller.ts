import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CouponsService } from './coupons.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../common/decorators/current-admin.decorator';
import { CreateCouponDto } from '../catalog/dto';
import { IsBoolean } from 'class-validator';

class SetActiveDto {
  @IsBoolean() isActive!: boolean;
}

@Controller('coupons')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  list() {
    return this.coupons.listCoupons();
  }

  @Post()
  @Roles('OWNER', 'FINANCE')
  create(@Body() dto: CreateCouponDto, @CurrentAdmin() admin: AuthenticatedAdmin, @Req() req: Request) {
    return this.coupons.createCoupon(
      {
        code: dto.code,
        type: dto.type,
        value: dto.value,
        maxUses: dto.maxUses,
        validFrom: dto.validFrom ? new Date(dto.validFrom) : undefined,
        validTo: dto.validTo ? new Date(dto.validTo) : undefined,
      },
      { type: 'ADMIN', id: admin.id, ip: req.ip ?? null },
    );
  }

  @Patch(':id/active')
  @Roles('OWNER', 'FINANCE')
  setActive(@Param('id') id: string, @Body() dto: SetActiveDto, @CurrentAdmin() admin: AuthenticatedAdmin, @Req() req: Request) {
    return this.coupons.setCouponActive(id, dto.isActive, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null });
  }
}
