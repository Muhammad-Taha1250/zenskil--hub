import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Phase 10 (T6): application throttler guard with per-account login buckets.
 *
 * The default tracker keys every bucket by client IP. For the login endpoint
 * that is the wrong key: a burst of password guesses against one address
 * would burn the shared 10/min budget and 429 innocent users behind the same
 * carrier-grade NAT IP (the norm on Pakistani mobile networks) — a
 * throttle-based denial of service against legitimate admins.
 *
 * Login attempts are therefore bucketed per (IP, normalized email). The rest
 * of the posture is unchanged:
 *  - targeted brute force per account -> 5 failures => 15-min account lockout
 *    (checked before password verification in AuthService),
 *  - IP-level floods -> the global 120/min per-IP throttler still applies.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const ip = await super.getTracker(req);
    const path: string = req.path ?? req.url ?? '';
    if (path.endsWith('/auth/login')) {
      const email =
        typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      if (email) return `${ip}:login:${email}`;
    }
    return ip;
  }
}
