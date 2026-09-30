// Phase 4 end-to-end WhatsApp test (run with `npm run test:whatsapp`).
// Boots the FULL Nest application graph against zenskill_test with the
// InMemoryWhatsAppClient swapped in (no network, no Meta), then drives:
//
//   W1  simulated order conversation: greeting -> products -> plans -> name
//       -> YES confirm -> payment instructions (English)
//   W2  Roman Urdu language variant
//   W3  Urdu language variant
//   W4  opt-out silencing: STOP blocks templates, START resubscribes
//   W5  24h service window: free-form blocked outside window (audited)
//   W6  replay dedupe race: 10 concurrent identical deliveries -> 1 processed
//   W7  session race: 10 concurrent first messages -> exactly 1 session
//   W8  customer race: 10 concurrent first contacts -> exactly 1 customer
//   W9  delivery statuses: sent -> delivered -> read (monotonic), failed ->
//       FAILED + scheduled retry (via handleStatusUpdates, fed by Baileys
//       message receipts in production)
//   W10 outbound retry: transient failure -> FAILED -> sweeper re-sends
//   W11 interactive buttons: send + button_reply routing
//   W12 payment proof image -> PAYMENT_PROCESSING + stored proof file
//   W13 Baileys ingress: raw WAMessage through the real socket-event path
//       (messages.upsert -> normalize -> pipeline -> DB)
//
// Every step asserts against the database and the fake client's recorded
// sends. Exit code 0 = all green.
// NOTE: BAILEYS_DISABLE=true keeps the real socket from connecting; the test
// swaps in the in-memory fake via whatsapp.useClient().

process.env.DATABASE_URL = 'postgresql://zenskill:zenskill_dev@localhost:5432/zenskill_test';
process.env.JWT_ACCESS_SECRET = 'e2e-test-access-secret-min-32-chars-xxxx';
process.env.JWT_REFRESH_SECRET = 'e2e-test-refresh-secret-min-32-chars-xx';
process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.PROOF_STORAGE_DIR = '/tmp/zenskill-wa-proofs';
process.env.BAILEYS_DISABLE = 'true';

import { VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { CustomersService } from '../src/customers/customers.service';
import { CatalogService } from '../src/catalog/catalog.service';
import { WhatsappService } from '../src/whatsapp/whatsapp.service';
import { ConversationsService } from '../src/conversations/conversations.service';
import { InMemoryWhatsAppClient } from '../src/whatsapp/in-memory-whatsapp.client';
import { BaileysClient } from '../src/whatsapp/baileys.client';
import { InboundMessage } from '../src/whatsapp/whatsapp-client.interface';

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

const textMsg = (from: string, wamid: string, text: string): InboundMessage => ({
  providerMessageId: wamid,
  from,
  timestamp: new Date(),
  type: 'text',
  text,
});

async function main() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  // Mirror production (src/main.ts): global prefix 'api' + URI versioning
  // so routes resolve at /api/v1/... exactly as in production.
  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  const prisma = moduleRef.get(PrismaService);
  const customers = moduleRef.get(CustomersService);
  const catalog = moduleRef.get(CatalogService);
  const whatsapp = moduleRef.get(WhatsappService);
  const conversations = moduleRef.get(ConversationsService);
  const fake = new InMemoryWhatsAppClient();
  whatsapp.useClient(fake);

  console.log('== cleaning test database ==');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "audit_logs","webhook_events","payment_attempts","payments","order_items",
     "orders","fulfillment_tasks","subscriptions","refunds","coupons",
     "plans","products","conversation_sessions","messages","pending_approvals","support_tickets",
     "ticket_messages","knowledge_base_chunks","knowledge_base_documents","notifications",
     "attributions","customers","admin_users","users","system_settings","message_templates",
     "business_hours","order_sequences" CASCADE`,
  );

  console.log('== seeding ==');
  const product = await prisma.product.create({
    data: { slug: 'learning-service', name: 'ZenSkil Learning Service', category: 'service' },
  });
  await prisma.plan.create({
    data: {
      productId: product.id, name: '3 Months', durationMonths: 3, durationDays: 90,
      pricePaisa: 210_000, currency: 'PKR',
    },
  });
  check('seeded product + plan', !!(await catalog.listProducts(true)).length);

  const lastReplyTo = (to: string): string =>
    fake.textsTo(to).map((s) => s.body ?? '').join('\n');

  // ============================================================ W1 =====
  console.log('== W1: simulated order conversation (English) ==');
  const num1 = '923001111111';
  await conversations.handleInbound(textMsg(num1, 'wamid.W1-1', 'hi'));
  check('greeting sent in English', lastReplyTo(num1).includes('Assalam-o-Alaikum') && lastReplyTo(num1).includes('View plans'), lastReplyTo(num1).slice(0, 80));
  await conversations.handleInbound(textMsg(num1, 'wamid.W1-2', '1'));
  check('product list sent', lastReplyTo(num1).includes('ZenSkil Learning Service'));
  await conversations.handleInbound(textMsg(num1, 'wamid.W1-3', '1'));
  check('plan list with PKR price', lastReplyTo(num1).includes('3 Months') && lastReplyTo(num1).includes('2,100'));
  await conversations.handleInbound(textMsg(num1, 'wamid.W1-4', '1'));
  check('name requested', lastReplyTo(num1).toLowerCase().includes('full name'));
  await conversations.handleInbound(textMsg(num1, 'wamid.W1-5', 'Ali Raza'));
  const c1 = await customers.findOrCreateByWhatsapp(num1);
  const orderSummary = lastReplyTo(num1);
  check('order summary with YES/NO confirmation', orderSummary.includes('Order summary') && orderSummary.includes('YES'), orderSummary.slice(-80));
  await conversations.handleInbound(textMsg(num1, 'wamid.W1-6', 'YES'));
  const c1b = await prisma.customer.findUniqueOrThrow({ where: { whatsappNumber: num1 } });
  check('customer reached AWAITING_PAYMENT', c1b.state === 'AWAITING_PAYMENT', c1b.state);
  check('payment instructions sent', lastReplyTo(num1).includes('transfer') || lastReplyTo(num1).includes('screenshot'));
  check('customer name captured', c1.name === 'Ali Raza' || (await prisma.customer.findUniqueOrThrow({ where: { whatsappNumber: num1 } })).name === 'Ali Raza');

  // ============================================================ W2 =====
  console.log('== W2: Roman Urdu variant ==');
  const num2 = '923002222222';
  const c2 = await customers.findOrCreateByWhatsapp(num2);
  await prisma.customer.update({ where: { id: c2.id }, data: { language: 'ROMAN_URDU' } });
  await conversations.handleInbound(textMsg(num2, 'wamid.W2-1', 'salam'));
  check('greeting in Roman Urdu', lastReplyTo(num2).includes('khush aamdeed'), lastReplyTo(num2).slice(0, 60));

  // ============================================================ W3 =====
  console.log('== W3: Urdu variant ==');
  const num3 = '923003333333';
  const c3 = await customers.findOrCreateByWhatsapp(num3);
  await prisma.customer.update({ where: { id: c3.id }, data: { language: 'URDU' } });
  await conversations.handleInbound(textMsg(num3, 'wamid.W3-1', 'salam'));
  check('greeting in Urdu script', lastReplyTo(num3).includes('خوش آمدید'), lastReplyTo(num3).slice(0, 40));

  // ============================================================ W4 =====
  console.log('== W4: opt-out silencing ==');
  const num4 = '923004444444';
  const c4 = await customers.findOrCreateByWhatsapp(num4);
  await conversations.handleInbound(textMsg(num4, 'wamid.W4-1', 'hi'));
  await conversations.handleInbound(textMsg(num4, 'wamid.W4-2', 'STOP'));
  const c4b = await prisma.customer.findUniqueOrThrow({ where: { id: c4.id } });
  check('STOP opts out', c4b.optedIn === false);
  check('opt-out confirmation sent', lastReplyTo(num4).toLowerCase().includes('unsubscribed'));
  const sendsBefore = fake.sent.length;
  const tplBlocked = await whatsapp.sendTemplateNotification(c4.id, {
    templateName: 'promo_offer', languageCode: 'en', variables: [],
  });
  check('template blocked after opt-out', tplBlocked === null && fake.sent.length === sendsBefore);
  await conversations.handleInbound(textMsg(num4, 'wamid.W4-3', 'START'));
  const c4c = await prisma.customer.findUniqueOrThrow({ where: { id: c4.id } });
  check('START resubscribes', c4c.optedIn === true);

  // ============================================================ W5 =====
  console.log('== W5: 24h service window ==');
  const num5 = '923005555555';
  const c5 = await customers.findOrCreateByWhatsapp(num5);
  const s5 = await customers.getOrCreateSession(c5.id);
  const oldInbound = await prisma.message.create({
    data: { sessionId: s5.id, direction: 'INBOUND', messageType: 'TEXT', bodyText: 'old', status: 'DELIVERED' },
  });
  await prisma.message.update({
    where: { id: oldInbound.id },
    data: { createdAt: new Date(Date.now() - 25 * 3600 * 1000) },
  });
  check('outside window detected', (await whatsapp.isInServiceWindow(c5.id)) === false);
  const blocked = await whatsapp.sendText(s5.id, c5.id, num5, { body: 'hello?', kind: 'transactional' });
  const blockedAudit = await prisma.auditLog.count({ where: { action: 'whatsapp.send_blocked' } });
  check('free-form blocked outside window (audited)', blocked === null && blockedAudit >= 1);
  await conversations.handleInbound(textMsg(num5, 'wamid.W5-1', 'hi'));
  check('window reopened by inbound', await whatsapp.isInServiceWindow(c5.id));
  const allowed = await whatsapp.sendText(s5.id, c5.id, num5, { body: 'welcome back', kind: 'transactional' });
  check('free-form allowed inside window', typeof allowed === 'string' && !!allowed);

  // ============================================================ W6 =====
  console.log('== W6: replay dedupe race (10x same delivery) ==');
  const num6 = '923006666666';
  const before6 = fake.sent.length;
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      conversations.handleInbound(textMsg(num6, 'wamid.RACE6', 'hi')).catch((e) => ({ __err: String(e) })),
    ),
  );
  const dupes = await prisma.message.count({ where: { whatsappMessageId: 'wamid.RACE6' } });
  check('exactly one inbound row for the redelivery', dupes === 1, String(dupes));
  check('exactly one reply despite 10 concurrent deliveries', fake.sent.length - before6 === 1, String(fake.sent.length - before6));

  // ============================================================ W7 =====
  console.log('== W7: session creation race (10x first messages) ==');
  const num7 = '923007777777';
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => conversations.handleInbound(textMsg(num7, `wamid.RACE7-${i}`, 'hi'))),
  );
  const c7 = await prisma.customer.findUniqueOrThrow({ where: { whatsappNumber: num7 } });
  const sessions7 = await prisma.conversationSession.count({ where: { customerId: c7.id } });
  check('exactly one session created', sessions7 === 1, String(sessions7));

  // ============================================================ W8 =====
  console.log('== W8: customer creation race (10x same number) ==');
  const num8 = '923008888888';
  await Promise.all(
    Array.from({ length: 10 }, () => customers.findOrCreateByWhatsapp(num8)),
  );
  const customers8 = await prisma.customer.count({ where: { whatsappNumber: num8 } });
  check('exactly one customer created', customers8 === 1, String(customers8));

  // ============================================================ W9 =====
  console.log('== W9: delivery status webhooks ==');
  const num9 = '923009999999';
  const c9 = await customers.findOrCreateByWhatsapp(num9);
  const s9 = await customers.getOrCreateSession(c9.id);
  await conversations.handleInbound(textMsg(num9, 'wamid.W9-0', 'hi'));
  const outId = await whatsapp.sendText(s9.id, c9.id, num9, { body: 'status test', kind: 'transactional' });
  const outRow = await prisma.message.findUniqueOrThrow({ where: { id: outId! } });
  const wamid9 = outRow.whatsappMessageId!;
  const applyStatus = async (status: 'sent' | 'delivered' | 'read' | 'failed', errorCode?: string) => {
    // In production these StatusUpdates are built from Baileys message
    // receipts (messages.update); here we feed them directly.
    await whatsapp.handleStatusUpdates([{
      providerMessageId: wamid9,
      recipient: num9,
      status,
      timestamp: new Date(),
      ...(errorCode ? { errorCode } : {}),
    }]);
    return prisma.message.findUniqueOrThrow({ where: { id: outId! } });
  };
  check('delivered applied', (await applyStatus('delivered')).status === 'DELIVERED');
  check('read applied', (await applyStatus('read')).status === 'READ');
  check('stale delivered does not move back from READ', (await applyStatus('delivered')).status === 'READ');
  const failedRow = await applyStatus('failed', '131026:Message undeliverable');
  check('failed applied with error code', failedRow.status === 'FAILED' && !!failedRow.errorCode, failedRow.errorCode ?? '');
  check('failed schedules a retry', failedRow.retryCount === 1 && !!failedRow.nextRetryAt, `retryCount=${failedRow.retryCount}`);

  // ============================================================ W10 ====
  console.log('== W10: outbound retry sweeper ==');
  fake.failNextSends = 1;
  let threw = false;
  try {
    await whatsapp.sendText(s9.id, c9.id, num9, { body: 'retry me', kind: 'transactional' });
  } catch {
    threw = true;
  }
  check('transient failure throws to caller', threw);
  const failedMsg = await prisma.message.findFirstOrThrow({
    where: { sessionId: s9.id, bodyText: 'retry me' }, orderBy: { createdAt: 'desc' },
  });
  check('failed row books a retry', failedMsg.status === 'FAILED' && failedMsg.retryCount === 1 && !!failedMsg.nextRetryAt);
  await prisma.message.update({ where: { id: failedMsg.id }, data: { nextRetryAt: new Date(Date.now() - 1000) } });
  const sweep = await whatsapp.retryFailedOutbound();
  const retriedRow = await prisma.message.findUniqueOrThrow({ where: { id: failedMsg.id } });
  check('sweeper re-sent the message', sweep.sent >= 1 && retriedRow.status === 'SENT' && !!retriedRow.whatsappMessageId, JSON.stringify(sweep));
  // The W9 failed message is also due only in the future; force it due too.
  await prisma.message.update({ where: { id: outId! }, data: { nextRetryAt: new Date(Date.now() - 1000) } });
  await whatsapp.retryFailedOutbound();
  const w9again = await prisma.message.findUniqueOrThrow({ where: { id: outId! } });
  check('provider-failed message retried to SENT', w9again.status === 'SENT');

  // ============================================================ W11 ====
  console.log('== W11: interactive buttons ==');
  const num11 = '923001010101';
  const c11 = await customers.findOrCreateByWhatsapp(num11);
  const s11 = await customers.getOrCreateSession(c11.id);
  await conversations.handleInbound(textMsg(num11, 'wamid.W11-0', 'hi'));
  const before11 = fake.sent.length;
  await whatsapp.sendInteractive(s11.id, c11.id, num11, {
    body: 'What would you like to do?',
    buttons: [
      { id: 'menu:plans', title: 'View plans' },
      { id: 'menu:orders', title: 'My orders' },
    ],
    kind: 'transactional',
  });
  const interactive = fake.sent[fake.sent.length - 1];
  check('interactive message recorded with buttons', interactive?.kind === 'interactive' && interactive.buttons?.length === 2, JSON.stringify(interactive?.buttons));
  await conversations.handleInbound({
    providerMessageId: 'wamid.W11-1', from: num11, timestamp: new Date(),
    type: 'button_reply', buttonId: 'menu:plans', text: 'View plans',
  });
  check('button reply routed to product list', lastReplyTo(num11).includes('ZenSkil Learning Service'));

  // ============================================================ W12 ====
  console.log('== W12: payment proof image -> PAYMENT_PROCESSING ==');
  await conversations.handleInbound({
    providerMessageId: 'wamid.W12-1', from: num1, timestamp: new Date(),
    type: 'image', mediaId: 'media-proof-1', mediaMimeType: 'image/jpeg', caption: 'receipt',
  });
  const c1c = await prisma.customer.findUniqueOrThrow({ where: { whatsappNumber: num1 } });
  check('proof moved customer to PAYMENT_PROCESSING', c1c.state === 'PAYMENT_PROCESSING', c1c.state);
  check('proof received reply sent', lastReplyTo(num1).includes('Screenshot received'));
  const fs = await import('node:fs');
  const proofFiles: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else proofFiles.push(p);
    }
  };
  walk('/tmp/zenskill-wa-proofs');
  check('proof file stored privately on disk', proofFiles.length >= 1, String(proofFiles.length));

  // ============================================================ W13 ====
  console.log('== W13: Baileys socket-event ingress (messages.upsert) ==');
  const baileys = moduleRef.get(BaileysClient);
  const driveUpsert = (u: unknown) =>
    (baileys as unknown as { onMessagesUpsert: (arg: unknown) => Promise<void> }).onMessagesUpsert(u);
  const num13 = '923001313131';
  const rawWam = {
    key: { id: 'WA.E2E13', remoteJid: `${num13}@s.whatsapp.net`, fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: 'Assalam-o-Alaikum' },
  };
  await driveUpsert({ messages: [rawWam], type: 'notify' });
  const inRow = await prisma.message.findUnique({ where: { whatsappMessageId: 'WA.E2E13' } });
  check('raw Baileys message persisted via socket path', !!inRow && inRow.direction === 'INBOUND', inRow?.bodyText ?? 'missing');
  check('socket ingress got a reply', lastReplyTo(num13).length > 0);
  // History sync ('append') on reconnect must not reprocess.
  await driveUpsert({ messages: [rawWam], type: 'append' });
  const dupes13 = await prisma.message.count({ where: { whatsappMessageId: 'WA.E2E13' } });
  check('append-type upserts ignored (no redelivery)', dupes13 === 1, String(dupes13));
  // Our own sends are never processed as inbound.
  await driveUpsert({
    messages: [{ ...rawWam, key: { ...rawWam.key, id: 'WA.E2E13-ME', fromMe: true } }],
    type: 'notify',
  });
  const meRow = await prisma.message.findUnique({ where: { whatsappMessageId: 'WA.E2E13-ME' } });
  check('fromMe messages ignored', meRow === null);

  // ================================================================ W14 ====
  console.log('== W14: template rendering (Baileys: local bodies, no Meta) ==');
  // Baileys has no server-side template registry: the backend renders the
  // full body from message_templates before sending. Customers must receive
  // complete sentences, never bare variable fragments.
  await prisma.messageTemplate.create({
    data: {
      name: 'zenskill_abandoned_reminder_1', language: 'en',
      body: 'Assalam-o-Alaikum {{1}}! Your order {{2}} (PKR {{3}}) is still waiting for payment.',
      isActive: true,
    },
  });
  const num14 = '923001414141';
  const c14 = await customers.findOrCreateByWhatsapp(num14);
  const tId = await whatsapp.sendTemplateNotification(c14.id, {
    templateName: 'zenskill_abandoned_reminder_1', languageCode: 'en',
    variables: ['Ahmed', 'ZSH-20260926-0001', '2,100'],
  });
  const tRow = await prisma.message.findUniqueOrThrow({ where: { id: tId! } });
  const expected14 = 'Assalam-o-Alaikum Ahmed! Your order ZSH-20260926-0001 (PKR 2,100) is still waiting for payment.';
  check('template persisted with fully rendered body', tRow.bodyText === expected14, tRow.bodyText ?? '');
  const sentTpl = fake.sent.filter((s) => s.kind === 'template').pop();
  check('transport sent the rendered body (not fragments)', sentTpl?.body === expected14, sentTpl?.body ?? '');
  check('template-name marker kept for audits', sentTpl?.templateName === 'zenskill_abandoned_reminder_1', sentTpl?.templateName ?? '');
  // Unknown template fails LOUD — never sends variable fragments.
  let threwUnknown = false;
  try {
    await whatsapp.sendTemplateNotification(c14.id, {
      templateName: 'nope_missing', languageCode: 'en', variables: ['x'],
    });
  } catch { threwUnknown = true; }
  check('unknown template throws', threwUnknown);
  // Missing variable fails LOUD — never sends a half-rendered message.
  await prisma.messageTemplate.create({
    data: { name: 'tpl_broken', language: 'en', body: 'Hi {{1}}, amount {{2}}.', isActive: true },
  });
  let threwMissing = false;
  try {
    await whatsapp.sendTemplateNotification(c14.id, {
      templateName: 'tpl_broken', languageCode: 'en', variables: ['only-one'],
    });
  } catch { threwMissing = true; }
  check('missing variable throws', threwMissing);

  await app.close();
  console.log(`\n== result: ${passed} passed, ${failed} failed ==`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
