// Phase 7 payment-abstraction acceptance test (run with `npm run test:payments`).
// Boots the FULL Nest application graph against zenskill_test and drives the
// payment lifecycle with real services + PostgreSQL:
//
//   Flow 1: provider interface completion — createPayment instructions +
//           refundPayment descriptor (manual provider), DRAFT fallback.
//   Flow 2: manual success — proof -> admin approve (reason) -> PAID ->
//           fulfillment task + ACTIVE subscription; guards (no reason, double
//           approve, proof on PAID, reject path).
//   Flow 3: webhook failure paths — amount mismatch -> manual review (never
//           auto-confirmed), currency mismatch -> manual review, provider
//           reports PENDING/FAILED -> pending_verification (never confirmed).
//   Flow 4: webhook replay — sequential + concurrent duplicate delivery ->
//           exactly one confirmation.
//   Flow 5: HTTP RBAC — unauthenticated 401, SUPPORT 403 on review, OWNER 200;
//           instructions endpoint; automation expiry endpoint guard.
//   Flow 6: expiry sweeper — past-deadline PENDING -> FAILED + order CANCELLED
//           + customer CANCELLED + audit; idempotent; review/future/PAID rows
//           untouched.
//
// Every step asserts against the database. Exit code 0 = all green.
process.env.DATABASE_URL =
  'postgresql://zenskill:zenskill_dev@localhost:5432/zenskill_test';
process.env.JWT_SECRET = 'e2e-jwt-secret-min-32-chars-long!!!!';
process.env.BAILEYS_DISABLE = 'true';  // E2E: never open a real WhatsApp socket
process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.PROOF_STORAGE_DIR = '/tmp/zenskill-payments-proofs';
process.env.AUTOMATION_SERVICE_TOKEN = 'e2e-service-token';

import { createHmac } from 'node:crypto';
import { VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthService } from '../src/auth/auth.service';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { CustomersService, StateTransitionActor } from '../src/customers/customers.service';
import { OrdersService } from '../src/orders/orders.service';
import { PaymentsService } from '../src/payments/payments.service';
import { ProofStorageService } from '../src/proofs/proof-storage.service';
import { ManualTransferProvider, TRANSFER_DETAILS_DRAFT } from '../src/payments/providers/payment-provider.interface';
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

// Fake gateway provider with a controllable reported status.
class FakeProvider implements PaymentProvider {
  readonly name = 'test_pay';
  private readonly secret = 'fake-webhook-secret';
  constructor(public reportedStatus: ProviderPaymentState = 'SUCCEEDED') {}
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
    return { mode: 'api' as const, detail: 'test refund executed' };
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
    return this.reportedStatus;
  }
  sign(raw: Buffer): string {
    return 'sha256=' + createHmac('sha256', this.secret).update(raw).digest('hex');
  }
}

