import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { IsString, MaxLength } from 'class-validator';
import { SupportService } from '../support/support.service';
import { WhatsappService } from './whatsapp.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../common/decorators/current-admin.decorator';

class TicketReplyDto {
  @IsString()
  @MaxLength(4096)
  bodyText!: string;
}

/**
 * Admin replies to support tickets, delivered over WhatsApp.
 *
 * The reply is ALWAYS stored in the ticket thread first (honest record), then
 * a best-effort WhatsApp send is attempted. Delivery policy (opt-out, 24h
 * customer-service window) is enforced by WhatsappService; policy blocks are
 * returned as a verdict — never as a phantom delivery — so the UI can tell
 * the admin exactly what happened.
 */
@Controller('support/tickets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WhatsappSupportController {
  constructor(
    private readonly support: SupportService,
    private readonly whatsapp: WhatsappService,
  ) {}

  @Post(':id/reply')
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  async reply(
    @Param('id') id: string,
    @Body() dto: TicketReplyDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    const actor = { type: 'ADMIN' as const, id: admin.id, ip: req.ip ?? null };
    const ticket = await this.support.getTicket(id);
    const message = await this.support.addMessage(id, 'AGENT', admin.id, dto.bodyText, actor);
    const whatsapp = await this.whatsapp.sendAdminTextToCustomer(ticket.customerId, dto.bodyText, actor);
    return { message, whatsapp };
  }
}
