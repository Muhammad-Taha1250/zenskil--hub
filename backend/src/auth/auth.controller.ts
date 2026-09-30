import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../common/decorators/current-admin.decorator';
import { LoginDto, TotpDisableDto, TotpEnableDto } from './dto';

function clientIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  return req.ip ?? null;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Brute-force sensitive: strict rate limit. */
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto.email, dto.password, dto.totpCode, clientIp(req));
  }

  /**
   * Revoke ALL sessions for the caller's own account (bumps token_version).
   * The current token dies too — the client must re-login.
   */
  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  logoutAll(@CurrentAdmin() admin: AuthenticatedAdmin, @Req() req: Request) {
    return this.auth.logoutAll(admin.id, clientIp(req)).then(() => ({ ok: true }));
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return { admin };
  }

  @Post('totp/setup')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  totpSetup(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.auth.beginTotpSetup(admin.id);
  }

  @Post('totp/enable')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  totpEnable(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: TotpEnableDto) {
    return this.auth.enableTotp(admin.id, dto.secret, dto.code).then(() => ({ ok: true }));
  }

  @Post('totp/disable')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  totpDisable(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: TotpDisableDto) {
    return this.auth.disableTotp(admin.id, dto.password, dto.code).then(() => ({ ok: true }));
  }
}
