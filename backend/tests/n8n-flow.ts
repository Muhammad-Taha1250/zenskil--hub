// Phase 5 end-to-end automation test (run with `npm run test:n8n`).
// Boots the FULL Nest application graph against zenskill_test with the
// InMemoryWhatsAppClient swapped in, then drives every n8n-facing behavior:
//
//   N1  service-token guard: 401 without/wrong token, 200 with token
//   N2  notification dispatcher: pending -> dispatch -> SENT; opt-out -> FAILED
//   N3  abandonment candidates: age/stage/opt-in/status filtering
//   N4  abandonment sends: stage claims, template names, anti-burst gap
//   N5  abandonment race: 10 concurrent sends -> exactly 1 template
//   N6  renewal candidates + sends: 7d/3d/1d buckets, stage advance, race
//   N7  ticket alerts: unalerted listing, atomic claim, claim race
//   N8  expiry sweeper via automation endpoint
//   N9  db-backup: pg_dump -> gzip file, retention, audit
//   N10 admin alert outbox: enqueue on claim, retry backoff, DEAD, race,
//       no-URL skip, HTTP endpoints
//
// Exit code 0 = all green.
process.env.DATABASE_URL = 'postgresql://zenskill:zenskill_dev@localhost:5432/zenskill_test';
process.env.JWT_ACCESS_SECRET = 'e2e-test-access-secret-min-32-chars-xxxx';
process.env.BAILEYS_DISABLE = 'true';  // E2E: never open a real WhatsApp socket
process.env.JWT_REFRESH_SECRET = 'e2e-test-refresh-secret-min-32-chars-xx';
process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.PROOF_STORAGE_DIR = '/tmp/zenskill-wa-proofs';
process.env.PROOF_STORAGE_DIR = '/tmp/zenskill-n8n-proofs';
process.env.AUTOMATION_SERVICE_TOKEN = 'n8n-test-token-0123456789abcdef';
process.env.BACKUP_DIR = '/tmp/zenskill-test-backups';
process.env.BACKUP_RETENTION_COUNT = '2';

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { CustomersService } from '../src/customers/customers.service';
import { WhatsappService } from '../src/whatsapp/whatsapp.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { seedTestTemplates } from './e2e-templates';
import { AutomationService } from '../src/automation/automation.service';
import { AdminAlertService } from '../src/automation/admin-alert.service';
import { InMemoryWhatsAppClient } from '../src/whatsapp/in-memory-whatsapp.client';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const H = (t?: string): Record<string, string> => (t ? { 'x-service-token': t } : {});
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

