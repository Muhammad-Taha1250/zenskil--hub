import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { KbStatus } from '@prisma/client';
import { KnowledgeService } from './knowledge.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../common/decorators/current-admin.decorator';

class CreateDocDto {
  @IsString() slug!: string;
  @IsString() title!: string;
  @IsOptional() @IsString() language?: string;
  @IsString() content!: string;
}

class UpdateDocDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() language?: string;
  @IsOptional() @IsString() content?: string;
}

class SearchQuery {
  @IsString() q!: string;
  @IsOptional() @IsString() language?: string;
}

@Controller('knowledge')
@UseGuards(JwtAuthGuard, RolesGuard)
export class KnowledgeController {
  constructor(private readonly kb: KnowledgeService) {}

  @Get('search')
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  search(@Query() query: SearchQuery) {
    return this.kb.searchKb(query.q, { topK: 5, language: query.language });
  }

  @Get('documents')
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  list(@Query('status') status?: KbStatus) {
    return this.kb.listDocuments(status);
  }

  @Get('documents/:id')
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  get(@Param('id') id: string) {
    return this.kb.getDocument(id);
  }

  @Post('documents')
  @Roles('OWNER', 'SUPPORT')
  create(@Body() dto: CreateDocDto, @CurrentAdmin() admin: AuthenticatedAdmin, @Req() req: Request) {
    return this.kb.createDocument(dto, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null });
  }

  @Patch('documents/:id')
  @Roles('OWNER', 'SUPPORT')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDocDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.kb.updateDocument(id, dto, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null });
  }

  @Post('documents/:id/status')
  @Roles('OWNER')
  setStatus(
    @Param('id') id: string,
    @Body('status') status: KbStatus,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    if (!Object.values(KbStatus).includes(status)) throw new Error('Invalid status');
    return this.kb.setStatus(id, status, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null });
  }
}
