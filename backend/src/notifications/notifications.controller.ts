import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { NotificationStatus } from '@prisma/client';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../common/decorators/current-admin.decorator';

class QueueDto {
  @IsString() customerId!: string;
  @IsOptional() @IsString() templateName?: string;
  @IsOptional() payload?: Record<string, unknown>;
}

@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: NotificationStatus,
  ) {
    return this.notifications.list({ page: Number(page) || 1, pageSize: Number(pageSize) || 20, status });
  }

  @Post('queue')
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  queue(@Body() dto: QueueDto, @CurrentAdmin() admin: AuthenticatedAdmin, @Req() req: Request) {
    return this.notifications.queue(dto.customerId, {
      templateName: dto.templateName,
      payload: dto.payload,
    }, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null });
  }

  @Post(':id/send')
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  send(@Param('id') id: string) {
    return this.notifications.sendQueued(id);
  }

  @Post('flush')
  @Roles('OWNER', 'FINANCE')
  flush() {
    return this.notifications.flushQueue();
  }
}
