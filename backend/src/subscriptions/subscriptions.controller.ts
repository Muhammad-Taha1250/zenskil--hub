import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { SubscriptionStatus } from '@prisma/client';
import { SubscriptionsService } from './subscriptions.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../common/decorators/current-admin.decorator';

class ListQuery {
  @IsOptional() page?: number;
  @IsOptional() pageSize?: number;
  @IsOptional() @IsEnum(SubscriptionStatus) status?: SubscriptionStatus;
  @IsOptional() @IsString() customerId?: string;
}

class CancelDto {
  @IsString() reason!: string;
}

@Controller('subscriptions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Get()
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  list(@Query() query: ListQuery) {
    return this.subs.listSubscriptions({
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 20,
      status: query.status,
      customerId: query.customerId,
    });
  }

  @Get(':id')
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  get(@Param('id') id: string) {
    return this.subs.getSubscription(id);
  }

  @Post(':id/cancel')
  @Roles('OWNER', 'FINANCE')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.subs.cancelSubscription(id, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null }, dto.reason);
  }

  /** Manual trigger for the sweeper (the scheduler calls this in Phase 4). */
  @Post('sweeper/run')
  @Roles('OWNER', 'FINANCE')
  runSweeper() {
    return this.subs.runExpirySweeper();
  }
}