async function main() {
  // Fake admin channel (Slack-style webhook). Mode flips between 'ok' and
  // 'fail' so we can prove retry/backoff/DEAD behavior deterministically.
  let hookMode: 'ok' | 'fail' = 'ok';
  const hookPosts: Array<{ status: number; body: string }> = [];
  const hookServer: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const status = hookMode === 'ok' ? 200 : 500;
      hookPosts.push({ status, body });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(hookMode === 'ok' ? '{"ok":true}' : '{"error":"boom"}');
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', r));
  const hookPort = (hookServer.address() as AddressInfo).port;
  process.env.ZENSKILL_ADMIN_ALERT_URL = `http://127.0.0.1:${hookPort}/hook`;
  // Read by AdminAlertService via ConfigService at module init.

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  // Mirror production (src/main.ts): global prefix 'api' + URI versioning
  // so routes resolve at /api/v1/... exactly as in production.
  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  const prisma = moduleRef.get(PrismaService);
  const customers = moduleRef.get(CustomersService);
  const whatsapp = moduleRef.get(WhatsappService);
  const notifications = moduleRef.get(NotificationsService);
  const automation = moduleRef.get(AutomationService);
  const alertsSvc = moduleRef.get(AdminAlertService);
  const fake = new InMemoryWhatsAppClient();
  whatsapp.useClient(fake);

  const server = await app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}/api/v1/automation`;

  console.log('== cleaning test database ==');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "audit_logs","webhook_events","payment_attempts","payments","order_items",
     "orders","fulfillment_tasks","subscriptions","refunds","coupons",
     "plans","products","conversation_sessions","messages","pending_approvals","support_tickets",
     "ticket_messages","knowledge_base_chunks","knowledge_base_documents","notifications",
     "attributions","customers","admin_users","users","system_settings","message_templates",
     "business_hours","order_sequences","admin_alert_outbox" CASCADE`,
  );
  await fs.rm('/tmp/zenskill-test-backups', { recursive: true, force: true });

  console.log('== seeding fixtures ==');
  // Template bodies the automation/notification flows render and send.
  await seedTestTemplates(prisma);
  const product = await prisma.product.create({
    data: { slug: 'learning-service', name: 'ZenSkil Learning Service', category: 'service' },
  });
  const plan = await prisma.plan.create({
    data: { productId: product.id, name: '3 Months', durationMonths: 3, durationDays: 90, pricePaisa: 210_000, currency: 'PKR' },
  });
  const cA = await customers.findOrCreateByWhatsapp('923001111111');
  const cB = await customers.findOrCreateByWhatsapp('923002222222');
  await prisma.customer.update({ where: { id: cB.id }, data: { optedIn: false } });
  const cC = await customers.findOrCreateByWhatsapp('923003333333');
  await prisma.customer.update({ where: { id: cC.id }, data: { language: 'URDU' } });

  const mkOrder = (n: string, customerId: string, status: string, createdAt: Date, extra: object = {}) =>
    prisma.order.create({
      data: {
        orderNumber: n, customerId, status: status as never,
        subtotalPaisa: 210_000, totalPaisa: 210_000, createdAt, ...extra,
      },
    });
  const o1 = await mkOrder('ZSH-N8N-00001', cA.id, 'AWAITING_PAYMENT', hoursAgo(3));
  const o2 = await mkOrder('ZSH-N8N-00002', cA.id, 'AWAITING_PAYMENT', hoursAgo(25),
    { abandonmentReminderStage: 1, abandonmentReminderStageAt: hoursAgo(23) });
  const o3 = await mkOrder('ZSH-N8N-00003', cA.id, 'AWAITING_PAYMENT', hoursAgo(1));
  const o4 = await mkOrder('ZSH-N8N-00004', cB.id, 'AWAITING_PAYMENT', hoursAgo(3));
  const o5 = await mkOrder('ZSH-N8N-00005', cA.id, 'AWAITING_PAYMENT', hoursAgo(25));
  const o6 = await mkOrder('ZSH-N8N-00006', cA.id, 'AWAITING_PAYMENT', hoursAgo(30));
  await prisma.payment.create({
    data: {
      orderId: o6.id, provider: 'manual_transfer', amountPaisa: 210_000, status: 'PAID',
    },
  });

  // dedicated orders for subscriptions (orderId is unique per subscription)
  const subOrders: Record<string, string> = {};
  for (const n of ['S1', 'S2', 'S3', 'S4', 'S6', 'S7']) {
    const o = await mkOrder(`ZSH-N8N-SUB${n}`, cA.id, 'FULFILLED', daysAgo(40));
    subOrders[n] = o.id;
  }
  const mkSub = (n: string, customerId: string, expiresAt: Date, stage = 0, stageAt: Date | null = null, status = 'ACTIVE') =>
    prisma.subscription.create({
      data: {
        customerId, orderId: subOrders[n],
        productId: product.id, planId: plan.id,
        startsAt: daysAgo(30), expiresAt, status: status as never,
        renewalReminderStage: stage, renewalReminderStageAt: stageAt,
      },
    });
  const s1 = await mkSub('S1', cA.id, daysFromNow(6));
  const s2 = await mkSub('S2', cA.id, daysFromNow(2));
  const s3 = await mkSub('S3', cA.id, hoursAgo(-12), 1, daysAgo(5));
  await mkSub('S4', cB.id, daysFromNow(6));
  const s6 = await mkSub('S6', cA.id, daysAgo(4));   // past grace -> EXPIRED
  const s7 = await mkSub('S7', cA.id, daysFromNow(6)); // -> EXPIRING_SOON

  const admin = await prisma.adminUser.create({
    data: { email: 'n8n-test@example.com', name: 'N8N Tester', passwordHash: 'x', role: 'SUPPORT' },
  });
  const mkTicket = (n: string, customerId: string, priority: string, status = 'OPEN', assignedTo: string | null = null) =>
    prisma.supportTicket.create({
      data: { ticketNumber: n, customerId, subject: `subject ${n}`, priority: priority as never, status: status as never, assignedTo },
    });
  const t1 = await mkTicket('ZSH-T-N1', cA.id, 'HIGH');
  const t2 = await mkTicket('ZSH-T-N2', cA.id, 'URGENT', 'OPEN', admin.id);
  await mkTicket('ZSH-T-N3', cA.id, 'MEDIUM', 'OPEN', admin.id);
  const t4 = await mkTicket('ZSH-T-N4', cA.id, 'MEDIUM');
  await mkTicket('ZSH-T-N5', cA.id, 'HIGH', 'RESOLVED');

  const sysActor = { type: 'SYSTEM', id: null, ip: null } as never;
  const nA1 = await notifications.queue(cA.id, { templateName: 'zenskill_payment_confirmation', payload: { languageCode: 'en', variables: ['Ali', '100', 'ZSH-1'] } }, sysActor);
  const nA2 = await notifications.queue(cA.id, { templateName: 'zenskill_support_followup', payload: { languageCode: 'en', variables: ['Ali', 'ZSH-T-1'] } }, sysActor);
  const nB = await notifications.queue(cB.id, { templateName: 'zenskill_payment_confirmation', payload: { languageCode: 'en', variables: ['Bob', '100', 'ZSH-2'] } }, sysActor);

  // ================================================================ N1 ====
  console.log('== N1: service-token guard ==');
  const noTok = await fetch(`${base}/notifications/pending`);
  check('no token -> 401', noTok.status === 401, String(noTok.status));
  const badTok = await fetch(`${base}/notifications/pending`, { headers: H('wrong') });
  check('wrong token -> 401', badTok.status === 401, String(badTok.status));
  const okTok = await fetch(`${base}/notifications/pending`, { headers: H('n8n-test-token-0123456789abcdef') });
  check('right token -> 200', okTok.status === 200, String(okTok.status));
  const pendingJson = await okTok.json() as Array<{ id: string }>;
  check('pending lists queued notifications', pendingJson.length === 3, String(pendingJson.length));

  // ================================================================ N2 ====
  console.log('== N2: notification dispatcher ==');
  const TK = 'n8n-test-token-0123456789abcdef';
  for (const n of [nA1, nA2]) {
    const r = await fetch(`${base}/notifications/${n.id}/dispatch`, { method: 'POST', headers: H(TK) });
    const j = await r.json() as { status: string };
    check(`dispatch ${n.id.slice(0, 8)} -> SENT`, (r.status === 200 || r.status === 201) && j.status === 'SENT', `${r.status} ${j.status}`);
  }
  const rB = await fetch(`${base}/notifications/${nB.id}/dispatch`, { method: 'POST', headers: H(TK) });
  const jB = await rB.json() as { status: string };
  check('opted-out notification -> FAILED (blocked)', jB.status === 'FAILED', jB.status);
  check('fake client recorded 2 template sends', fake.textsTo('923001111111').filter((s) => s.kind === 'template').length === 2,
    String(fake.textsTo('923001111111').filter((s) => s.kind === 'template').length));
  check('no send to opted-out customer', fake.textsTo('923002222222').length === 0);

  // ================================================================ N3 ====
  console.log('== N3: abandonment candidates ==');
  const cands = await automation.findAbandonmentCandidates();
  const candIds = new Set(cands.map((c) => c.id));
  check('o1 (3h, stage 0) is a candidate', candIds.has(o1.id));
  check('o2 (25h, stage 1, gap met) is a candidate', candIds.has(o2.id));
  check('o5 (25h, stage 0) is a candidate', candIds.has(o5.id));
  check('o3 (1h) not a candidate', !candIds.has(o3.id));
  check('o4 (opted out) not a candidate', !candIds.has(o4.id));
  check('exactly 3 candidates', cands.length === 3, String(cands.length));

  // ================================================================ N4 ====
  console.log('== N4: abandonment sends ==');
  const r1 = await automation.sendAbandonmentReminder(o1.id);
  check('o1 -> stage 1 sent', r1.stage === 1 && !!r1.messageId && !r1.skipped, JSON.stringify(r1));
  const tpl1 = fake.textsTo('923001111111').filter((s) => s.kind === 'template').pop();
  check('o1 used template 1', tpl1?.templateName === 'zenskill_abandoned_reminder_1', tpl1?.templateName);
  const r5a = await automation.sendAbandonmentReminder(o5.id);
  check('o5 (catch-up) -> stage 1 sent', r5a.stage === 1 && !!r5a.messageId, JSON.stringify(r5a));
  const candsAfter = await automation.findAbandonmentCandidates();
  check('o5 NOT immediately due for stage 2 (anti-burst gap)',
    !candsAfter.some((c) => c.id === o5.id));
  // o2 was already at stage 1 with the gap met -> final reminder
  const r2 = await automation.sendAbandonmentReminder(o2.id);
  check('o2 -> stage 2 (final) sent', r2.stage === 2 && !!r2.messageId, JSON.stringify(r2));
  const tpl2 = fake.textsTo('923001111111').filter((s) => s.kind === 'template').pop();
  check('o2 used template 2', tpl2?.templateName === 'zenskill_abandoned_reminder_2', tpl2?.templateName);
  const r2b = await automation.sendAbandonmentReminder(o2.id);
  check('o2 beyond max stage -> skipped', r2b.skipped === 'max_stage_reached', r2b.skipped);
  const r4 = await automation.sendAbandonmentReminder(o4.id);
  check('opted-out order -> skipped', r4.skipped === 'opted_out', r4.skipped);
  const auditAb = await prisma.auditLog.count({ where: { action: 'automation.abandonment_reminder_sent' } });
  check('abandonment sends audited', auditAb === 3, String(auditAb));

  // ================================================================ N5 ====
  console.log('== N5: abandonment 10-way race ==');
  const o7 = await mkOrder('ZSH-N8N-00007', cA.id, 'AWAITING_PAYMENT', hoursAgo(3));
  const before = fake.textsTo('923001111111').filter((s) => s.kind === 'template').length;
  const race5 = await Promise.all(Array.from({ length: 10 }, () => automation.sendAbandonmentReminder(o7.id)));
  const won5 = race5.filter((r) => !r.skipped);
  const lost5 = race5.filter((r) => r.skipped === 'race_lost');
  check('exactly 1 winner', won5.length === 1, String(won5.length));
  check('9 race_lost', lost5.length === 9, String(lost5.length));
  const after = fake.textsTo('923001111111').filter((s) => s.kind === 'template').length;
  check('exactly 1 template sent in race', after - before === 1, String(after - before));
  const o7b = await prisma.order.findUniqueOrThrow({ where: { id: o7.id } });
  check('o7 at stage 1', o7b.abandonmentReminderStage === 1);

  // ================================================================ N6 ====
  console.log('== N6: renewal reminders ==');
  const rcands = await automation.findRenewalCandidates();
  const byId = new Map(rcands.map((c) => [c.subscriptionId, c.dueStage]));
  check('s1 (6d) due stage 1', byId.get(s1.id) === 1, String(byId.get(s1.id)));
  check('s2 (2d) due stage 1', byId.get(s2.id) === 1, String(byId.get(s2.id)));
  check('s3 (12h, stage 1, gap met) due stage 2', byId.get(s3.id) === 2, String(byId.get(s3.id)));
  check('opted-out sub excluded', !byId.has((await prisma.subscription.findFirstOrThrow({ where: { customerId: cB.id } })).id));
  const rs1 = await automation.sendRenewalReminder(s1.id);
  check('s1 -> stage 1', rs1.stage === 1 && !!rs1.messageId, JSON.stringify(rs1));
  const rs2 = await automation.sendRenewalReminder(s2.id);
  check('s2 -> stage 1', rs2.stage === 1 && !!rs2.messageId, JSON.stringify(rs2));
  const rcands2 = await automation.findRenewalCandidates();
  check('s2 NOT immediately due for stage 2 (anti-burst)',
    !rcands2.some((c) => c.subscriptionId === s2.id));
  // simulate 5 days passing since s2's stage-1 reminder
  await prisma.subscription.update({ where: { id: s2.id }, data: { renewalReminderStageAt: daysAgo(5) } });
  const rcands3 = await automation.findRenewalCandidates();
  check('s2 due for stage 2 after gap', rcands3.some((c) => c.subscriptionId === s2.id && c.dueStage === 2));
  const rs2b = await automation.sendRenewalReminder(s2.id);
  check('s2 -> stage 2', rs2b.stage === 2 && !!rs2b.messageId, JSON.stringify(rs2b));
  const rs3 = await automation.sendRenewalReminder(s3.id);
  check('s3 -> stage 2', rs3.stage === 2 && !!rs3.messageId, JSON.stringify(rs3));
  const tplR = fake.textsTo('923001111111').filter((s) => s.kind === 'template').pop();
  check('renewal used renewal template', tplR?.templateName === 'zenskill_renewal_reminder', tplR?.templateName);
  // renewal race
  const s5o = await mkOrder('ZSH-N8N-SUBS5', cA.id, 'FULFILLED', daysAgo(40));
  const s5 = await prisma.subscription.create({
    data: {
      customerId: cA.id, orderId: s5o.id, productId: product.id, planId: plan.id,
      startsAt: daysAgo(30), expiresAt: daysFromNow(6), status: 'ACTIVE',
    },
  });
  const race6 = await Promise.all(Array.from({ length: 10 }, () => automation.sendRenewalReminder(s5.id)));
  check('renewal race: exactly 1 winner', race6.filter((r) => !r.skipped).length === 1);
  check('renewal race: 9 race_lost', race6.filter((r) => r.skipped === 'race_lost').length === 9);

  // ================================================================ N7 ====
  console.log('== N7: ticket alerts ==');
  const alerts = await automation.findUnalertedTickets();
  const alertIds = new Set(alerts.map((t) => t.id));
  check('HIGH unassigned t1 listed', alertIds.has(t1.id));
  check('URGENT assigned t2 listed', alertIds.has(t2.id));
  check('MEDIUM unassigned t4 listed', alertIds.has(t4.id));
  check('MEDIUM assigned t3 NOT listed', !alertIds.has((await prisma.supportTicket.findUniqueOrThrow({ where: { ticketNumber: 'ZSH-T-N3' } })).id));
  check('3 alerts total', alerts.length === 3, String(alerts.length));
  const cl1 = await automation.claimTicketAlert(t1.id);
  check('claim t1 -> true', cl1.claimed === true);
  const cl1b = await automation.claimTicketAlert(t1.id);
  check('re-claim t1 -> false', cl1b.claimed === false);
  const race7 = await Promise.all(Array.from({ length: 10 }, () => automation.claimTicketAlert(t2.id)));
  check('claim race: exactly 1 true', race7.filter((r) => r.claimed).length === 1);
  const alertsAfter = await automation.findUnalertedTickets();
  check('claimed tickets leave the alert list',
    alertsAfter.length === 1 && alertsAfter[0].id === t4.id,
    alertsAfter.map((t) => t.ticketNumber).join(','));

  // ================================================================ N8 ====
  console.log('== N8: expiry sweeper via automation ==');
  const sw = await fetch(`${base}/subscriptions/sweeper/run`, { method: 'POST', headers: H(TK) });
  check('sweeper endpoint 200/201', sw.status === 200 || sw.status === 201, String(sw.status));
  const s6b = await prisma.subscription.findUniqueOrThrow({ where: { id: s6.id } });
  check('4d-past-grace sub -> EXPIRED', s6b.status === 'EXPIRED', s6b.status);
  const s7b = await prisma.subscription.findUniqueOrThrow({ where: { id: s7.id } });
  check('6d-to-expiry sub -> EXPIRING_SOON', s7b.status === 'EXPIRING_SOON', s7b.status);

  // ================================================================ N9 ====
  console.log('== N9: db-backup ==');
  const bk = await fetch(`${base}/maintenance/db-backup`, { method: 'POST', headers: H(TK) });
  const bj = await bk.json() as { file: string; sizeBytes: number; pruned: number };
  check('backup endpoint 200/201', bk.status === 200 || bk.status === 201, `${bk.status} ${JSON.stringify(bj).slice(0, 120)}`);
  const stat = await fs.stat(bj.file);
  check('backup file exists and non-empty', stat.size > 0, String(stat.size));
  check('backup filename pattern', /zenskill-backup-\d{8}-\d{6}-\d{3}\.sql\.gz$/.test(bj.file), bj.file);
  const head = execFileSync('sh', ['-c', `gunzip -c ${JSON.stringify(bj.file)} | head -c 2000`]).toString();
  check('backup is a real pg_dump', head.includes('PostgreSQL database dump'), head.slice(0, 80));
  const bkAudit = await prisma.auditLog.count({ where: { action: 'maintenance.db_backup' } });
  check('backup audited', bkAudit >= 1, String(bkAudit));
  console.log('  ... second backup');
  const bk2 = await fetch(`${base}/maintenance/db-backup`, { method: 'POST', headers: H(TK) });
  console.log('  ... second backup status', bk2.status);
  await new Promise((r) => setTimeout(r, 5));
  console.log('  ... third backup');
  const bk3 = await fetch(`${base}/maintenance/db-backup`, { method: 'POST', headers: H(TK) });
  console.log('  ... third backup status', bk3.status);
  const files = (await fs.readdir('/tmp/zenskill-test-backups')).filter((f) => f.endsWith('.sql.gz'));
  check('retention keeps newest 2', files.length === 2, files.join(','));

  // =============================================================== N10 ====
  console.log('== N10: admin alert outbox (durable ticket alerts) ==');
  // N7's claims correctly enqueued outbox rows; drain them so N10's
  // fail/succeed assertions start from a clean slate.
  const drained = await alertsSvc.processOutbox(50);
  check('N7 enqueued rows drained', drained.failed === 0 && drained.dead === 0, JSON.stringify(drained));
  const mkOutboxTicket = (n: string, priority: string) =>
    prisma.supportTicket.create({
      data: { ticketNumber: n, customerId: cA.id, subject: `outbox ${n}`, priority: priority as never },
    });
  const tA = await mkOutboxTicket('ZSH-T-OA', 'HIGH');
  const tB = await mkOutboxTicket('ZSH-T-OB', 'URGENT');
  const tC = await mkOutboxTicket('ZSH-T-OC', 'HIGH');

  // 1. claim -> enqueued (one row, PENDING); re-claim -> nothing
  const oc1 = await automation.claimTicketAlert(tA.id);
  check('claim enqueues alert', oc1.claimed === true && oc1.enqueued === true, JSON.stringify(oc1));
  const oc1b = await automation.claimTicketAlert(tA.id);
  check('re-claim enqueues nothing', oc1b.claimed === false && oc1b.enqueued === false, JSON.stringify(oc1b));
  const rowA0 = await prisma.adminAlertOutbox.findUniqueOrThrow({ where: { ticketId: tA.id } });
  check('outbox row PENDING', rowA0.status === 'PENDING' && rowA0.attemptCount === 0, rowA0.status);
  check('payload carries ticketNumber', (rowA0.payload as { ticketNumber?: string }).ticketNumber === 'ZSH-T-OA');
  const enq2 = await alertsSvc.enqueue(tA.id, {
    ticketId: tA.id, ticketNumber: 'ZSH-T-OA', priority: 'HIGH', subject: 'x',
    customerName: null, customerWhatsapp: '923001111111', createdAt: new Date().toISOString(),
  });
  check('double enqueue rejected (unique ticket)', enq2.enqueued === false);
  check('still exactly one outbox row', (await prisma.adminAlertOutbox.count({ where: { ticketId: tA.id } })) === 1);

  // 2. endpoint auth
  const pr401 = await fetch(`${base}/support/alerts/process`, { method: 'POST' });
  check('process endpoint 401 without token', pr401.status === 401, String(pr401.status));
  const ob401 = await fetch(`${base}/support/alerts/outbox`);
  check('outbox status endpoint 401 without token', ob401.status === 401, String(ob401.status));

  // 3. failing webhook -> retry scheduled with backoff, audit logged
  hookMode = 'fail';
  const pf1 = await alertsSvc.processOutbox(10);
  check('failing webhook: failed=1', pf1.failed === 1 && pf1.sent === 0, JSON.stringify(pf1));
  const rowA1 = await prisma.adminAlertOutbox.findUniqueOrThrow({ where: { ticketId: tA.id } });
  check('still PENDING after failure', rowA1.status === 'PENDING');
  check('attemptCount=1', rowA1.attemptCount === 1, String(rowA1.attemptCount));
  check('nextAttemptAt in future (backoff)', rowA1.nextAttemptAt.getTime() > Date.now());
  check('lastError recorded', (rowA1.lastError ?? '').includes('500'), rowA1.lastError ?? '');
  const retryAudit = await prisma.auditLog.count({
    where: { action: 'automation.admin_alert_retry', entityId: tA.id },
  });
  check('retry audited', retryAudit === 1, String(retryAudit));

  // 4. succeeding webhook -> SENT exactly once, payload intact
  hookMode = 'ok';
  hookPosts.length = 0;
  await prisma.adminAlertOutbox.update({ where: { ticketId: tA.id }, data: { nextAttemptAt: new Date(0) } });
  const ps1 = await alertsSvc.processOutbox(10);
  check('ok webhook: sent=1', ps1.sent === 1, JSON.stringify(ps1));
  const rowA2 = await prisma.adminAlertOutbox.findUniqueOrThrow({ where: { ticketId: tA.id } });
  check('row SENT', rowA2.status === 'SENT' && rowA2.sentAt !== null, rowA2.status);
  check('exactly one POST to admin channel', hookPosts.length === 1, String(hookPosts.length));
  const sentBody = JSON.parse(hookPosts[0].body) as Record<string, unknown>;
  check('payload type + ticketNumber', sentBody.type === 'ticket_alert' && sentBody.ticketNumber === 'ZSH-T-OA');

  // 5. endpoint triggers processing too
  await automation.claimTicketAlert(tB.id);
  await prisma.adminAlertOutbox.update({ where: { ticketId: tB.id }, data: { nextAttemptAt: new Date(0) } });
  hookPosts.length = 0;
  const prOk = await fetch(`${base}/support/alerts/process?limit=10`, { method: 'POST', headers: H(TK) });
  const prJ = (await prOk.json()) as { sent: number };
  check('process endpoint 200/201', prOk.status === 200 || prOk.status === 201, String(prOk.status));
  check('endpoint delivered the alert', prJ.sent === 1, JSON.stringify(prJ));
  const obOk = await fetch(`${base}/support/alerts/outbox`, { headers: H(TK) });
  const obJ = (await obOk.json()) as { pending: number; dead: number; sent24h: number };
  check('outbox status endpoint counts', obJ.sent24h >= 2 && obJ.pending >= 0, JSON.stringify(obJ));

  // 6. concurrent processors never double-send (SKIP LOCKED)
  await automation.claimTicketAlert(tC.id);
  const tD = await mkOutboxTicket('ZSH-T-OD', 'HIGH');
  const tE = await mkOutboxTicket('ZSH-T-OE', 'HIGH');
  await automation.claimTicketAlert(tD.id);
  await automation.claimTicketAlert(tE.id);
  await prisma.adminAlertOutbox.updateMany({
    where: { ticketId: { in: [tC.id, tD.id, tE.id] } },
    data: { nextAttemptAt: new Date(0) },
  });
  hookPosts.length = 0;
  const race10 = await Promise.all([alertsSvc.processOutbox(10), alertsSvc.processOutbox(10)]);
  const totalSent = race10[0].sent + race10[1].sent;
  check('outbox race: 3 rows sent exactly once each', totalSent === 3, JSON.stringify(race10));
  check('webhook got exactly 3 POSTs', hookPosts.length === 3, String(hookPosts.length));

  // 7. persistent failure -> DEAD (visible for human follow-up, never silent)
  hookMode = 'fail';
  const tF = await mkOutboxTicket('ZSH-T-OF', 'URGENT');
  await automation.claimTicketAlert(tF.id);
  await prisma.adminAlertOutbox.update({
    where: { ticketId: tF.id },
    data: { attemptCount: 4, nextAttemptAt: new Date(0) },
  });
  const pd = await alertsSvc.processOutbox(10);
  check('5th failure -> dead', pd.dead === 1, JSON.stringify(pd));
  const rowF = await prisma.adminAlertOutbox.findUniqueOrThrow({ where: { ticketId: tF.id } });
  check('row DEAD', rowF.status === 'DEAD', rowF.status);
  const deadAudit = await prisma.auditLog.count({
    where: { action: 'automation.admin_alert_dead', entityId: tF.id },
  });
  check('DEAD audited', deadAudit === 1, String(deadAudit));
  hookMode = 'ok';
  const pd2 = await alertsSvc.processOutbox(10);
  check('DEAD rows never retried', pd2.sent === 0 && pd2.failed === 0 && pd2.dead === 0, JSON.stringify(pd2));

  // 8. no webhook URL configured -> rows wait, attempts not burned
  const noUrlMod = await Test.createTestingModule({
    providers: [
      AdminAlertService,
      PrismaService,
      AuditService,
      { provide: ConfigService, useValue: { get: () => undefined } },
    ],
  }).compile();
  const noUrlAlerts = noUrlMod.get(AdminAlertService);
  const tG = await mkOutboxTicket('ZSH-T-OG', 'HIGH');
  await automation.claimTicketAlert(tG.id);
  const rowG0 = await prisma.adminAlertOutbox.findUniqueOrThrow({ where: { ticketId: tG.id } });
  const pn = await noUrlAlerts.processOutbox(10);
  const rowG1 = await prisma.adminAlertOutbox.findUniqueOrThrow({ where: { ticketId: tG.id } });
  check('no URL: row stays PENDING, attempts not burned',
    pn.skipped >= 1 && rowG1.status === 'PENDING' && rowG1.attemptCount === rowG0.attemptCount,
    JSON.stringify(pn));
  await noUrlMod.close();

  // ============================================================ summary ====
  hookServer.close();
  await app.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
