import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { OrdersService } from './orders.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../common/decorators/current-admin.decorator';
import { CancelOrderDto, CreateDraftOrderDto, ListOrdersQuery } from './dto';

@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  list(@Query() query: ListOrdersQuery) {
    return this.orders.listOrders({
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 20,
      status: query.status,
      customerId: query.customerId,
    });
  }

  @Get('by-number/:orderNumber')
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  getByNumber(@Param('orderNumber') orderNumber: string) {
    return this.orders.getOrderByNumber(orderNumber);
  }

  @Get(':id')
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  get(@Param('id') id: string) {
    return this.orders.getOrder(id);
  }

  /** Admin-created draft (e.g. phone order). Customer confirmation still required. */
  @Post('draft')
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  createDraft(
    @Body() dto: CreateDraftOrderDto & { customerId: string },
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.orders.createDraftOrder(
      dto.customerId,
      { planId: dto.planId, couponCode: dto.couponCode },
      { type: 'ADMIN', id: admin.id, ip: req.ip ?? null },
    );
  }

  @Post(':id/confirm')
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  confirm(@Param('id') id: string, @CurrentAdmin() admin: AuthenticatedAdmin, @Req() req: Request) {
    return this.orders.confirmOrder(id, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null });
  }

  @Post(':id/cancel')
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.orders.cancelOrder(id, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null }, dto.reason);
  }
}
