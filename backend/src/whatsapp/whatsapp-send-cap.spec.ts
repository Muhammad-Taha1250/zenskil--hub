import { WhatsappService } from './whatsapp.service';

// Phase 10 (T14): per-customer hourly outbound cap in persistAndSend.
// Bare-prototype instance with mocked config/prisma/audit (no DB).

function bareService(opts: { sentLastHour: number; maxPerHourEnv?: string }) {
  const svc = Object.create(WhatsappService.prototype) as WhatsappService;
  (svc as any).config = {
    get: (key: string) =>
      key === 'WHATSAPP_MAX_PER_CUSTOMER_PER_HOUR' ? opts.maxPerHourEnv : undefined,
  };
  const auditLog = jest.fn(async () => ({}));
  (svc as any).prisma = {
    message: {
      count: jest.fn(async () => opts.sentLastHour),
      create: jest.fn(async () => ({ id: 'msg-1' })),
    },
  };
  (svc as any).audit = { log: auditLog };
  (svc as any).client = null; // unconfigured client: persist, don't dispatch
  return { svc, auditLog };
}

const send = (svc: WhatsappService) =>
  (svc as any).persistAndSend('sess-1', 'cust-1', '923001234567', 'text', 'hi', {
    to: '923001234567',
    body: 'hi',
    kind: 'transactional',
  });

describe('WhatsApp per-customer hourly send cap (Phase 10, T14)', () => {
  it('blocks the 31st message in a rolling hour and audits it', async () => {
    const { svc, auditLog } = bareService({ sentLastHour: 30 });
    const res = await send(svc);
    expect(res).toBeNull();
    const calls = auditLog.mock.calls as any[][];
    const call = calls.find((c) => c[0].action === 'whatsapp.send_blocked');
    expect(call).toBeDefined();
    expect(call![0].after).toMatchObject({
      reason: 'hourly_rate_limit_exceeded',
      sentLastHour: 30,
      maxPerHour: 30,
    });
  });

  it('allows sends under the cap', async () => {
    const { svc, auditLog } = bareService({ sentLastHour: 29 });
    const res = await send(svc);
    expect(res).toBe('msg-1');
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('honours WHATSAPP_MAX_PER_CUSTOMER_PER_HOUR', async () => {
    const { svc } = bareService({ sentLastHour: 2, maxPerHourEnv: '2' });
    expect(await send(svc)).toBeNull();
    const { svc: ok } = bareService({ sentLastHour: 1, maxPerHourEnv: '2' });
    expect(await send(ok)).toBe('msg-1');
  });

  it('falls back to 30 on a missing or invalid env value', async () => {
    const { svc } = bareService({ sentLastHour: 30, maxPerHourEnv: 'banana' });
    expect(await send(svc)).toBeNull();
    const { svc: unset } = bareService({ sentLastHour: 30 });
    expect(await send(unset)).toBeNull();
  });
});
