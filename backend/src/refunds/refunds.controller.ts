import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { RefundsService } from './refunds.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../common/decorators/current-admin.decorator';

class RequestRefundDto {
  @IsString() paymentId!: string;
  @IsInt() @Min(1) amountPaisa!: number;
  @IsString() reason!: string;
}

class MarkExecutedDto {
  @IsString() providerRefundId!: string;
}

@Controller('refunds')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get()
  @Roles('OWNER', 'FINANCE', 'VIEWER')
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.refunds.listRefunds({ page: Number(page) || 1, pageSize: Number(pageSize) || 20 });
  }

  /** Creates the refund request + pending approval. A different admin must decide. */
  @Post('request')
  @Roles('OWNER', 'FINANCE')
  request(
    @Body() dto: RequestRefundDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.refunds.requestRefund(dto.paymentId, admin.id, dto.amountPaisa, dto.reason, req.ip ?? null);
  }

  @Post(':id/mark-executed')
  @Roles('OWNER', 'FINANCE')
  markExecuted(
    @Param('id') id: string,
    @Body() dto: MarkExecutedDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.refunds.markExecuted(id, dto.providerRefundId, {
      type: 'ADMIN', id: admin.id, ip: req.ip ?? null,
    });
  }
}
