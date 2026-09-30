// Phase 3 end-to-end acceptance test (run with `npm run test:e2e`).
// Boots the FULL Nest application graph against zenskill_test and drives the
// complete business flow with real services + PostgreSQL:
//
//   Flow A: order -> manual payment proof -> admin approval -> fulfillment -> subscription
//   Flow B: provider webhook idempotency (duplicate delivery -> single confirmation)
//   Flow C: subscription renewal supersedes the old subscription (no double ACTIVE)
//   Flow D: approval decision retry is idempotent; stale PRICE_CHANGE is rejected
//
// Every step asserts against the database. Exit code 0 = all green.
process.env.DATABASE_URL = 'postgresql://zenskill:zenskill_dev@localhost:5432/zenskill_test';
process.env.JWT_ACCESS_SECRET = 'e2e-test-access-secret-min-32-chars-xxxx';
process.env.BAILEYS_DISABLE = 'true';  // E2E: never open a real WhatsApp socket
process.env.JWT_REFRESH_SECRET = 'e2e-test-refresh-secret-min-32-chars-xx';
process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.PROOF_STORAGE_DIR = '/tmp/zenskill-e2e-proofs';

import { createHmac } from 'node:crypto';
import { VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthService } from '../src/auth/auth.service';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { CustomersService, StateTransitionActor } from '../src/customers/customers.service';
import { OrdersService } from '../src/orders/orders.service';
import { PaymentsService } from '../src/payments/payments.service';
import { FulfillmentService } from '../src/fulfillment/fulfillment.service';
import { SubscriptionsService } from '../src/subscriptions/subscriptions.service';
import { ApprovalsService } from '../src/approvals/approvals.service';
import { CatalogService } from '../src/catalog/catalog.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { ProofStorageService } from '../src/proofs/proof-storage.service';
import { SupportService } from '../src/support/support.service';
import { KnowledgeService } from '../src/knowledge/knowledge.service';
import { executeTool, type ToolDependencies, type ToolExecutionContext } from '../src/ai/tools';
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

// Fake provider for webhook tests: HMAC-signed, echoes SUCCEEDED.
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
    return expected === signature.slice('sha256='.length);
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
  sign(raw: Buffer): string {
    return 'sha256=' + createHmac('sha256', this.secret).update(raw).digest('hex');
  }
}

