import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('analytics')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('OWNER', 'FINANCE', 'VIEWER')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  overview() {
    return this.analytics.overview();
  }

  @Get('daily')
  daily(@Query('days') days?: string) {
    return this.analytics.dailySeries(Number(days) || 30);
  }

  @Get('attribution')
  attribution() {
    return this.analytics.attribution();
  }
}