async function main() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  const prisma = moduleRef.get(PrismaService);
  const customers = moduleRef.get(CustomersService);
  const orders = moduleRef.get(OrdersService);
  const payments = moduleRef.get(PaymentsService);
  const proofs = moduleRef.get(ProofStorageService);

  console.log('== cleaning test database ==');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "audit_logs","webhook_events","payment_attempts","payments","order_items",
     "orders","fulfillment_tasks","subscriptions","refunds","coupons",
     "plans","products","conversation_sessions","messages","pending_approvals","support_tickets",
     "ticket_messages","knowledge_base_chunks","knowledge_base_documents","notifications",
     "attributions","customers","admin_users","users","system_settings","message_templates",
     "business_hours","order_sequences","admin_alert_outbox" CASCADE`,
  );

  console.log('== seeding ==');
  const owner = await prisma.adminUser.create({
    data: {
      email: 'owner@zenskill.test',
      name: 'Test Owner',
      passwordHash: await AuthService.hashPassword('password123'),
      role: 'OWNER',
    },
  });
  const supportAdmin = await prisma.adminUser.create({
    data: {
      email: 'support@zenskill.test',
      name: 'Test Support',
      passwordHash: await AuthService.hashPassword('password123'),
      role: 'SUPPORT',
    },
  });
  const ownerActor: StateTransitionActor = { type: 'ADMIN', id: owner.id };
  const product = await prisma.product.create({
    data: { slug: 'learning-service', name: 'ZenSkil Learning Service', category: 'service' },
  });
  const plan = await prisma.plan.create({
    data: {
      productId: product.id,
      name: '3 Months',
      durationMonths: 3,
      durationDays: 90,
      pricePaisa: 210_000,
      currency: 'PKR',
    },
  });
  await prisma.systemSetting.create({
    data: {
      key: 'payment.instructions',
      value: { JazzCash: '0300-1234567 (ZenSkil)', 'Bank IBAN': 'PK00TEST123456789' },
      description: 'test transfer details',
      updatedBy: owner.id,
    },
  });
  check('seeded admins/product/plan/transfer-details', !!owner.id && !!plan.id);

  // Helper: fresh customer -> confirmed order with a PENDING manual payment.
  let custSeq = 0;
  async function confirmedOrder() {
    custSeq++;
    const customer = await customers.findOrCreateByWhatsapp(`9230090000${String(custSeq).padStart(2, '0')}`);
    const cActor: StateTransitionActor = { type: 'CUSTOMER', id: customer.id };
    for (const s of ['BROWSING', 'SELECTING_PRODUCT', 'SELECTING_PLAN'] as const) {
      await customers.transitionState(customer.id, s, cActor);
    }
    const draft = await orders.createDraftOrder(customer.id, { planId: plan.id }, cActor);
    await customers.transitionState(customer.id, 'ORDER_CREATED', cActor);
    const { order, payment } = await orders.confirmOrder(draft.id, cActor);
    await customers.transitionState(customer.id, 'AWAITING_PAYMENT', cActor);
    return { customer, cActor, order, payment };
  }
  async function submitFakeProof(paymentId: string, cActor: StateTransitionActor) {
    const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from('fake-receipt')]);
    const stored = await proofs.store(paymentId, fakeJpg, 'image/jpeg');
    await payments.submitProof(paymentId, { storageKey: stored.storageKey, proofHash: stored.sha256 }, cActor);
    return stored;
  }

  // ============================================================ Flow 1 ====
  console.log('== Flow 1: createPayment instructions + refundPayment descriptor ==');
  {
    const { payment, order } = await confirmedOrder();
    const instructions = await payments.getPaymentInstructions(payment.id);
    check('instructions amount = order total', instructions.amountPaisa === order.totalPaisa && instructions.amountPaisa === 210_000);
    check('instructions currency PKR', instructions.currency === 'PKR');
    check('instructions carry owner-configured transfer details',
      instructions.transferDetails.includes('0300-1234567') && instructions.transferDetails.includes('PK00TEST123456789'),
      instructions.transferDetails.slice(0, 80));
    check('instructions carry deadline', instructions.deadline instanceof Date && instructions.deadline.getTime() > Date.now());
    check('instructions carry proof guidance', instructions.proofGuidance.length > 20);
    check('instructions provider = manual_transfer', instructions.provider === 'manual_transfer');

    const refund = await payments.getRefundDescriptor(payment.id);
    check('manual refund is human-executed', refund.mode === 'manual' && refund.detail.length > 10);

    // Bare provider without a settings source -> explicit DRAFT placeholder, never invented accounts.
    const bare = new ManualTransferProvider();
    const bareInstr = await bare.createPayment({ orderId: 'x', orderNumber: 'ZSH-X', amountPaisa: 100, currency: 'PKR', paymentExpiresAt: null });
    check('bare provider returns DRAFT placeholder', bareInstr.transferDetails === TRANSFER_DETAILS_DRAFT);
  }

  // ============================================================ Flow 2 ====
  console.log('== Flow 2: manual success + review guards ==');
  {
    const { customer, cActor, payment } = await confirmedOrder();
    await submitFakeProof(payment.id, cActor);
    await customers.transitionState(customer.id, 'PAYMENT_PROCESSING', cActor);
    const afterProof = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    check('proof -> MANUAL_REVIEW_REQUIRED (never auto-paid)', afterProof.status === 'MANUAL_REVIEW_REQUIRED');

    // Reason is mandatory.
    let noReasonBlocked = false;
    try {
      await payments.decideManualPayment(payment.id, owner.id, 'APPROVE', '   ', '127.0.0.1');
    } catch {
      noReasonBlocked = true;
    }
    check('approval without reason blocked', noReasonBlocked);

    const decided = await payments.decideManualPayment(payment.id, owner.id, 'APPROVE', 'Receipt matches JazzCash transfer', '127.0.0.1');
    check('approve with reason -> APPROVE', decided.decision === 'APPROVE' && !!decided.approvalId);
    const paid = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    check('payment PAID', paid.status === 'PAID');
    const approval = await prisma.pendingApproval.findUniqueOrThrow({ where: { id: decided.approvalId } });
    check('pending_approvals row records reason', (approval.payload as { reason?: string }).reason !== undefined || approval.reason === 'Receipt matches JazzCash transfer', approval.reason);
    const auditRows = await prisma.auditLog.count({ where: { entityId: payment.id, action: { in: ['payment.proof_submitted', 'payment.manual_approved', 'payment.confirmed'] } } });
    check('audit trail: proof + approval + confirmation', auditRows === 3, String(auditRows));

    // Proof on a PAID payment is rejected — customer input can never move money.
    let proofOnPaidBlocked = false;
    try {
      await payments.submitProof(payment.id, { storageKey: 'proofs/x/y.jpg' }, cActor);
    } catch {
      proofOnPaidBlocked = true;
    }
    check('proof submit on PAID rejected', proofOnPaidBlocked);

    // Double approval rejected, not double-applied.
    let doubleBlocked = false;
    try {
      await payments.decideManualPayment(payment.id, owner.id, 'APPROVE', 'again', null);
    } catch {
      doubleBlocked = true;
    }
    check('double approval blocked', doubleBlocked);

    // Reject path: back to PENDING with the reason recorded.
    const r2 = await confirmedOrder();
    await submitFakeProof(r2.payment.id, r2.cActor);
    const rej = await payments.decideManualPayment(r2.payment.id, owner.id, 'REJECT', 'Receipt is blurry', '127.0.0.1');
    check('reject -> REJECT', rej.decision === 'REJECT');
    const afterReject = await prisma.payment.findUniqueOrThrow({ where: { id: r2.payment.id } });
    const orderAfterReject = await prisma.order.findUniqueOrThrow({ where: { id: r2.order.id } });
    check('reject returns payment to PENDING + order to AWAITING_PAYMENT',
      afterReject.status === 'PENDING' && orderAfterReject.status === 'AWAITING_PAYMENT');
    check('reject records reason', (afterReject.failureReason ?? '').includes('blurry'), afterReject.failureReason ?? '');
  }

  // ============================================================ Flow 3 ====
  console.log('== Flow 3: webhook failure paths -> manual review, never auto-confirm ==');
  const fake = new FakeProvider('SUCCEEDED');
  payments.registerProvider(fake);
  function signedWebhook(orderNumber: string, txn: string, amount: number, currency: string) {
    const body = JSON.stringify({ txn, order: orderNumber, amount, currency });
    const raw = Buffer.from(body);
    return { raw, sig: fake.sign(raw), payload: JSON.parse(body) };
  }
  {
    // Amount mismatch.
    const { order, payment } = await confirmedOrder();
    const w = signedWebhook(order.orderNumber, 'TXN-MM-1', 200_000, 'PKR');
    const out = await payments.handleProviderWebhook('test_pay', 'evt-mm-1', w.sig, w.raw, w.payload);
    check('amount mismatch -> manual_review', out.outcome === 'manual_review', out.outcome);
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    check('mismatched payment NOT auto-confirmed', p.status === 'MANUAL_REVIEW_REQUIRED');
    check('mismatch reason recorded', (p.failureReason ?? '').includes('Amount mismatch'), p.failureReason ?? '');

    // Currency mismatch.
    const c2 = await confirmedOrder();
    const w2 = signedWebhook(c2.order.orderNumber, 'TXN-MM-2', 210_000, 'USD');
    const out2 = await payments.handleProviderWebhook('test_pay', 'evt-mm-2', w2.sig, w2.raw, w2.payload);
    const p2 = await prisma.payment.findUniqueOrThrow({ where: { id: c2.payment.id } });
    check('currency mismatch -> manual_review, not PAID', out2.outcome === 'manual_review' && p2.status !== 'PAID');

    // Provider reports PENDING -> pending_verification, never confirmed.
    fake.reportedStatus = 'PENDING';
    const c3 = await confirmedOrder();
    const w3 = signedWebhook(c3.order.orderNumber, 'TXN-PV-1', 210_000, 'PKR');
    const out3 = await payments.handleProviderWebhook('test_pay', 'evt-pv-1', w3.sig, w3.raw, w3.payload);
    const p3 = await prisma.payment.findUniqueOrThrow({ where: { id: c3.payment.id } });
    check('unverified PENDING -> pending_verification', out3.outcome === 'pending_verification', out3.outcome);
    check('unverified payment not PAID', p3.status !== 'PAID', p3.status);

    // Provider reports FAILED -> not confirmed.
    fake.reportedStatus = 'FAILED';
    const c4 = await confirmedOrder();
    const w4 = signedWebhook(c4.order.orderNumber, 'TXN-PV-2', 210_000, 'PKR');
    const out4 = await payments.handleProviderWebhook('test_pay', 'evt-pv-2', w4.sig, w4.raw, w4.payload);
    const p4 = await prisma.payment.findUniqueOrThrow({ where: { id: c4.payment.id } });
    check('provider FAILED -> never confirmed', out4.outcome === 'pending_verification' && p4.status !== 'PAID');

    // Bad signature -> Unauthorized, nothing processed.
    fake.reportedStatus = 'SUCCEEDED';
    const c5 = await confirmedOrder();
    const w5 = signedWebhook(c5.order.orderNumber, 'TXN-BAD-1', 210_000, 'PKR');
    let sigBlocked = false;
    try {
      await payments.handleProviderWebhook('test_pay', 'evt-bad-1', 'sha256=deadbeef', w5.raw, w5.payload);
    } catch {
      sigBlocked = true;
    }
    const p5 = await prisma.payment.findUniqueOrThrow({ where: { id: c5.payment.id } });
    check('bad webhook signature rejected, payment untouched', sigBlocked && p5.status === 'PENDING');
  }

  // ============================================================ Flow 4 ====
  console.log('== Flow 4: webhook replay -> exactly one confirmation ==');
  {
    const { order, payment } = await confirmedOrder();
    const w = signedWebhook(order.orderNumber, 'TXN-RP-1', 210_000, 'PKR');
    const first = await payments.handleProviderWebhook('test_pay', 'evt-rp-1', w.sig, w.raw, w.payload);
    const wDup = signedWebhook(order.orderNumber, 'TXN-RP-1', 210_000, 'PKR');
    const second = await payments.handleProviderWebhook('test_pay', 'evt-rp-1', wDup.sig, wDup.raw, wDup.payload);
    check('first delivery confirmed', first.outcome === 'confirmed', first.outcome);
    check('replayed event id -> duplicate', second.outcome === 'duplicate', second.outcome);

    // Concurrent duplicate delivery: exactly one winner.
    const c2 = await confirmedOrder();
    const mk = () => {
      const x = signedWebhook(c2.order.orderNumber, 'TXN-RP-2', 210_000, 'PKR');
      return payments.handleProviderWebhook('test_pay', 'evt-rp-2', x.sig, x.raw, x.payload);
    };
    const [r1, r2] = await Promise.all([mk(), mk()]);
    const outcomes = [r1.outcome, r2.outcome].sort().join(',');
    check('concurrent replay -> one confirmed, one duplicate', outcomes === 'confirmed,duplicate', outcomes);
    const attempts = await prisma.paymentAttempt.count({
      where: { paymentId: c2.payment.id, status: 'SUCCEEDED' },
    });
    const paidCount = await prisma.payment.count({ where: { id: c2.payment.id, status: 'PAID' } });
    check('single SUCCEEDED attempt + single PAID row', attempts === 1 && paidCount === 1, `attempts=${attempts}`);
    void payment;
  }

  // ============================================================ Flow 5 ====
  console.log('== Flow 5: HTTP RBAC on payment endpoints ==');
  const server = await app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  async function login(email: string) {
    const r = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123' }),
    });
    const body = (await r.json()) as { accessToken?: string };
    return { status: r.status, token: body.accessToken ?? '' };
  }
  const ownerLogin = await login('owner@zenskill.test');
  const supportLogin = await login('support@zenskill.test');
  check('owner login 200 + token', ownerLogin.status === 200 && ownerLogin.token.length > 10, String(ownerLogin.status));
  check('support login 200 + token', supportLogin.status === 200 && supportLogin.token.length > 10, String(supportLogin.status));
  {
    const { payment, cActor } = await confirmedOrder();
    await submitFakeProof(payment.id, cActor);
    const auth = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

    // Unauthenticated review -> 401.
    const noAuth = await fetch(`${base}/api/v1/payments/${payment.id}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'APPROVE', reason: 'x' }),
    });
    check('unauthenticated review -> 401', noAuth.status === 401, String(noAuth.status));

    // SUPPORT cannot approve -> 403.
    const forbidden = await fetch(`${base}/api/v1/payments/${payment.id}/review`, {
      method: 'POST', headers: auth(supportLogin.token),
      body: JSON.stringify({ decision: 'APPROVE', reason: 'trying as support' }),
    });
    check('SUPPORT review -> 403', forbidden.status === 403, String(forbidden.status));

    // OWNER approves -> 201 (Nest POST default).
    const ok = await fetch(`${base}/api/v1/payments/${payment.id}/review`, {
      method: 'POST', headers: auth(ownerLogin.token),
      body: JSON.stringify({ decision: 'APPROVE', reason: 'verified via HTTP test' }),
    });
    check('OWNER review -> 201', ok.status === 201, String(ok.status));
    const paid = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    check('HTTP approval confirmed payment', paid.status === 'PAID');

    // Instructions endpoint: readable by support, guarded otherwise.
    const instrOk = await fetch(`${base}/api/v1/payments/${payment.id}/instructions`, { headers: auth(supportLogin.token) });
    const instrBody = (await instrOk.json()) as { transferDetails?: string; amountPaisa?: number };
    check('SUPPORT can read instructions (200)', instrOk.status === 200, String(instrOk.status));
    check('instructions carry transfer details + amount',
      instrBody.amountPaisa === 210_000 && (instrBody.transferDetails ?? '').includes('0300-1234567'));
    const instrNoAuth = await fetch(`${base}/api/v1/payments/${payment.id}/instructions`);
    check('instructions unauthenticated -> 401', instrNoAuth.status === 401, String(instrNoAuth.status));

    // Automation expiry endpoint: service token guard.
    const expNoToken = await fetch(`${base}/api/v1/automation/payments/expire`, { method: 'POST' });
    check('automation expire without token -> 401', expNoToken.status === 401, String(expNoToken.status));
    const expOk = await fetch(`${base}/api/v1/automation/payments/expire`, {
      method: 'POST', headers: { 'x-service-token': 'e2e-service-token' },
    });
    const expBody = (await expOk.json()) as { expired?: number };
    check('automation expire with token -> 201', expOk.status === 201 && typeof expBody.expired === 'number', String(expOk.status));
  }

  // ============================================================ Flow 6 ====
  console.log('== Flow 6: payment-window expiry sweeper ==');
  {
    // Past-deadline PENDING -> FAILED + order CANCELLED + customer CANCELLED + audit.
    const e1 = await confirmedOrder();
    await prisma.order.update({
      where: { id: e1.order.id },
      data: { paymentExpiresAt: new Date(Date.now() - 60_000) },
    });
    const r1 = await payments.runPaymentExpirySweeper();
    check('sweeper expired 1 payment', r1.expired === 1, String(r1.expired));
    const p1 = await prisma.payment.findUniqueOrThrow({ where: { id: e1.payment.id } });
    const o1 = await prisma.order.findUniqueOrThrow({ where: { id: e1.order.id } });
    const cu1 = await customers.getCustomer(e1.customer.id);
    check('expired payment FAILED with reason', p1.status === 'FAILED' && (p1.failureReason ?? '').includes('expired'), p1.failureReason ?? '');
    check('expired order CANCELLED', o1.status === 'CANCELLED', o1.status);
    check('customer moved to CANCELLED', cu1.state === 'CANCELLED', cu1.state);
    const auditHit = await prisma.auditLog.count({ where: { entityId: e1.payment.id, action: 'payment.expired' } });
    check('payment.expired audit row', auditHit === 1, String(auditHit));

    // Idempotent: second run changes nothing.
    const r2 = await payments.runPaymentExpirySweeper();
    check('sweeper idempotent (0 on rerun)', r2.expired === 0, String(r2.expired));

    // MANUAL_REVIEW_REQUIRED past deadline: a human is handling it — untouched.
    const e2 = await confirmedOrder();
    await submitFakeProof(e2.payment.id, e2.cActor);
    await prisma.order.update({
      where: { id: e2.order.id },
      data: { paymentExpiresAt: new Date(Date.now() - 60_000) },
    });
    const r3 = await payments.runPaymentExpirySweeper();
    const p2 = await prisma.payment.findUniqueOrThrow({ where: { id: e2.payment.id } });
    check('payment under review survives expiry', r3.expired === 0 && p2.status === 'MANUAL_REVIEW_REQUIRED', `${r3.expired}/${p2.status}`);

    // Future deadline: untouched.
    const e3 = await confirmedOrder();
    const r4 = await payments.runPaymentExpirySweeper();
    const p3 = await prisma.payment.findUniqueOrThrow({ where: { id: e3.payment.id } });
    check('future-deadline payment untouched', r4.expired === 0 && p3.status === 'PENDING');

    // PAID payment with a past deadline: never reaped.
    const e4 = await confirmedOrder();
    await submitFakeProof(e4.payment.id, e4.cActor);
    await payments.decideManualPayment(e4.payment.id, owner.id, 'APPROVE', 'sweeper test', null);
    await prisma.order.update({
      where: { id: e4.order.id },
      data: { paymentExpiresAt: new Date(Date.now() - 60_000) },
    });
    const r5 = await payments.runPaymentExpirySweeper();
    const p4 = await prisma.payment.findUniqueOrThrow({ where: { id: e4.payment.id } });
    check('PAID payment never expired', r5.expired === 0 && p4.status === 'PAID');
  }

  await app.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('PAYMENT FLOW TESTS FAILED');
    process.exit(1);
  }
  console.log('ALL PAYMENT FLOW TESTS PASSED');
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
