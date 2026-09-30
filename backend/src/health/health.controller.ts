import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { AiConfig, WhatsAppConfig } from '../config/configuration';

interface DependencyStatus {
  configured: boolean;
  reachable?: boolean;
  detail?: string;
}

// Liveness: GET /health — always 200 when the process is up (mounted at root).
// Readiness: GET /ready — 200 when PostgreSQL answers; reports whether the
// WhatsApp / AI integrations are configured (reachability is verified on use).
// Version-neutral: load balancers and uptime monitors hit plain /health and
// /ready (no /api/v1 prefix, no /v1 version segment).
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get('health')
  health(): { status: string; version: string; time: string } {
    return { status: 'ok', version: '0.3.0', time: new Date().toISOString() };
  }

  @Get('ready')
  async ready(): Promise<{
    status: 'ready' | 'degraded';
    checks: Record<string, DependencyStatus>;
  }> {
    const checks: Record<string, DependencyStatus> = {};

    try {
      await this.prisma.ping();
      checks.database = { configured: true, reachable: true };
    } catch (err) {
      checks.database = {
        configured: true,
        reachable: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const wa = this.config.get<WhatsAppConfig>('whatsapp');
    checks.whatsapp = {
      configured: true,
      detail: `baileys socket (auth dir: ${wa?.authDir ?? './baileys_auth'}); scan QR on first boot; reachability verified on send`,
    };

    const ai = this.config.get<AiConfig>('ai');
    checks.ai =
      ai && ai.provider !== 'none' && ai.apiKey
        ? { configured: true, detail: `provider=${ai.provider}` }
        : { configured: false, detail: 'AI not configured — deterministic fallback active' };

    const dbOk = checks.database.reachable === true;
    return { status: dbOk ? 'ready' : 'degraded', checks };
  }
}
