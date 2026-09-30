process.env.DATABASE_URL =
  'postgresql://zenskill:zenskill_dev@localhost:5432/zenskill_test';
process.env.JWT_SECRET = 'e2e-jwt-secret-min-32-chars-long!!!!';
process.env.BAILEYS_DISABLE = 'true';  // E2E: never open a real WhatsApp socket
process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.PROOF_STORAGE_DIR = '/tmp/zenskill-payments-proofs';
process.env.AUTOMATION_SERVICE_TOKEN = 'e2e-service-token';
// Phase 8 fulfillment acceptance test (run with `npm run test:fulfillment`).
// Boots the FULL Nest application graph against zenskill_test and drives the
// fulfillment lifecycle with real services + PostgreSQL:
//
//   Flow 1: full lifecycle — order -> payment PAID -> task PENDING (payload
//           snapshot incl. product fulfillmentNotes) -> claim -> complete ->
//           order ACTIVE + customer ACTIVE + ACTIVE subscription +
//           order_fulfilled notification queued.
//   Flow 2: never-claim-delivered-early — no delivery notification exists at
//           payment confirmation, after claim, or after failure; order and
//           customer are not ACTIVE until completion.
//   Flow 3: failure -> FAILED -> retry -> PENDING (idempotent across two
//           cycles); illegal transitions rejected (complete/retry/manual-
//           review from PENDING, claim from PROCESSING, note-less review).
//   Flow 4: concurrent claim race — 5 parallel claims, exactly one wins.
//   Flow 5: manual review -> complete -> ACTIVE + notification.
//   Flow 6: worker sweep — manual provider defers (processed 0, deferred 1);
//           automation endpoint guard: 401 no token, 401 wrong token,
//           200 with token.
//   Flow 7: HTTP RBAC — 401 unauthenticated, VIEWER 403 on claim,
//           SUPPORT claim 201, OWNER list 200.
//   Flow 8: product fulfillmentNotes editable via catalog PATCH and
//           snapshotted into new task payloads.
//
// Every step asserts against the database. Exit code 0 = all green.
import { VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthService } from '../src/auth/auth.service';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { CustomersService, StateTransitionActor } from '../src/customers/customers.service';
import { OrdersService } from '../src/orders/orders.service';
import { PaymentsService } from '../src/payments/payments.service';
import { FulfillmentService } from '../src/fulfillment/fulfillment.service';
import { ProofStorageService } from '../src/proofs/proof-storage.service';
import { IllegalTaskTransitionError } from '../src/fulfillment/task-state-machine';

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
  const fulfillment = moduleRef.get(FulfillmentService);
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
    data: { email: 'owner@zenskill.test', name: 'Test Owner', passwordHash: await AuthService.hashPassword('password123'), role: 'OWNER' },
  });
  const supportAdmin = await prisma.adminUser.create({
    data: { email: 'support@zenskill.test', name: 'Test Support', passwordHash: await AuthService.hashPassword('password123'), role: 'SUPPORT' },
  });
  const viewerAdmin = await prisma.adminUser.create({
    data: { email: 'viewer@zenskill.test', name: 'Test Viewer', passwordHash: await AuthService.hashPassword('password123'), role: 'VIEWER' },
  });
  const ownerActor: StateTransitionActor = { type: 'ADMIN', id: owner.id };
  const product = await prisma.product.create({
    data: {
      slug: 'learning-service', name: 'ZenSkil Learning Service', category: 'service',
      fulfillmentNotes: 'Enroll the student in the LMS and email the welcome pack.',
    },
  });
  const plan = await prisma.plan.create({
    data: { productId: product.id, name: '3 Months', durationMonths: 3, durationDays: 90, pricePaisa: 210_000, currency: 'PKR' },
  });
  check('seeded admins/product/plan', !!owner.id && !!plan.id && !!viewerAdmin.id);

  // Helper: fresh customer -> order -> manual payment approved -> task PENDING.
  let custSeq = 0;
  async function confirmedOrder() {
    custSeq++;
    const customer = await customers.findOrCreateByWhatsapp(`9230010000${String(custSeq).padStart(2, '0')}`);
    const cActor: StateTransitionActor = { type: 'CUSTOMER', id: customer.id };
    for (const s of ['BROWSING', 'SELECTING_PRODUCT', 'SELECTING_PLAN'] as const) {
      await customers.transitionState(customer.id, s, cActor);
    }
    const draft = await orders.createDraftOrder(customer.id, { planId: plan.id }, cActor);
    await customers.transitionState(customer.id, 'ORDER_CREATED', cActor);
    const { order, payment } = await orders.confirmOrder(draft.id, cActor);
    await customers.transitionState(customer.id, 'AWAITING_PAYMENT', cActor);
    // Manual review path: proof -> admin approve -> PAID + task created.
    const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from('fake-receipt')]);
    const stored = await proofs.store(payment.id, fakeJpg, 'image/jpeg');
    await payments.submitProof(payment.id, { storageKey: stored.storageKey, proofHash: stored.sha256 }, cActor);
    await payments.decideManualPayment(payment.id, owner.id, 'APPROVE', 'Receipt matches', '127.0.0.1');
    const task = await prisma.fulfillmentTask.findFirstOrThrow({ where: { orderId: order.id } });
    const freshOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const freshCustomer = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    return { customer: freshCustomer, cActor, order: freshOrder, payment, task };
  }
  async function deliveredNotifications(customerId: string) {
    return prisma.notification.findMany({ where: { customerId, templateName: 'order_fulfilled' } });
  }

  // ============================================================ Flow 1 ====
  console.log('== Flow 1: full lifecycle success ==');
  {
    const { customer, order, task } = await confirmedOrder();
    check('task PENDING after payment confirmation', task.status === 'PENDING', task.status);
    const payload = task.payload as Record<string, unknown>;
    check('task payload snapshots product name', payload.productName === 'ZenSkil Learning Service', String(payload.productName));
    check('task payload snapshots plan name', payload.planName === '3 Months', String(payload.planName));
    check('task payload snapshots fulfillmentNotes', payload.fulfillmentNotes === 'Enroll the student in the LMS and email the welcome pack.', String(payload.fulfillmentNotes));
    check('task payload snapshots price', payload.pricePaisa === 210_000 && payload.currency === 'PKR');
    check('order FULFILLING after confirmation', order.status === 'FULFILLING', order.status);
    check('customer FULFILLMENT_PENDING after confirmation', customer.state === 'FULFILLMENT_PENDING', customer.state);
    const sub0 = await prisma.subscription.findFirstOrThrow({ where: { orderId: order.id } });
    check('subscription created ACTIVE at payment confirm', sub0.status === 'ACTIVE', sub0.status);
    check('no delivery notification before completion', (await deliveredNotifications(customer.id)).length === 0);

    const claimed = await fulfillment.claimTask(task.id, ownerActor);
    check('claim -> PROCESSING', claimed.status === 'PROCESSING', claimed.status);
    const cust1 = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    check('customer FULFILLMENT_PROCESSING after claim', cust1.state === 'FULFILLMENT_PROCESSING', cust1.state);

    const done = await fulfillment.completeTask(task.id, ownerActor, 'LMS access emailed');
    check('complete -> COMPLETED', done.status === 'COMPLETED' && !!done.completedAt, done.status);
    const order1 = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    check('order ACTIVE after completion', order1.status === 'ACTIVE', order1.status);
    const cust2 = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    check('customer ACTIVE after completion', cust2.state === 'ACTIVE', cust2.state);
    const sub1 = await prisma.subscription.findFirstOrThrow({ where: { orderId: order.id } });
    check('subscription still ACTIVE', sub1.status === 'ACTIVE', sub1.status);
    const notes = await deliveredNotifications(customer.id);
    check('exactly one order_fulfilled notification queued', notes.length === 1, String(notes.length));
    const vars = (notes[0].payload as { variables: string[] }).variables;
    check('notification carries order number + product + expiry', vars[0] === order.orderNumber && vars[1] === 'ZenSkil Learning Service' && vars[3].length === 10, JSON.stringify(vars));
    const audit = await prisma.auditLog.findFirst({ where: { action: 'fulfillment.delivered_notification_queued', entityId: order.id } });
    check('completion audit written', !!audit);
    let doubleComplete = false;
    try { await fulfillment.completeTask(task.id, ownerActor); } catch { doubleComplete = true; }
    check('double completion rejected', doubleComplete);
  }

  // ============================================================ Flow 2 ====
  console.log('== Flow 2: never claim delivered early ==');
  {
    const { customer, order, task } = await confirmedOrder();
    // After payment confirmation but before any fulfillment work:
    check('no notification at payment confirmation', (await deliveredNotifications(customer.id)).length === 0);
    check('order not ACTIVE before completion', (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status !== 'ACTIVE');
    check('customer not ACTIVE before completion', (await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).state !== 'ACTIVE');
    // After claim — still nothing:
    await fulfillment.claimTask(task.id, ownerActor);
    check('no notification after claim', (await deliveredNotifications(customer.id)).length === 0);
    // After failure — still nothing, and the order is NOT marked fulfilled:
    await fulfillment.failTask(task.id, ownerActor, 'LMS API timeout');
    check('no notification after failure', (await deliveredNotifications(customer.id)).length === 0);
    const orderAfterFail = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    check('order not ACTIVE after failure', orderAfterFail.status !== 'ACTIVE', orderAfterFail.status);
    const custAfterFail = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    check('customer not ACTIVE after failure', custAfterFail.state !== 'ACTIVE', custAfterFail.state);
  }

  // ============================================================ Flow 3 ====
  console.log('== Flow 3: failure/retry idempotency + illegal transitions ==');
  {
    const { task } = await confirmedOrder();
    // Illegal: complete from PENDING.
    let illegal1 = false;
    try { await fulfillment.completeTask(task.id, ownerActor); } catch (e) { illegal1 = e instanceof IllegalTaskTransitionError; }
    check('complete from PENDING rejected', illegal1);
    // Illegal: retry from PENDING.
    let illegal2 = false;
    try { await fulfillment.retryTask(task.id, ownerActor); } catch (e) { illegal2 = e instanceof IllegalTaskTransitionError; }
    check('retry from PENDING rejected', illegal2);
    // Illegal: manual review from PENDING.
    let illegal3 = false;
    try { await fulfillment.markManualReview(task.id, ownerActor, 'note'); } catch (e) { illegal3 = e instanceof IllegalTaskTransitionError; }
    check('manual-review from PENDING rejected', illegal3);

    // Cycle 1: claim -> fail -> retry.
    await fulfillment.claimTask(task.id, ownerActor);
    let doubleClaim = false;
    try { await fulfillment.claimTask(task.id, ownerActor); } catch { doubleClaim = true; }
    check('claim from PROCESSING rejected', doubleClaim);
    const failedTask = await fulfillment.failTask(task.id, ownerActor, 'LMS API timeout');
    check('fail -> FAILED', failedTask.status === 'FAILED' && (failedTask.result as { error: string }).error === 'LMS API timeout', failedTask.status);
    const retried = await fulfillment.retryTask(task.id, ownerActor);
    check('retry -> PENDING (cycle 1)', retried.status === 'PENDING' && retried.result === null, retried.status);
    // Cycle 2: the same failure/retry path works again (idempotent retry).
    await fulfillment.claimTask(task.id, ownerActor);
    await fulfillment.failTask(task.id, ownerActor, 'still down');
    const retried2 = await fulfillment.retryTask(task.id, ownerActor);
    check('retry -> PENDING (cycle 2)', retried2.status === 'PENDING', retried2.status);
    // Note-less manual review rejected even from a legal state.
    await fulfillment.claimTask(task.id, ownerActor);
    let noNote = false;
    try { await fulfillment.markManualReview(task.id, ownerActor, '   '); } catch { noNote = true; }
    check('manual review without note rejected', noNote);
  }

  // ============================================================ Flow 4 ====
  console.log('== Flow 4: concurrent claim race ==');
  {
    const { task } = await confirmedOrder();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => fulfillment.claimTask(task.id, ownerActor)),
    );
    const wins = results.filter((r) => r.status === 'fulfilled').length;
    check('exactly one claim wins the race', wins === 1, `${wins} wins`);
    const final = await fulfillment.getTask(task.id);
    check('task PROCESSING with attempts=1', final.status === 'PROCESSING' && final.attempts === 1, `${final.status}/${final.attempts}`);
  }

  // ============================================================ Flow 5 ====
  console.log('== Flow 5: manual review -> complete ==');
  {
    const { customer, order, task } = await confirmedOrder();
    await fulfillment.claimTask(task.id, ownerActor);
    const mr = await fulfillment.markManualReview(task.id, ownerActor, 'Customer asked for a different start date');
    check('manual review -> MANUAL_REVIEW', mr.status === 'MANUAL_REVIEW', mr.status);
    const done = await fulfillment.completeTask(task.id, ownerActor, 'Delivered on requested date');
    check('complete from MANUAL_REVIEW -> COMPLETED', done.status === 'COMPLETED', done.status);
    check('order ACTIVE after review completion', (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status === 'ACTIVE');
    check('customer ACTIVE after review completion', (await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).state === 'ACTIVE');
    check('notification queued after review completion', (await deliveredNotifications(customer.id)).length === 1);
  }

  // ============================================================ Flow 6 ====
  console.log('== Flow 6: worker sweep + automation endpoint guard ==');
  {
    const { task } = await confirmedOrder();
    const r = await fulfillment.processPendingTasks();
    check('manual provider defers to admin queue', r.processed === 0 && r.deferred >= 1, JSON.stringify(r));
    check('PENDING task untouched by sweep', (await fulfillment.getTask(task.id)).status === 'PENDING');

    const server = await app.listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const noToken = await fetch(`${base}/api/v1/automation/fulfillment/process`, { method: 'POST' });
    check('automation endpoint 401 without token', noToken.status === 401, String(noToken.status));
    const badToken = await fetch(`${base}/api/v1/automation/fulfillment/process`, {
      method: 'POST', headers: { 'x-service-token': 'wrong' },
    });
    check('automation endpoint 401 with wrong token', badToken.status === 401, String(badToken.status));
    const ok = await fetch(`${base}/api/v1/automation/fulfillment/process`, {
      method: 'POST', headers: { 'x-service-token': process.env.AUTOMATION_SERVICE_TOKEN! },
    });
    const okBody = (await ok.json()) as { processed: number; deferred: number };
    check('automation endpoint 200 with token', ok.status === 201 && okBody.deferred >= 1, `${ok.status} ${JSON.stringify(okBody)}`);

    // ========================================================== Flow 7 ====
    console.log('== Flow 7: HTTP RBAC on fulfillment endpoints ==');
    async function login(email: string) {
      const r = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'password123' }),
      });
      const body = (await r.json()) as { accessToken?: string };
      return { status: r.status, token: body.accessToken ?? '' };
    }
    const ownerLogin = await login('owner@zenskill.test');
    const supportLogin = await login('support@zenskill.test');
    const viewerLogin = await login('viewer@zenskill.test');
    const anonList = await fetch(`${base}/api/v1/fulfillment/tasks`);
    check('tasks list 401 unauthenticated', anonList.status === 401, String(anonList.status));
    const ownerList = await fetch(`${base}/api/v1/fulfillment/tasks`, {
      headers: { Authorization: `Bearer ${ownerLogin.token}` },
    });
    check('tasks list 200 for OWNER', ownerList.status === 200, String(ownerList.status));
    const viewerClaim = await fetch(`${base}/api/v1/fulfillment/tasks/${task.id}/claim`, {
      method: 'POST', headers: { Authorization: `Bearer ${viewerLogin.token}` },
    });
    check('VIEWER claim 403', viewerClaim.status === 403, String(viewerClaim.status));
    const supportClaim = await fetch(`${base}/api/v1/fulfillment/tasks/${task.id}/claim`, {
      method: 'POST', headers: { Authorization: `Bearer ${supportLogin.token}` },
    });
    check('SUPPORT claim 201', supportClaim.status === 201, String(supportClaim.status));
    const anonClaim = await fetch(`${base}/api/v1/fulfillment/tasks/${task.id}/claim`, { method: 'POST' });
    check('claim 401 unauthenticated', anonClaim.status === 401, String(anonClaim.status));

    // ========================================================== Flow 8 ====
    console.log('== Flow 8: product fulfillmentNotes editable + snapshotted ==');
    const patch = await fetch(`${base}/api/v1/catalog/products/${product.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ownerLogin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fulfillmentNotes: 'Create the student account and share login credentials.' }),
    });
    const patched = (await patch.json()) as { fulfillmentNotes: string };
    check('OWNER can PATCH product fulfillmentNotes', patch.status === 200 && patched.fulfillmentNotes.includes('login credentials'), `${patch.status}`);
    const { task: task2 } = await confirmedOrder();
    const payload2 = task2.payload as Record<string, unknown>;
    check('new task snapshots updated notes', payload2.fulfillmentNotes === 'Create the student account and share login credentials.', String(payload2.fulfillmentNotes));

    await app.close();
  }

  console.log(`\nfulfillment-flow: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('fulfillment-flow crashed:', err);
  process.exit(1);
});
