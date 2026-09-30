import { Body, Controller, Get, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsOptional, IsString, Matches } from 'class-validator';
import { WhatsappService } from './whatsapp.service';
import { normalizePhoneNumber } from './whatsapp-client.interface';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

class TestSendDto {
  @IsString()
  @Matches(/^[+\d][\d\s-]{7,18}$/, { message: 'to must be a phone number' })
  to!: string;

  @IsOptional()
  @IsString()
  text?: string;
}

// Admin WhatsApp diagnostics. OWNER-only.
// This is the real-connection verification path: after the backend boots and
// the QR code (printed in the server logs) is scanned with the business
// phone's WhatsApp → Linked devices, the owner hits GET /admin/whatsapp/status
// to confirm the socket is connected, then POST /admin/whatsapp/test-send
// with their own number to prove end-to-end delivery. Nothing here echoes
// secrets.
@Controller('admin/whatsapp')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WhatsappAdminController {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly config: ConfigService,
  ) {}

  @Get('status')
  @Roles('OWNER', 'FINANCE', 'VIEWER')
  status() {
    return {
      clientName: 'baileys' as const,
      configured: this.whatsapp.configured,
      connected: this.whatsapp.connected,
      awaitingQrScan: this.whatsapp.awaitingQrScan,
      // Presence only — never the values.
      hasAuthDir: !!this.config.get<string>('BAILEYS_AUTH_DIR'),
    };
  }

  @Post('test-send')
  @Roles('OWNER')
  async testSend(@Body() dto: TestSendDto) {
    if (!this.whatsapp.connected) {
      throw new ServiceUnavailableException(
        'WhatsApp socket not connected (HUMAN ACTION REQUIRED: scan the QR printed in the server logs with WhatsApp → Linked devices)',
      );
    }
    const to = normalizePhoneNumber(dto.to);
    // Bypass the 24h-window policy deliberately: this is an explicit owner
    // action, and Meta still enforces template rules server-side. The send is
    // audited like every other outbound message.
    const started = Date.now();
    try {
      const { providerMessageId } = await this.whatsapp.sendDiagnosticText(
        to,
        dto.text ?? 'ZenSkil Hub WhatsApp connection test — reply STOP to opt out.',
      );
      return { ok: true, to, providerMessageId, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false, to, latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message.slice(0, 300) : 'send failed',
      };
    }
  }
}
