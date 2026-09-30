import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

// Read-only operational analytics (spec §50/§56). All money in paisa.
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview() {
    // Prisma 6 requires orderBy alongside groupBy; a single raw query is
    // simpler and exact for these small operational rollups.
    const rollups = await this.prisma.$queryRaw<Array<{ kind: string; key: string; n: number }>>`
      SELECT 'customer' AS kind, state::text AS key, COUNT(*)::int AS n FROM customers GROUP BY state
      UNION ALL
      SELECT 'order', status::text, COUNT(*)::int FROM orders GROUP BY status
      UNION ALL
      SELECT 'payment', status::text, COUNT(*)::int FROM payments GROUP BY status
      UNION ALL
      SELECT 'subscription', status::text, COUNT(*)::int FROM subscriptions GROUP BY status
      UNION ALL
      SELECT 'ticket', status::text, COUNT(*)::int FROM support_tickets GROUP BY status`;
    const byKind = (kind: string) =>
      Object.fromEntries(rollups.filter((r: any) => r.kind === kind).map((r: any) => [r.key, r.n]));
    const [revenue, openApprovals, queuedNotifications] = await this.prisma.$transaction([
      this.prisma.payment.aggregate({
        where: { status: 'PAID' },
        _sum: { amountPaisa: true },
        _count: true,
      }),
      this.prisma.pendingApproval.count({ where: { status: 'PENDING' } }),
      this.prisma.notification.count({ where: { status: 'QUEUED' } }),
    ]);
    return {
      customersByState: byKind('customer'),
      ordersByStatus: byKind('order'),
      paymentsByStatus: byKind('payment'),
      subscriptionsByStatus: byKind('subscription'),
      ticketsByStatus: byKind('ticket'),
      revenuePaisa: revenue._sum.amountPaisa ?? 0,
      paidPayments: revenue._count,
      openApprovals,
      queuedNotifications,
    };
  }

  /** Daily order + revenue series for the last `days` days (Asia/Karachi). */
  async dailySeries(days = 30) {
    const d = Math.min(90, Math.max(1, days));
    const rows = await this.prisma.$queryRaw<Array<{ day: string; orders: number; revenue_paisa: number }>>`
      SELECT to_char(o.created_at AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS orders,
             COALESCE(SUM(CASE WHEN p.status = 'PAID' THEN p.amount_paisa ELSE 0 END), 0)::int AS revenue_paisa
      FROM orders o
      LEFT JOIN payments p ON p.order_id = o.id
      WHERE o.created_at >= now() - (${d} || ' days')::interval
      GROUP BY 1
      ORDER BY 1`;
    return rows.map((r: any) => ({ day: r.day, orders: Number(r.orders), revenuePaisa: Number(r.revenue_paisa) }));
  }

  /** Attribution: orders grouped by attribution source / campaign / utm (attributions table). */
  async attribution() {
    const rows = await this.prisma.$queryRaw<Array<{
      source: string | null; campaign: string | null; utm_source: string | null;
      orders: number; revenue_paisa: number;
    }>>`
      SELECT a.source AS source, a.campaign AS campaign, a.utm->>'source' AS utm_source,
             COUNT(*)::int AS orders,
             COALESCE(SUM(CASE WHEN p.status = 'PAID' THEN p.amount_paisa ELSE 0 END), 0)::int AS revenue_paisa
      FROM orders o
      JOIN attributions a ON a.order_id = o.id
      LEFT JOIN payments p ON p.order_id = o.id
      GROUP BY 1, 2, 3
      ORDER BY orders DESC
      LIMIT 100`;
    return rows.map((r: any) => ({
      source: r.source, campaign: r.campaign, utmSource: r.utm_source,
      orders: Number(r.orders), revenuePaisa: Number(r.revenue_paisa),
    }));
  }
}
