import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

// Authenticates machine-to-machine calls from the n8n automation layer.
// The shared secret comes from AUTOMATION_SERVICE_TOKEN (production .env
// only, never committed). When the variable is unset the guard rejects every
// request, so automation endpoints are closed by default.
//
// Constant-time comparison is used to avoid leaking the token via timing.
// The token identifies the automation service only — all authorization and
// business decisions stay inside the backend services being called.
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.AUTOMATION_SERVICE_TOKEN;
    if (!expected) {
      throw new ServiceUnavailableException(
        'Automation endpoints are disabled: AUTOMATION_SERVICE_TOKEN is not configured',
      );
    }
    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.headers['x-service-token'];
    const token = Array.isArray(provided) ? provided[0] : provided;
    if (!token || !timingSafeEquals(token, expected)) {
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
