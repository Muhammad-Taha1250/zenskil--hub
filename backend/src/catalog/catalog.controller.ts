import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CatalogService } from './catalog.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../common/decorators/current-admin.decorator';
import { CreatePlanDto, CreateProductDto, UpdatePlanDto, UpdateProductDto } from './dto';

@Controller('catalog')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('products')
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  products(@Query('activeOnly') activeOnly?: string) {
    return this.catalog.listProducts(activeOnly !== 'false');
  }

  @Get('products/:slug')
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  product(@Param('slug') slug: string) {
    return this.catalog.getProduct(slug);
  }

  @Get('plans/:id')
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  plan(@Param('id') id: string) {
    return this.catalog.getPlan(id);
  }

  @Post('products')
  @Roles('OWNER', 'FINANCE')
  createProduct(@Body() dto: CreateProductDto, @CurrentAdmin() admin: AuthenticatedAdmin, @Req() req: Request) {
    return this.catalog.createProduct(dto, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null });
  }

  @Patch('products/:id')
  @Roles('OWNER', 'FINANCE')
  updateProduct(@Param('id') id: string, @Body() dto: UpdateProductDto, @CurrentAdmin() admin: AuthenticatedAdmin, @Req() req: Request) {
    return this.catalog.updateProduct(id, dto, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null });
  }

  @Post('plans')
  @Roles('OWNER', 'FINANCE')
  createPlan(@Body() dto: CreatePlanDto, @CurrentAdmin() admin: AuthenticatedAdmin, @Req() req: Request) {
    return this.catalog.createPlan(dto, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null });
  }

  @Patch('plans/:id')
  @Roles('OWNER', 'FINANCE')
  updatePlan(@Param('id') id: string, @Body() dto: UpdatePlanDto, @CurrentAdmin() admin: AuthenticatedAdmin, @Req() req: Request) {
    return this.catalog.updatePlan(id, dto, { type: 'ADMIN', id: admin.id, ip: req.ip ?? null });
  }
}
