import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { SettingsService } from './settings.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../common/decorators/current-admin.decorator';

class UpsertSettingDto {
  @IsString() key!: string;
  value!: unknown;
  @IsOptional() @IsString() description?: string;
}

class UpsertHoursDto {
  @IsInt() @Min(0) @Max(6) dayOfWeek!: number;
  @IsOptional() @IsString() openTime?: string | null;
  @IsOptional() @IsString() closeTime?: string | null;
  @IsOptional() isClosed?: boolean;
}

@Controller('settings')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @Roles('OWNER', 'FINANCE', 'VIEWER')
  list() {
    return this.settings.getAllSettings();
  }

  @Post()
  @Roles('OWNER')
  upsert(@Body() dto: UpsertSettingDto, @CurrentAdmin() admin: AuthenticatedAdmin, @Req() req: Request) {
    return this.settings.updateSetting(dto.key, dto.value, {
      type: 'ADMIN', id: admin.id, ip: req.ip ?? null,
    }, dto.description);
  }

  @Get('business-hours')
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  listHours() {
    return this.settings.listBusinessHours();
  }

  @Patch('business-hours')
  @Roles('OWNER')
  upsertHours(@Body() dto: UpsertHoursDto, @CurrentAdmin() admin: AuthenticatedAdmin, @Req() req: Request) {
    return this.settings.upsertBusinessHours(dto.dayOfWeek, {
      openTime: dto.openTime ?? null,
      closeTime: dto.closeTime ?? null,
      isClosed: dto.isClosed ?? false,
    }, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null });
  }
}
