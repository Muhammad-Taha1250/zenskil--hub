import { Body, Controller, Get, Headers, HttpCode, NotFoundException, Param, Post, Query, RawBodyRequest, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { PaymentsService } from './payments.service';
import { ProofStorageService } from '../proofs/proof-storage.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../common/decorators/current-admin.decorator';
import { DecideManualPaymentDto, ListPaymentsQuery } from './dto';

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly proofs: ProofStorageService,
  ) {}

  // ------------------------------------------------------------- webhooks
  // No auth — authenticity comes from the provider HMAC signature, verified
  // inside the service. Strictly rate-limited.

  @Post('webhooks/:provider')
  @HttpCode(200) // Threat-model T2 contract: 200 + DUPLICATE on replays, 200 on first delivery (any 2xx = received).
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  webhook(
    @Param('provider') provider: string,
    @Headers('x-webhook-id') webhookId: string | undefined,
    @Headers('x-webhook-signature') signature: string | undefined,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    let payload: unknown = {};
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      payload = {};
    }
    return this.payments.handleProviderWebhook(provider, webhookId, signature, rawBody, payload);
  }

  // ----------------------------------------------------------------- admin

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  list(@Query() query: ListPaymentsQuery) {
    return this.payments.listPayments({
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 20,
      status: query.status,
    });
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  get(@Param('id') id: string) {
    return this.payments.getPayment(id);
  }

  /** Transfer instructions for a payment (amount, accounts, deadline, proof guidance). */
  @Get(':id/instructions')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'FINANCE', 'SUPPORT', 'VIEWER')
  instructions(@Param('id') id: string) {
    return this.payments.getPaymentInstructions(id);
  }

  /** Approve or reject a manual-transfer payment. OWNER/FINANCE only, reason mandatory. */
  @Post(':id/review')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'FINANCE')
  review(
    @Param('id') id: string,
    @Body() dto: DecideManualPaymentDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() req: Request,
  ) {
    return this.payments.decideManualPayment(id, admin.id, dto.decision, dto.reason, req.ip ?? null);
  }

  /** Download the stored payment proof (private storage). OWNER/FINANCE/SUPPORT. */
  @Get(':id/proof')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'FINANCE', 'SUPPORT')
  async proof(@Param('id') id: string) {
    const payment = await this.payments.getPayment(id);
    if (!payment.proofUrl || !payment.proofUrl.startsWith('proofs/')) {
      throw new NotFoundException('No stored proof for this payment');
    }
    const { data, mimeType } = await this.proofs.read(payment.proofUrl);
    return new StreamableFile(data, { type: mimeType });
  }
}
