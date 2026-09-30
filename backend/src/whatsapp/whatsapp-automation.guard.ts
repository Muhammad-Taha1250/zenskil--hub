import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

/**
 * Machine-to-machine guard for the WhatsApp automation routes
 * (GET /api/whatsapp/qr, POST /api/whatsapp/send).
 *
 * The shared secret comes from AUTOMATION_SERVICE_TOKEN (production .env
 * only, never committed). When the variable is unset the guard rejects every
 * request, so the automation surface is closed by default.
 *
 * The token is accepted as the `x-service-token` header (same convention as
 * the n8n automation guard) or, for browser convenience on the QR pairing
 * page, as the `?token=` query parameter. Query-param tokens can leak into
 * access logs and browser history — prefer the header for automated callers.
 *
 * Constant-time comparison avoids leaking the token via timing.
 */
@Injectable()
export class WhatsappAutomationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.AUTOMATION_SERVICE_TOKEN;
    if (!expected) {
      throw new ServiceUnavailableException(
        'WhatsApp automation is disabled: AUTOMATION_SERVICE_TOKEN is not configured',
      );
    }
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers['x-service-token'];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    const fromQuery = typeof req.query?.token === 'string' ? req.query.token : undefined;
    const provided = fromHeader ?? fromQuery;
    if (!provided || !timingSafeEquals(provided, expected)) {
      throw new UnauthorizedException('Invalid automation service token');
    }
    return true;
  }
}

function timingSafeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
