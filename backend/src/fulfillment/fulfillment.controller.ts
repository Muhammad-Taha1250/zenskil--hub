import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { FulfillmentService } from './fulfillment.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../common/decorators/current-admin.decorator';
import { CompleteTaskDto, FailTaskDto, ListTasksQuery, ManualReviewDto } from './dto';

function actorOf(admin: AuthenticatedAdmin, req: Request) {
  return { type: 'ADMIN' as const, id: admin.id, ip: req.ip ?? null };
}

@Controller('fulfillment/tasks')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FulfillmentController {
  constructor(private readonly fulfillment: FulfillmentService) {}

  @Get()
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  list(@Query() query: ListTasksQuery) {
    return this.fulfillment.listTasks({
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 20,
      status: query.status,
    });
  }

  @Get(':id')
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  get(@Param('id') id: string) {
    return this.fulfillment.getTask(id);
  }

  @Post(':id/claim')
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  claim(@Param('id') id: string, @CurrentAdmin() admin: AuthenticatedAdmin, @Req() req: Request) {
    return this.fulfillment.claimTask(id, actorOf(admin, req));
  }

  /**
   * Complete delivery. Only after this succeeds may the customer be told
   * the service was delivered.
   */
  @Post(':id/complete')
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  complete(
    @Param('id') id: string,
    @Body() dto: CompleteTaskDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.fulfillment.completeTask(id, actorOf(admin, req), dto.note);
  }

  @Post(':id/fail')
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  fail(
    @Param('id') id: string,
    @Body() dto: FailTaskDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.fulfillment.failTask(id, actorOf(admin, req), dto.error);
  }

  @Post(':id/retry')
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  retry(@Param('id') id: string, @CurrentAdmin() admin: AuthenticatedAdmin, @Req() req: Request) {
    return this.fulfillment.retryTask(id, actorOf(admin, req));
  }

  @Post(':id/manual-review')
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  manualReview(
    @Param('id') id: string,
    @Body() dto: ManualReviewDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.fulfillment.markManualReview(id, actorOf(admin, req), dto.note);
  }
}
