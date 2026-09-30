import { AppThrottlerGuard } from './app-throttler.guard';

/**
 * Phase 10 (T6): the login bucket must be keyed per (IP, email) so one
 * attacker's burst can't 429 innocent users behind the same NAT IP, while
 * every other route keeps the plain IP bucket.
 */
describe('AppThrottlerGuard', () => {
  // Bypass DI: getTracker only needs the request object.
  const guard = new (AppThrottlerGuard as unknown as new () => {
    getTracker(req: Record<string, any>): Promise<string>;
  })();

  it('buckets /auth/login per normalized email', async () => {
    const t = await guard.getTracker({
      ip: '1.2.3.4',
      path: '/api/v1/auth/login',
      body: { email: '  Admin@Example.com ' },
    } as unknown as Record<string, any>);
    expect(t).toBe('1.2.3.4:login:admin@example.com');
  });

  it('separates different emails on the same IP', async () => {
    const a = await guard.getTracker({
      ip: '1.2.3.4',
      path: '/api/v1/auth/login',
      body: { email: 'a@x.com' },
    } as unknown as Record<string, any>);
    const b = await guard.getTracker({
      ip: '1.2.3.4',
      path: '/api/v1/auth/login',
      body: { email: 'b@x.com' },
    } as unknown as Record<string, any>);
    expect(a).not.toBe(b);
  });

  it('falls back to the IP bucket when email is absent', async () => {
    const t = await guard.getTracker({
      ip: '1.2.3.4',
      path: '/api/v1/auth/login',
      body: {},
    } as unknown as Record<string, any>);
    expect(t).toBe('1.2.3.4');
  });

  it('keeps non-login routes on the plain IP bucket', async () => {
    const t = await guard.getTracker({
      ip: '1.2.3.4',
      path: '/api/v1/payments/webhooks/test',
      body: { email: 'a@x.com' },
    } as unknown as Record<string, any>);
    expect(t).toBe('1.2.3.4');
  });
});
