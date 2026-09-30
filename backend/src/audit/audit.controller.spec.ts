import { AuditController } from './audit.controller';

// PrismaService is constructor-injected; mock the two query methods it uses.
function mockPrisma() {
  return {
    auditLog: {
      count: jest.fn().mockResolvedValue(3),
      findMany: jest.fn().mockResolvedValue([{ id: 'a1', action: 'order.created' }]),
    },
  };
}

describe('AuditController.list', () => {
  it('passes pagination and ordering through', async () => {
    const prisma = mockPrisma();
    const ctl = new AuditController(prisma as unknown as never);
    const res = await ctl.list({ page: 2, pageSize: 10 });
    expect(prisma.auditLog.count).toHaveBeenCalledWith({ where: {} });
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
      skip: 10,
      take: 10,
    });
    expect(res).toEqual({ total: 3, page: 2, pageSize: 10, items: [{ id: 'a1', action: 'order.created' }] });
  });

  it('maps filters to a Prisma where clause', async () => {
    const prisma = mockPrisma();
    const ctl = new AuditController(prisma as unknown as never);
    await ctl.list({
      action: 'payment',
      entityType: 'order',
      entityId: '123e4567-e89b-12d3-a456-426614174000',
      actorType: 'ADMIN',
      from: '2026-09-01',
      to: '2026-09-30',
    } as never);
    const where = (prisma.auditLog.findMany.mock.calls[0] as Array<{ where: unknown }>)[0].where as Record<string, unknown>;
    expect(where.action).toEqual({ contains: 'payment', mode: 'insensitive' });
    expect(where.entityType).toBe('order');
    expect(where.entityId).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(where.actorType).toBe('ADMIN');
    expect((where.createdAt as Record<string, Date>).gte).toEqual(new Date('2026-09-01'));
    expect((where.createdAt as Record<string, Date>).lte).toEqual(new Date('2026-09-30'));
  });

  it('ignores invalid date filters instead of crashing', async () => {
    const prisma = mockPrisma();
    const ctl = new AuditController(prisma as unknown as never);
    await ctl.list({ from: 'not-a-date' } as never);
    const where = (prisma.auditLog.findMany.mock.calls[0] as Array<{ where: unknown }>)[0].where as Record<string, unknown>;
    expect(where.createdAt).toBeUndefined();
  });

  it('clamps pageSize to a sane maximum', async () => {
    const prisma = mockPrisma();
    const ctl = new AuditController(prisma as unknown as never);
    const res = await ctl.list({ pageSize: 10000 } as never);
    expect(res.pageSize).toBe(100);
  });
});
