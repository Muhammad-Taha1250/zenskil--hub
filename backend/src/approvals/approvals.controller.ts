import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApprovalsService } from './approvals.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../common/decorators/current-admin.decorator';

class ListQuery {
  @IsOptional() page?: number;
  @IsOptional() pageSize?: number;
  @IsOptional() @IsEnum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']) status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  @IsOptional() @IsString() actionType?: string;
}

class DecideDto {
  @IsEnum(['APPROVE', 'REJECT']) decision!: 'APPROVE' | 'REJECT';
  @IsOptional() @IsString() reason?: string;
}

@Controller('approvals')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @Roles('OWNER', 'FINANCE', 'VIEWER')
  list(@Query() query: ListQuery) {
    return this.approvals.listApprovals({
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 20,
      status: query.status,
      actionType: query.actionType,
    });
  }

  @Get(':id')
  @Roles('OWNER', 'FINANCE', 'VIEWER')
  get(@Param('id') id: string) {
    return this.approvals.getApproval(id);
  }

  @Post(':id/decide')
  @Roles('OWNER', 'FINANCE')
  decide(
    @Param('id') id: string,
    @Body() dto: DecideDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.approvals.decide(id, admin.id, dto.decision, dto.reason ?? '', req.ip ?? null);
  }
}