async function main() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  // Mirror main.ts: raw bodies for webhook signatures + the /api/v1 prefix.
  const app = moduleRef.createNestApplication({ rawBody: true });
  // Mirror production (src/main.ts): global prefix 'api' + URI versioning
  // so routes resolve at /api/v1/... exactly as in production.
  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  const prisma = moduleRef.get(PrismaService);
  const audit = moduleRef.get(AuditService);
  const customers = moduleRef.get(CustomersService);
  const orders = moduleRef.get(OrdersService);
  const payments = moduleRef.get(PaymentsService);
  const fulfillment = moduleRef.get(FulfillmentService);
  const subscriptions = moduleRef.get(SubscriptionsService);
  const approvals = moduleRef.get(ApprovalsService);
  const catalog = moduleRef.get(CatalogService);
  const analytics = moduleRef.get(AnalyticsService);
  const proofs = moduleRef.get(ProofStorageService);

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
  check('seeded admin/product/plan', !!admin.id && !!plan.id);
  check('plan price is database truth (210000 paisa)', plan.pricePaisa === 210_000);

  // ============================================================ Flow A ====
  console.log('== Flow A: order -> proof -> admin approval -> fulfillment -> subscription ==');
  const customer = await customers.findOrCreateByWhatsapp('923001234567');
  const customerActor: StateTransitionActor = { type: 'CUSTOMER', id: customer.id };
  check('customer created in NEW', customer.state === 'NEW');

  // Walk the deterministic conversation path to SELECTING_PLAN.
  for (const s of ['BROWSING', 'SELECTING_PRODUCT', 'SELECTING_PLAN'] as const) {
    await customers.transitionState(customer.id, s, customerActor);
  }
  const draft = await orders.createDraftOrder(customer.id, { planId: plan.id }, customerActor);
  check('draft order created with ZSH- number', /^ZSH-\d{8}-\d{5}$/.test(draft.orderNumber), draft.orderNumber);
  check('draft total equals plan price', draft.totalPaisa === 210_000);
  // The conversation engine advances the customer to ORDER_CREATED on draft.
  await customers.transitionState(customer.id, 'ORDER_CREATED', customerActor);

  const { order: confirmed, payment } = await orders.confirmOrder(draft.id, customerActor);
  check('order AWAITING_PAYMENT after confirm', confirmed.status === 'AWAITING_PAYMENT');
  check('PENDING manual payment created', payment.status === 'PENDING' && payment.provider === 'manual_transfer');
  check('payment amount matches order total', payment.amountPaisa === confirmed.totalPaisa);
  // The conversation engine advances the customer to AWAITING_PAYMENT on confirm.
  await customers.transitionState(customer.id, 'AWAITING_PAYMENT', customerActor);

  // Customer submits transfer proof: bytes go to PRIVATE storage, never a hot link.
  const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from('fake-receipt-bytes')]);
  const stored = await proofs.store(payment.id, fakeJpg, 'image/jpeg');
  check('proof stored under private key', stored.storageKey.startsWith(`proofs/${payment.id}/`));
  check('proof sha256 recorded', /^[0-9a-f]{64}$/.test(stored.sha256));
  await payments.submitProof(payment.id, { storageKey: stored.storageKey, proofHash: stored.sha256 }, customerActor);
  // The conversation engine advances the customer to PAYMENT_PROCESSING on proof.
  await customers.transitionState(customer.id, 'PAYMENT_PROCESSING', customerActor);
  const afterProof = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  check('payment MANUAL_REVIEW_REQUIRED after proof (never auto-paid)', afterProof.status === 'MANUAL_REVIEW_REQUIRED');
  check('proof reference is the storage key, not a URL', afterProof.proofUrl === stored.storageKey);
  const orderAfterProof = await prisma.order.findUniqueOrThrow({ where: { id: draft.id } });
  check('order PAYMENT_PROCESSING after proof', orderAfterProof.status === 'PAYMENT_PROCESSING');

  // Admin approves with a mandatory reason.
  const decided = await payments.decideManualPayment(payment.id, admin.id, 'APPROVE', 'Receipt matches JazzCash transfer', '127.0.0.1');
  check('admin approval returned APPROVE', decided.decision === 'APPROVE' && !!decided.approvalId);
  const paid = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  check('payment PAID after admin approval', paid.status === 'PAID');
  const orderPaid = await prisma.order.findUniqueOrThrow({
    where: { id: draft.id }, include: { items: true },
  });
  check('order FULFILLING after confirmation', orderPaid.status === 'FULFILLING');
  const task = await prisma.fulfillmentTask.findFirstOrThrow({ where: { orderId: draft.id } });
  check('fulfillment task PENDING', task.status === 'PENDING');
  const sub = await prisma.subscription.findFirstOrThrow({ where: { orderId: draft.id } });
  check('subscription ACTIVE', sub.status === 'ACTIVE');
  check('subscription spans 90 days', sub.expiresAt.getTime() - sub.startsAt.getTime() === 90 * 86_400_000);
  const c2 = await customers.getCustomer(customer.id);
  check('customer FULFILLMENT_PENDING after confirmation', c2.state === 'FULFILLMENT_PENDING', c2.state);

  // Proof is retrievable by staff through private storage.
  const retrieved = await proofs.read(stored.storageKey);
  check('stored proof bytes round-trip', Buffer.compare(retrieved.data, fakeJpg) === 0);

  // Re-approving an already-decided payment is rejected, not double-applied.
  let doubleApproveBlocked = false;
  try {
    await payments.decideManualPayment(payment.id, admin.id, 'APPROVE', 'second try', null);
  } catch {
    doubleApproveBlocked = true;
  }
  check('double approval blocked', doubleApproveBlocked);

  // Fulfillment: claim -> complete. Delivery is announced only after completion.
  await fulfillment.claimTask(task.id, adminActor);
  const claimed = await fulfillment.getTask(task.id);
  check('task PROCESSING after claim', claimed.status === 'PROCESSING');
  await fulfillment.completeTask(task.id, adminActor, 'service delivered');
  const done = await fulfillment.getTask(task.id);
  check('task COMPLETED', done.status === 'COMPLETED');
  const orderDone = await prisma.order.findUniqueOrThrow({ where: { id: draft.id } });
  check('order ACTIVE after fulfillment', orderDone.status === 'ACTIVE');
  const c3 = await customers.getCustomer(customer.id);
  check('customer ACTIVE after fulfillment', c3.state === 'ACTIVE', c3.state);

  // ============================================================ Flow B ====
  console.log('== Flow B: provider webhook idempotency ==');
  const fake = new FakeProvider();
  payments.registerProvider(fake);

  const customerB = await customers.findOrCreateByWhatsapp('923009998877');
  const bActor: StateTransitionActor = { type: 'CUSTOMER', id: customerB.id };
  for (const s of ['BROWSING', 'SELECTING_PRODUCT', 'SELECTING_PLAN', 'ORDER_CREATED', 'AWAITING_PAYMENT'] as const) {
    await customers.transitionState(customerB.id, s, bActor);
  }
  const draftB = await orders.createDraftOrder(customerB.id, { planId: plan.id }, bActor);
  const { order: orderB, payment: paymentB } = await orders.confirmOrder(draftB.id, bActor);

  const eventId = 'evt-test-001';
  const rawPayload = Buffer.from(JSON.stringify({
    txn: 'txn-abc-123', order: orderB.orderNumber, amount: orderB.totalPaisa, currency: 'PKR',
  }));
  const sig = fake.sign(rawPayload);
  const first = await payments.handleProviderWebhook('test_pay', eventId, sig, rawPayload, JSON.parse(rawPayload.toString()));
  check('first webhook confirms payment', first.outcome === 'confirmed', first.outcome);
  const second = await payments.handleProviderWebhook('test_pay', eventId, sig, rawPayload, JSON.parse(rawPayload.toString()));
  check('duplicate delivery acknowledged', second.outcome === 'duplicate', second.outcome);

  const paidB = await prisma.payment.findUniqueOrThrow({ where: { id: paymentB.id } });
  check('payment confirmed exactly once (PAID)', paidB.status === 'PAID');
  const subCount = await prisma.subscription.count({ where: { orderId: orderB.id } });
  check('exactly one subscription created', subCount === 1);
  const webhookRow = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId } });
  check('append-only: exactly one webhook row (never updated)', webhookRow.processingStatus === 'RECEIVED');
  const auditOutcomes = await prisma.auditLog.findMany({
    where: { entityType: 'webhook_event', entityId: webhookRow.id },
    select: { action: true },
  });
  const actions = auditOutcomes.map((a) => a.action).sort();
  check('outcomes recorded as immutable audit records', JSON.stringify(actions) === JSON.stringify(['webhook.duplicate_skipped', 'webhook.processed']), actions.join(','));

  // Invalid signature is rejected (fail closed), event row still recorded.
  const badRaw = Buffer.from(JSON.stringify({ txn: 'txn-bad', order: orderB.orderNumber, amount: 1, currency: 'PKR' }));
  let sigRejected = false;
  try {
    await payments.handleProviderWebhook('test_pay', 'evt-test-bad', 'sha256=deadbeef', badRaw, JSON.parse(badRaw.toString()));
  } catch {
    sigRejected = true;
  }
  check('invalid signature rejected', sigRejected);
  const badRows = await prisma.webhookEvent.count({ where: { eventId: 'evt-test-bad', signatureValid: false } });
  check('rejected webhook recorded with signatureValid=false', badRows === 1);

  // ============================================================ Flow C ====
  console.log('== Flow C: subscription renewal supersedes (no double ACTIVE) ==');
  // Same customer buys the same product again (renewal).
  // Walk the legal path: ACTIVE -> EXPIRING_SOON -> SELECTING_PLAN -> ...
  for (const s of ['EXPIRING_SOON', 'SELECTING_PLAN', 'ORDER_CREATED', 'AWAITING_PAYMENT'] as const) {
    await customers.transitionState(customer.id, s, customerActor);
  }
  const draftC = await orders.createDraftOrder(customer.id, { planId: plan.id }, customerActor);
  const { payment: paymentC } = await orders.confirmOrder(draftC.id, customerActor);
  await customers.transitionState(customer.id, 'AWAITING_PAYMENT', customerActor);
  const storedC = await proofs.store(paymentC.id, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'image/jpeg');
  await payments.submitProof(paymentC.id, { storageKey: storedC.storageKey }, customerActor);
  await customers.transitionState(customer.id, 'PAYMENT_PROCESSING', customerActor);
  const oldSub = await prisma.subscription.findFirstOrThrow({ where: { orderId: draft.id } });
  await payments.decideManualPayment(paymentC.id, admin.id, 'APPROVE', 'Renewal receipt verified', null);

  const oldAfter = await prisma.subscription.findUniqueOrThrow({ where: { id: oldSub.id } });
  const newSub = await prisma.subscription.findFirstOrThrow({ where: { orderId: draftC.id } });
  check('old subscription superseded (CANCELLED)', oldAfter.status === 'CANCELLED');
  check('new subscription ACTIVE', newSub.status === 'ACTIVE');
  check('renewal anchored at old expiry (no lost time)',
    newSub.startsAt.getTime() === Math.max(oldSub.expiresAt.getTime(), newSub.startsAt.getTime()) &&
    newSub.startsAt.getTime() >= oldSub.expiresAt.getTime() - 60_000,
    `old expires ${oldSub.expiresAt.toISOString()}, new starts ${newSub.startsAt.toISOString()}`);
  const activeSubs = await prisma.subscription.count({
    where: { customerId: customer.id, productId: product.id, status: { in: ['ACTIVE', 'EXPIRING_SOON'] } },
  });
  check('exactly one active subscription per product', activeSubs === 1);

  // ============================================================ Flow D ====
  console.log('== Flow D: approval decision atomicity + idempotency ==');
  const priceApproval = await approvals.createApproval(
    'PRICE_CHANGE', 'plan', plan.id,
    { planId: plan.id, newPricePaisa: 220_000, oldPricePaisa: 210_000 },
    admin.id, 'test price increase', null, null,
  );
  const d1 = await approvals.decide(priceApproval.id, admin.id, 'APPROVE', 'ok', null);
  check('price change approved', d1.idempotent === false);
  const planAfter = await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } });
  check('price updated to 220000', planAfter.pricePaisa === 220_000);
  const d2 = await approvals.decide(priceApproval.id, admin.id, 'APPROVE', 'ok', null);
  check('retry is idempotent', d2.idempotent === true);
  const planAfterRetry = await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } });
  check('retry did not double-apply', planAfterRetry.pricePaisa === 220_000);

  // Stale approval (price moved underneath) is rejected, not blindly applied.
  const stale = await approvals.createApproval(
    'PRICE_CHANGE', 'plan', plan.id,
    { planId: plan.id, newPricePaisa: 230_000, oldPricePaisa: 210_000 }, // 210000 is stale
    admin.id, 'stale request', null, null,
  );
  let staleRejected = false;
  try {
    await approvals.decide(stale.id, admin.id, 'APPROVE', 'ok', null);
  } catch {
    staleRejected = true;
  }
  check('stale price approval rejected (concurrency guard)', staleRejected);
  const planFinal = await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } });
  check('price untouched by stale approval', planFinal.pricePaisa === 220_000);

  // ============================================================ Flow E ====
  console.log('== Flow E: analytics attribution reads the attributions table ==');
  await prisma.attribution.create({
    data: {
      customerId: customer.id, orderId: draft.id,
      source: 'meta_ad', campaign: 'launch_2026', utm: { source: 'instagram', medium: 'cpc' },
    },
  });
  const attr = await analytics.attribution();
  const row = attr.find((r) => r.source === 'meta_ad');
  check('attribution row returned from attributions table', !!row, JSON.stringify(attr));
  check('attribution revenue counts the PAID payment', !!row && row.revenuePaisa === 210_000, row && String(row.revenuePaisa));
  check('attribution order count is 1', !!row && row.orders === 1);

  // ============================================================ Flow F ====
  console.log('== Flow F: WhatsApp webhook HTTP behavior ==');
  const server = await app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  // Baileys refactor: there is NO public WhatsApp webhook anymore — inbound
  // arrives only over the authenticated WebSocket. The security property to
  // hold is that the old Meta webhook path is gone: unsigned HTTP traffic
  // cannot inject messages.
  // 1. Old verify-challenge route -> 404.
  const vOk = await fetch(`${base}/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=e2e-verify-token&hub.challenge=CHALLENGE_123`);
  check('legacy webhook GET removed (404)', vOk.status === 404, String(vOk.status));
  // 2. Old signed-POST route -> 404 even with a valid-looking signature.
  const pOk = await fetch(`${base}/api/v1/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
    body: JSON.stringify({ entry: [] }),
  });
  check('legacy webhook POST removed (404)', pOk.status === 404, String(pOk.status));
  const inboundAfter = await prisma.message.count({ where: { direction: 'INBOUND' } });
  check('no inbound rows fabricated over HTTP', inboundAfter === 0, String(inboundAfter));

  // ============================================================ Flow G ====
  console.log('== Flow G: concurrency races ==');

  // G1: 10 parallel deliveries of the SAME webhook event -> exactly one confirms.
  const customerG = await customers.findOrCreateByWhatsapp('923007771111');
  const gActor: StateTransitionActor = { type: 'CUSTOMER', id: customerG.id };
  for (const s of ['BROWSING', 'SELECTING_PRODUCT', 'SELECTING_PLAN', 'ORDER_CREATED', 'AWAITING_PAYMENT'] as const) {
    await customers.transitionState(customerG.id, s, gActor);
  }
  const draftG = await orders.createDraftOrder(customerG.id, { planId: plan.id }, gActor);
  await orders.confirmOrder(draftG.id, gActor);
  const gEventId = 'evt-race-001';
  const gRaw = Buffer.from(JSON.stringify({
    txn: 'txn-race-001', order: draftG.orderNumber, amount: draftG.totalPaisa, currency: 'PKR',
  }));
  const gSig = fake.sign(gRaw);
  const gPayload = JSON.parse(gRaw.toString());
  const gResults = await Promise.all(
    Array.from({ length: 10 }, () =>
      payments.handleProviderWebhook('test_pay', gEventId, gSig, gRaw, gPayload)
        .then((r) => r.outcome)
        .catch((e) => `threw:${e.constructor.name}`),
    ),
  );
  const confirmedCount = gResults.filter((o) => o === 'confirmed').length;
  check('exactly one webhook delivery confirmed', confirmedCount === 1, gResults.join(','));
  check('all other deliveries deduplicated', gResults.filter((o) => o === 'duplicate').length === 9, gResults.join(','));
  const gWebhooks = await prisma.webhookEvent.count({ where: { eventId: gEventId } });
  check('exactly one webhook row after race', gWebhooks === 1);
  const gSubs = await prisma.subscription.count({ where: { orderId: draftG.id } });
  check('exactly one subscription after race', gSubs === 1);

  // G2: 5 parallel decisions on the same approval -> one decision, idempotent side effect.
  const plan2 = await catalog.createPlan(
    { productId: product.id, name: 'G2 Plan', durationMonths: 1, durationDays: 30, pricePaisa: 83_000 },
    adminActor,
  );
  const gApproval = await approvals.createApproval(
    'PRICE_CHANGE', 'plan', plan2.id,
    { planId: plan2.id, newPricePaisa: 84_000, oldPricePaisa: 83_000 },
    admin.id, 'concurrency test', null, null,
  );
  const gDecides = await Promise.all(
    Array.from({ length: 5 }, () =>
      approvals.decide(gApproval.id, admin.id, 'APPROVE', 'ok', null)
        .then((r) => (r.idempotent ? 'idempotent' : 'applied'))
        .catch((e) => `threw:${e.constructor.name}`),
    ),
  );
  check('all parallel decisions resolved', gDecides.every((d) => d === 'applied' || d === 'idempotent'), gDecides.join(','));
  const plan2After = await prisma.plan.findUniqueOrThrow({ where: { id: plan2.id } });
  check('price applied exactly once (84000)', plan2After.pricePaisa === 84_000, String(plan2After.pricePaisa));
  const gApprovalAfter = await prisma.pendingApproval.findUniqueOrThrow({ where: { id: gApproval.id } });
  check('approval terminal APPROVED', gApprovalAfter.status === 'APPROVED');

  // G3: 5 parallel fulfillment claims -> exactly one winner, attempts == 1.
  const raceTask = await prisma.fulfillmentTask.findFirstOrThrow({ where: { orderId: draftC.id, status: 'PENDING' } });
  const gClaims = await Promise.all(
    Array.from({ length: 5 }, () =>
      fulfillment.claimTask(raceTask.id, adminActor)
        .then(() => 'claimed')
        .catch((e) => `threw:${e.constructor.name}`),
    ),
  );
  check('exactly one worker claimed the task', gClaims.filter((c) => c === 'claimed').length === 1, gClaims.join(','));
  check('losers got ConflictException', gClaims.filter((c) => c === 'threw:ConflictException').length === 4, gClaims.join(','));
  const raceTaskAfter = await fulfillment.getTask(raceTask.id);
  check('task PROCESSING with attempts == 1', raceTaskAfter.status === 'PROCESSING' && raceTaskAfter.attempts === 1,
    `${raceTaskAfter.status}/${raceTaskAfter.attempts}`);

  // ============================================================ Flow H ====
  console.log('== Flow H: AI tool ownership boundary (real services) ==');
  const aiDeps: ToolDependencies = {
    customers, orders, catalog, payments, subscriptions,
    support: moduleRef.get(SupportService),
    knowledge: moduleRef.get(KnowledgeService),
  };
  const aiCtx = (customerId: string): ToolExecutionContext => ({ customerId, actor: { type: 'AI' } });
  // orderB belongs to customerB; customer (Flow A) must not see it.
  let crossOrderBlocked = false;
  try {
    await executeTool('get_order', { orderNumber: orderB.orderNumber }, aiCtx(customer.id), aiDeps);
  } catch { crossOrderBlocked = true; }
  check('AI cannot read another customer\'s order', crossOrderBlocked);
  let crossPaymentBlocked = false;
  try {
    await executeTool('get_payment_status', { orderNumber: orderB.orderNumber }, aiCtx(customer.id), aiDeps);
  } catch { crossPaymentBlocked = true; }
  check('AI cannot read another customer\'s payment status', crossPaymentBlocked);
  const ownOrder = await executeTool('get_order', { orderNumber: draftG.orderNumber }, aiCtx(customerG.id), aiDeps) as { orderNumber: string };
  check('AI can read its own customer\'s order', ownOrder.orderNumber === draftG.orderNumber);
  let unknownBlocked = false;
  try {
    await executeTool('approve_payment', {}, aiCtx(customer.id), aiDeps);
  } catch { unknownBlocked = true; }
  check('unknown AI tool name rejected', unknownBlocked);

  // ---- summary ---------------------------------------------------------
  const auditCount = await prisma.auditLog.count();
  console.log(`\n== result: ${passed} passed, ${failed} failed (audit rows: ${auditCount}) ==`);
  await app.close();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});
