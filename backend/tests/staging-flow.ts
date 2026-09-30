// Phase 11 — §41 staging scenario (run with `npm run test:staging`).
// Boots the FULL Nest application graph against zenskill_test with the
// InMemoryWhatsAppClient swapped in (no network, no Meta), then drives ONE
// continuous customer journey end to end, asserting every stage:
//
//   S1  WhatsApp greeting -> services menu
//   S2  services -> product list
//   S3  product -> plan list (prices = DB truth)
//   S4  plan -> name -> order summary with YES/NO
//   S5  YES confirm -> AWAITING_PAYMENT + real payment instructions (NayaPay)
//   S6  payment screenshot over WhatsApp -> PAYMENT_PROCESSING (never auto-PAID)
//   S7  admin verifies -> payment PAID, order FULFILLING, subscription ACTIVE
//   S8  provider webhook: first -> confirmed, replay -> duplicate (exactly-once)
//   S9  fulfillment claim -> complete -> order FULFILLED, customer ACTIVE,
//       order_fulfilled notification sent ONLY after completion
//   S10 renewal reminder: 6-day expiry -> stage-1 template reminder
//   S11 support ticket -> agent reply via HTTP: thread stored + honest
//       WhatsApp verdict (delivered; opt-out -> blocked, never phantom)
//   S12 audit trail append-only
//
// Exit code 0 = all green.
process.env.DATABASE_URL = 'postgresql://zenskill:zenskill_dev@localhost:5432/zenskill_test';
process.env.JWT_ACCESS_SECRET = 'e2e-test-access-secret-min-32-chars-xxxx';
process.env.BAILEYS_DISABLE = 'true';  // E2E: never open a real WhatsApp socket
process.env.JWT_REFRESH_SECRET = 'e2e-test-refresh-secret-min-32-chars-xx';
process.env.JWT_SECRET = 'e2e-jwt-secret-min-32-chars-long!!!!';
process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.PROOF_STORAGE_DIR = '/tmp/zenskill-staging-proofs';
process.env.AUTOMATION_SERVICE_TOKEN = 'n8n-test-token-0123456789abcdef';
process.env.BACKUP_DIR = '/tmp/zenskill-test-backups';
process.env.BACKUP_RETENTION_COUNT = '2';
// Force the deterministic stub LLM (backend/.env may carry a real key).
process.env.AI_API_KEY = '';

