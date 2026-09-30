import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CustomersService } from './customers.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../common/decorators/current-admin.decorator';
import { ListCustomersQuery, TransitionStateDto, UpdateCustomerDto } from './dto';

@Controller('customers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  list(@Query() query: ListCustomersQuery) {
    return this.customers.listCustomers({
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 20,
      state: query.state,
      search: query.search,
    });
  }

  @Get(':id')
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  get(@Param('id') id: string) {
    return this.customers.getCustomer(id);
  }

  @Patch(':id')
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.customers.updateCustomer(id, dto, {
      type: 'ADMIN',
      id: admin.id,
      ip: req.ip ?? null,
    });
  }

  /** Guided transition — rejects illegal moves. */
  @Post(':id/transition')
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  transition(
    @Param('id') id: string,
    @Body() dto: TransitionStateDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.customers
      .transitionState(id, dto.to, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null })
      .then((state) => ({ state }));
  }

  /** Escape hatch for stuck sessions — OWNER only, fully audited. */
  @Post(':id/force-state')
  @Roles('OWNER')
  forceState(
    @Param('id') id: string,
    @Body() dto: TransitionStateDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.customers
      .forceState(id, dto.to, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null })
      .then((state) => ({ state }));
  }
}
