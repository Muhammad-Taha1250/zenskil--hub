import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { BaileysClient } from './baileys.client';
import { WhatsappService } from './whatsapp.service';
import { WhatsappAutomationGuard } from './whatsapp-automation.guard';
import { normalizePhoneNumber, toWhatsappJid } from './whatsapp-client.interface';

class AutomationSendDto {
  @IsString()
  @Matches(/^[+\d][\d\s\-()]{7,19}$/, { message: 'to must be a phone number' })
  to!: string;

  @IsString()
  @MinLength(1, { message: 'message must not be empty' })
  @MaxLength(4096, { message: 'message must be at most 4096 characters' })
  message!: string;
}

/**
 * Machine-to-machine WhatsApp automation surface (Baileys socket, no Meta
 * API). All routes live under the global `api` prefix:
 *
 *   GET  /api/whatsapp/status  — public; connection state
 *   GET  /api/whatsapp/qr      — guarded; pairing QR as an HTML page
 *   POST /api/whatsapp/send   — guarded; { to, message }
 *
 * GET /qr and POST /send require AUTOMATION_SERVICE_TOKEN as the
 * `x-service-token` header (or `?token=` on the QR page for browser use).
 * When the variable is unset both endpoints fail closed.
 *
 * POST /send is an explicit operator/automation action: like the admin
 * test-send endpoint it bypasses the customer 24h-window policy and is
 * audited. Customer-pipeline traffic must keep using the policy-checked
 * WhatsappService paths (sendText / sendTemplateNotification).
 */
@Controller('whatsapp')
export class WhatsappAutomationController {
  constructor(
    private readonly baileys: BaileysClient,
    private readonly whatsapp: WhatsappService,
  ) {}

  @Get('status')
  status() {
    const state = this.baileys.getConnectionState();
    return {
      state,
      connected: state === 'CONNECTED',
      clientName: 'baileys' as const,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('qr')
  @UseGuards(WhatsappAutomationGuard)
  @Header('Content-Type', 'text/html; charset=utf-8')
  async qr(): Promise<string> {
    const state = this.baileys.getConnectionState();
    if (state === 'CONNECTED') {
      return this.page(
        'WhatsApp linked',
        '<p class="ok">The business number is already linked — no QR scan needed.</p>',
      );
    }
    const dataUri = await this.baileys.getQrDataUri();
    if (!dataUri) {
      // Socket is CONNECTING or mid-reconnect: no QR to show yet.
      throw new NotFoundException(
        `No QR code available right now (state: ${state}). Wait for the socket to request pairing, then reload.`,
      );
    }
    return this.page(
      'Link WhatsApp',
      `<p>Scan with the business phone: <strong>WhatsApp → Linked devices → Link a device</strong>.</p>` +
        `<img src="${dataUri}" alt="WhatsApp pairing QR" width="320" height="320" />` +
        `<p class="muted">This page refreshes automatically. The QR expires if not scanned in time.</p>`,
    );
  }

  @Post('send')
  @UseGuards(WhatsappAutomationGuard)
  @HttpCode(HttpStatus.OK)
  async send(@Body() dto: AutomationSendDto) {
    // Strip non-digits; Pakistani local format 0300… becomes 92300….
    const to = normalizePhoneNumber(dto.to);
    if (!to) {
      throw new BadRequestException('to must contain a dialable phone number');
    }
    if (!this.baileys.connected) {
      throw new ServiceUnavailableException('WhatsApp socket not connected');
    }
    const { providerMessageId } = await this.whatsapp.sendAutomationText(to, dto.message);
    return {
      ok: true,
      to,
      jid: toWhatsappJid(to),
      providerMessageId,
    };
  }

  private page(title: string, body: string): string {
    // The data-URI below is generated server-side from the pairing QR —
    // no user input is interpolated, so no escaping concerns.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="20" />
<title>${title} — ZenSkil Hub</title>
<style>
body{font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f4f4f5;color:#18181b}
main{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;text-align:center;max-width:420px}
img{border:1px solid #e4e4e7;border-radius:8px}
.ok{color:#15803d;font-weight:600}
.muted{color:#71717a;font-size:13px}
</style>
</head>
<body><main><h1>${title}</h1>${body}</main></body>
</html>`;
  }
}