import { createHmac } from 'node:crypto';
import { VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../src/auth/auth.service';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { CustomersService, StateTransitionActor } from '../src/customers/customers.service';
import { OrdersService } from '../src/orders/orders.service';
import { PaymentsService } from '../src/payments/payments.service';
import { FulfillmentService } from '../src/fulfillment/fulfillment.service';
import { SupportService } from '../src/support/support.service';
import { AutomationService } from '../src/automation/automation.service';
import { seedTestTemplates } from './e2e-templates';
import { WhatsappService } from '../src/whatsapp/whatsapp.service';
import { ConversationsService } from '../src/conversations/conversations.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { InMemoryWhatsAppClient } from '../src/whatsapp/in-memory-whatsapp.client';
import { InboundMessage } from '../src/whatsapp/whatsapp-client.interface';
import type {
  PaymentProvider,
  ProviderPaymentEvent,
  ProviderPaymentState,
} from '../src/payments/providers/payment-provider.interface';

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

// Fake provider for the webhook stage: HMAC-signed, echoes SUCCEEDED.
class FakeProvider implements PaymentProvider {
  readonly name = 'test_pay';
  private readonly secret = 'fake-webhook-secret';
  async createPayment(input: { amountPaisa: number; currency: string; paymentExpiresAt: Date | null }) {
    return {
      provider: this.name,
      amountPaisa: input.amountPaisa,
      currency: input.currency,
      deadline: input.paymentExpiresAt,
      transferDetails: 'Test Bank: 1234',
      proofGuidance: 'Send proof.',
    };
  }
  async refundPayment() {
    return { mode: 'api' as const, detail: 'test refund' };
  }
  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean {
    if (!signature?.startsWith('sha256=')) return false;
    const expected = createHmac('sha256', this.secret).update(rawBody).digest('hex');
    const a = Buffer.from(signature.slice(7));
    const b = Buffer.from(expected);
    return a.length === b.length && Buffer.compare(a, b) === 0;
  }
  parseWebhook(payload: unknown): ProviderPaymentEvent {
    const p = payload as { txn: string; order: string; amount: number; currency: string };
    if (!p?.txn || !p?.order) throw new Error('bad payload');
    return {
      providerPaymentId: p.txn,
      orderReference: p.order,
      amountPaisa: p.amount,
      currency: p.currency,
      state: 'SUCCEEDED' as ProviderPaymentState,
      rawPayload: payload,
    };
  }
  async getPaymentStatus(): Promise<ProviderPaymentState> {
    return 'SUCCEEDED';
  }
  sign(rawBody: Buffer): string {
    return 'sha256=' + createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }
}

async function main() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();
  try {

  const prisma = moduleRef.get(PrismaService);
  const customers = moduleRef.get(CustomersService);
  const orders = moduleRef.get(OrdersService);
  const payments = moduleRef.get(PaymentsService);
  const fulfillment = moduleRef.get(FulfillmentService);
  const support = moduleRef.get(SupportService);
  const automation = moduleRef.get(AutomationService);
  const whatsapp = moduleRef.get(WhatsappService);
  const conversations = moduleRef.get(ConversationsService);
  const notifications = moduleRef.get(NotificationsService);
  const jwt = moduleRef.get(JwtService);

  const fake = new InMemoryWhatsAppClient();
  whatsapp.useClient(fake);

  console.log('== S0: clean + seed staging data ==');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "audit_logs","webhook_events","payment_attempts","payments","order_items",
     "orders","fulfillment_tasks","subscriptions","refunds","coupons",
     "plans","products","conversation_sessions","messages","pending_approvals","support_tickets",
     "ticket_messages","knowledge_base_chunks","knowledge_base_documents","notifications",
     "attributions","customers","admin_users","users","system_settings","message_templates",
     "business_hours","order_sequences" CASCADE`,
  );
  // Template bodies the order_fulfilled notification renders and sends.
  await seedTestTemplates(prisma);

  const admin = await prisma.adminUser.create({
    data: {
      email: 'owner@zenskill.test',
      name: 'Test Owner',
      passwordHash: await AuthService.hashPassword('password123'),
      role: 'OWNER',
    },
  });
  const adminActor: StateTransitionActor = { type: 'ADMIN', id: admin.id };
  const product = await prisma.product.create({
    data: { slug: 'learning-service', name: 'ZenSkil Learning Service', category: 'service' },
  });
  const plan = await prisma.plan.create({
    data: {
      productId: product.id,
      name: '3 Months',
      durationMonths: 3,
      durationDays: 90,
      pricePaisa: 210_000, // PKR 2,100 — database truth
      currency: 'PKR',
    },
  });
  // Owner's real payment instructions (single source of truth).
  await prisma.systemSetting.create({
    data: {
      key: 'payment.instructions',
      value: {
        'Bank Name': 'NayaPay',
        'Account Title': 'Chand Zohaib',
        'Account Number': '03709104250',
      },
    },
  });
  check('staging seed ready', !!admin.id && !!plan.id);

  const num = '923009990001';
  const lastReplyTo = (to: string): string =>
    fake.textsTo(to).map((s) => s.body ?? '').join('\n');

  // ============================================================ S1: greeting
  console.log('== S1: WhatsApp greeting -> services menu ==');
  await conversations.handleInbound(textMsg(num, 'wamid.S1-1', 'Assalam o Alaikum'));
  const g1 = lastReplyTo(num);
  check('greeting in customer language', g1.includes('Assalam-o-Alaikum'), g1.slice(0, 60));
  check('services menu offered', /1\./.test(g1), g1.slice(0, 120));

  // ============================================================ S2: services -> product
  console.log('== S2: services -> product list ==');
  await conversations.handleInbound(textMsg(num, 'wamid.S2-1', '1'));
  check('product list shows ZenSkil Learning Service', lastReplyTo(num).includes('ZenSkil Learning Service'));

  // ============================================================ S3: product -> plan
  console.log('== S3: product -> plan list (DB prices) ==');
  await conversations.handleInbound(textMsg(num, 'wamid.S3-1', '1'));
  const plans = lastReplyTo(num);
  check('plan list has 3 Months', plans.includes('3 Months'));
  check('plan price is DB truth (2,100)', plans.includes('2,100'), plans.slice(0, 120));

  // ============================================================ S4: plan -> name -> summary
  console.log('== S4: plan -> name -> order summary ==');
  await conversations.handleInbound(textMsg(num, 'wamid.S4-1', '1'));
  check('full name requested', lastReplyTo(num).toLowerCase().includes('full name'));
  await conversations.handleInbound(textMsg(num, 'wamid.S4-2', 'Ali Raza'));
  const summary = lastReplyTo(num);
  check('order summary with YES/NO', summary.includes('Order summary') && summary.includes('YES'), summary.slice(-90));

  // ============================================================ S5: confirm -> payment
  console.log('== S5: YES confirm -> AWAITING_PAYMENT + instructions ==');
  await conversations.handleInbound(textMsg(num, 'wamid.S5-1', 'YES'));
  const cust = await prisma.customer.findUniqueOrThrow({ where: { whatsappNumber: num } });
  check('customer name captured', cust.name === 'Ali Raza', String(cust.name));
  check('customer AWAITING_PAYMENT', cust.state === 'AWAITING_PAYMENT', cust.state);
  const instr = lastReplyTo(num);
  check('instructions carry NayaPay', instr.includes('NayaPay'), instr.slice(0, 100));
  check('instructions carry account number', instr.includes('03709104250'));
  const order = await prisma.order.findFirstOrThrow({ where: { customerId: cust.id }, orderBy: { createdAt: 'desc' } });
  check('order number format ZSH-YYYYMMDD-XXXXX', /^ZSH-\d{8}-\d{5}$/.test(order.orderNumber), order.orderNumber);
  check('order total = plan price (210000 paisa)', order.totalPaisa === 210_000);
  const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
  check('PENDING manual payment', payment.status === 'PENDING' && payment.provider === 'manual_transfer');

  // ============================================================ S6: screenshot -> processing
  console.log('== S6: payment screenshot -> PAYMENT_PROCESSING ==');
  await conversations.handleInbound({
    providerMessageId: 'wamid.S6-1', from: num, timestamp: new Date(),
    type: 'image', mediaId: 'media-proof-staging', mediaMimeType: 'image/jpeg', caption: 'receipt',
  });
  const cust6 = await prisma.customer.findUniqueOrThrow({ where: { whatsappNumber: num } });
  check('customer moved to PAYMENT_PROCESSING', cust6.state === 'PAYMENT_PROCESSING', cust6.state);
  check('screenshot acknowledged', lastReplyTo(num).includes('Screenshot received'));
  const pay6 = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  check('payment MANUAL_REVIEW_REQUIRED (never auto-PAID)', pay6.status === 'MANUAL_REVIEW_REQUIRED', pay6.status);
  check('proof stored privately', !!pay6.proofUrl && !pay6.proofUrl.startsWith('http'));

  // ============================================================ S7: admin verifies
  console.log('== S7: admin approval -> PAID + FULFILLING + ACTIVE subscription ==');
  const decided = await payments.decideManualPayment(payment.id, admin.id, 'APPROVE', 'Receipt matches NayaPay transfer', '127.0.0.1');
  check('approval recorded with reason', decided.decision === 'APPROVE');
  const pay7 = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  check('payment PAID', pay7.status === 'PAID');
  const order7 = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  check('order FULFILLING', order7.status === 'FULFILLING', order7.status);
  const task = await prisma.fulfillmentTask.findFirstOrThrow({ where: { orderId: order.id } });
  check('fulfillment task PENDING', task.status === 'PENDING');
  const taskPayload = task.payload as Record<string, unknown>;
  check('task payload snapshots product/plan', taskPayload.productName === 'ZenSkil Learning Service' && taskPayload.planName === '3 Months', JSON.stringify(taskPayload));
  const sub7 = await prisma.subscription.findFirstOrThrow({ where: { orderId: order.id } });
  check('subscription ACTIVE', sub7.status === 'ACTIVE');
  check('subscription spans 90 days', sub7.expiresAt.getTime() - sub7.startsAt.getTime() === 90 * 86_400_000);
  const cust7 = await customers.getCustomer(cust.id);
  check('customer FULFILLMENT_PENDING', cust7.state === 'FULFILLMENT_PENDING', cust7.state);

  // ============================================================ S8: provider webhook idempotency
  console.log('== S8: provider webhook -> confirmed, replay -> duplicate ==');
  const fakeProvider = new FakeProvider();
  payments.registerProvider(fakeProvider);
  const customerB = await customers.findOrCreateByWhatsapp('923009990002');
  const bActor: StateTransitionActor = { type: 'CUSTOMER', id: customerB.id };
  for (const s of ['BROWSING', 'SELECTING_PRODUCT', 'SELECTING_PLAN', 'ORDER_CREATED', 'AWAITING_PAYMENT'] as const) {
    await customers.transitionState(customerB.id, s, bActor);
  }
  const draftB = await orders.createDraftOrder(customerB.id, { planId: plan.id }, bActor);
  const { order: orderB, payment: paymentB } = await orders.confirmOrder(draftB.id, bActor);
  const eventId = 'evt-staging-001';
  const rawPayload = Buffer.from(JSON.stringify({
    txn: 'txn-staging-1', order: orderB.orderNumber, amount: orderB.totalPaisa, currency: 'PKR',
  }));
  const sig = fakeProvider.sign(rawPayload);
  const first = await payments.handleProviderWebhook('test_pay', eventId, sig, rawPayload, JSON.parse(rawPayload.toString()));
  check('first webhook -> confirmed', first.outcome === 'confirmed', first.outcome);
  const second = await payments.handleProviderWebhook('test_pay', eventId, sig, rawPayload, JSON.parse(rawPayload.toString()));
  check('replay -> duplicate', second.outcome === 'duplicate', second.outcome);
  const paidB = await prisma.payment.findUniqueOrThrow({ where: { id: paymentB.id } });
  check('payment confirmed exactly once (PAID)', paidB.status === 'PAID');
  check('exactly one subscription for order', (await prisma.subscription.count({ where: { orderId: orderB.id } })) === 1);

  // ============================================================ S9: fulfillment -> FULFILLED
  console.log('== S9: claim -> complete -> FULFILLED + ACTIVE ==');
  const textsBefore = lastReplyTo(num);
  const mentionsBefore = (textsBefore.match(new RegExp(order.orderNumber, 'g')) || []).length;
  check('no delivered/fulfilled message BEFORE completion',
    !/delivered|fulfilled/i.test(textsBefore), textsBefore.slice(-120));
  await fulfillment.claimTask(task.id, adminActor);
  check('task PROCESSING after claim', (await fulfillment.getTask(task.id)).status === 'PROCESSING');
  await fulfillment.completeTask(task.id, adminActor, 'service delivered');
  check('task COMPLETED', (await fulfillment.getTask(task.id)).status === 'COMPLETED');
  // The order_fulfilled notification is queued (Phase 5 dispatcher); flush it
  // exactly as the scheduled processor would.
  const flushed = await notifications.flushQueue(50);
  check('queued notification flushed', flushed.sent >= 1, JSON.stringify(flushed));
  const order9 = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  check('order ACTIVE (via FULFILLED)', order9.status === 'ACTIVE', order9.status);
  const fcAudit = await prisma.auditLog.findFirst({
    where: { action: 'fulfillment.completed', entityId: task.id },
    orderBy: { createdAt: 'desc' },
  });
  check('fulfillment.completed audited with order ACTIVE',
    !!fcAudit && (fcAudit.after as Record<string, unknown>)?.orderStatus === 'ACTIVE');
  const cust9 = await customers.getCustomer(cust.id);
  check('customer ACTIVE', cust9.state === 'ACTIVE', cust9.state);
  const textsAfter = lastReplyTo(num);
  const mentionsAfter = (textsAfter.match(new RegExp(order.orderNumber, 'g')) || []).length;
  check('order_fulfilled notification sent after completion',
    mentionsAfter > mentionsBefore, `before=${mentionsBefore} after=${mentionsAfter}`);

  // ============================================================ S10: renewal reminder
  console.log('== S10: renewal reminder (6-day expiry -> stage 1) ==');
  await prisma.subscription.update({
    where: { id: sub7.id },
    data: { expiresAt: new Date(Date.now() + 6 * 86_400_000) },
  });
  const cands = await automation.findRenewalCandidates();
  check('subscription due stage 1', cands.some((c) => c.subscriptionId === sub7.id && c.dueStage === 1));
  const r1 = await automation.sendRenewalReminder(sub7.id);
  check('stage-1 reminder sent', r1.stage === 1 && !!r1.messageId, JSON.stringify(r1));
  const tpl = fake.textsTo(num).filter((s) => s.kind === 'template').pop();
  check('renewal used renewal template', tpl?.templateName === 'zenskill_renewal_reminder', tpl?.templateName);

  // ============================================================ S11: support ticket -> agent reply
  console.log('== S11: support ticket -> agent reply (honest verdict) ==');
  const ticket = await support.createTicket(
    cust.id,
    { subject: 'Refund question', description: 'Customer asks about refund policy', orderId: order.id, priority: 'MEDIUM', authorType: 'CUSTOMER' },
    { type: 'CUSTOMER', id: cust.id },
  );
  check('ticket OPEN', ticket.status === 'OPEN');
  const server = await app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const token = await jwt.signAsync({ sub: admin.id, email: admin.email, role: 'OWNER', tv: admin.tokenVersion });
  const reply = await fetch(`${base}/api/v1/support/tickets/${ticket.id}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ bodyText: 'Thanks for asking — here is our refund policy.' }),
  });
  check('reply endpoint 200/201', [200, 201].includes(reply.status), String(reply.status));
  const replyJson = (await reply.json()) as { message: { bodyText: string }; whatsapp: { delivered: boolean; reason?: string } };
  check('AGENT message stored in thread', replyJson.message.bodyText.includes('refund policy'));
  check('WhatsApp delivered (opted-in, 24h window)', replyJson.whatsapp.delivered === true, JSON.stringify(replyJson.whatsapp));
  check('admin reply reached customer phone', lastReplyTo(num).includes('refund policy'));
  // Honest negative: opted-out customer -> blocked verdict, message still stored.
  await prisma.customer.update({ where: { id: cust.id }, data: { optedIn: false } });
  const reply2 = await fetch(`${base}/api/v1/support/tickets/${ticket.id}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ bodyText: 'Second message while opted out.' }),
  });
  const reply2Json = (await reply2.json()) as { message: { bodyText: string }; whatsapp: { delivered: boolean; reason?: string } };
  check('opt-out -> blocked verdict, not phantom delivery',
    reply2Json.whatsapp.delivered === false && reply2Json.whatsapp.reason === 'customer_opted_out',
    JSON.stringify(reply2Json.whatsapp));
  check('message still stored for opted-out customer', reply2Json.message.bodyText.includes('opted out'));
  await server.close();

  // ============================================================ S12: audit trail
  console.log('== S12: append-only audit trail ==');
  const auditCount = await prisma.auditLog.count();
  check('audit rows recorded', auditCount > 20, String(auditCount));
  const keyActions = await prisma.auditLog.findMany({
    where: { action: { in: ['payment.confirmed', 'fulfillment.completed', 'webhook.processed', 'webhook.duplicate_skipped'] } },
    select: { action: true },
  });
  const actions = new Set(keyActions.map((a) => a.action));
  check('webhook.processed + duplicate_skipped audited',
    actions.has('webhook.processed') && actions.has('webhook.duplicate_skipped'), [...actions].join(','));
  check('fulfillment.completed audited', actions.has('fulfillment.completed'), [...actions].join(','));

  console.log(`\n== result: ${passed} passed, ${failed} failed ==`);
  } finally {
    await app.close();
  }
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {});
