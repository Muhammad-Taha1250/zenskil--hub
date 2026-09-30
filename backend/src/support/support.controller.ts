import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { TicketAuthorType, TicketPriority, TicketStatus } from '@prisma/client';
import { SupportService } from './support.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../common/decorators/current-admin.decorator';

class ListQuery {
  @IsOptional() page?: number;
  @IsOptional() pageSize?: number;
  @IsOptional() @IsEnum(TicketStatus) status?: TicketStatus;
  @IsOptional() @IsEnum(TicketPriority) priority?: TicketPriority;
  @IsOptional() @IsString() assignedTo?: string;
}

class CreateTicketDto {
  @IsString() customerId!: string;
  @IsString() subject!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() orderId?: string;
  @IsOptional() @IsEnum(TicketPriority) priority?: TicketPriority;
}

class AddMessageDto {
  @IsEnum(TicketAuthorType) authorType!: TicketAuthorType;
  @IsString() bodyText!: string;
}

class AssignDto {
  @IsString() assigneeId!: string;
}

class SetStatusDto {
  @IsEnum(TicketStatus) status!: TicketStatus;
}

@Controller('support/tickets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  list(@Query() query: ListQuery) {
    return this.support.listTickets({
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 20,
      status: query.status,
      priority: query.priority,
      assignedTo: query.assignedTo,
    });
  }

  @Get(':id')
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  get(@Param('id') id: string) {
    return this.support.getTicket(id);
  }

  @Post()
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  create(@Body() dto: CreateTicketDto, @CurrentAdmin() admin: AuthenticatedAdmin, @Req() req: Request) {
    return this.support.createTicket(
      dto.customerId,
      { subject: dto.subject, description: dto.description, orderId: dto.orderId, priority: dto.priority, authorType: 'AGENT' },
      { type: 'ADMIN', id: admin.id, ip: req.ip ?? null },
    );
  }

  @Post(':id/messages')
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  addMessage(
    @Param('id') id: string,
    @Body() dto: AddMessageDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.support.addMessage(id, dto.authorType, admin.id, dto.bodyText, {
      type: 'ADMIN', id: admin.id, ip: req.ip ?? null,
    });
  }

  @Patch(':id/assign')
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  assign(
    @Param('id') id: string,
    @Body() dto: AssignDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.support.assignTicket(id, dto.assigneeId, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null });
  }

  @Patch(':id/status')
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  setStatus(
    @Param('id') id: string,
    @Body() dto: SetStatusDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.support.setStatus(id, dto.status, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null });
  }
}
