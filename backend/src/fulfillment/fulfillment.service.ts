import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { FulfillmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CustomersService, StateTransitionActor } from '../customers/customers.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { assertTaskTransition } from './task-state-machine';
import { FulfillmentProvider, ManualFulfillmentProvider } from './providers/fulfillment-provider.interface';

// Fulfillment task orchestration. Tasks are created by the payment
// confirmation flow; day-one they wait for an admin (manual provider).
// INVARIANT (Phase 8): the customer is NEVER told "delivered" before the
// task reaches COMPLETED. completeTask() is the only path that (a) moves
// order → FULFILLED → ACTIVE and (b) queues the order_fulfilled customer
// notification. Payment confirmation, proof receipt, and webhook handling
// must never send a delivery message.
@Injectable()
export class FulfillmentService {
  private readonly providers = new Map<string, FulfillmentProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {
    this.providers.set('manual', new ManualFulfillmentProvider());
  }

  async listTasks(params: { page?: number; pageSize?: number; status?: FulfillmentStatus }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const where: Prisma.FulfillmentTaskWhereInput = {};
    if (params.status) where.status = params.status;
    const [total, items] = await this.prisma.$transaction([
      this.prisma.fulfillmentTask.count({ where }),
      this.prisma.fulfillmentTask.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          order: { select: { orderNumber: true, customerId: true } },
          assignee: { select: { id: true, name: true } },
        },
      }),
    ]);
    return { total, page, pageSize, items };
  }

  async getTask(id: string) {
    const task = await this.prisma.fulfillmentTask.findUnique({
      where: { id },
      include: { order: { include: { items: { include: { plan: true, product: true } } } } },
    });
    if (!task) throw new NotFoundException('Fulfillment task not found');
    return task;
  }

  /** Admin picks up a task: PENDING → PROCESSING. */
  async claimTask(taskId: string, actor: StateTransitionActor) {
    const task = await this.getTask(taskId);
    assertTaskTransition(task.status, 'PROCESSING');
    // Atomic claim: the conditional update only hits a PENDING row, so among
    // concurrent workers exactly one wins. Losers get a Conflict — never a
    // double claim, and the customer only moves after a successful claim.
    const claimed = await this.prisma.fulfillmentTask.updateMany({
      where: { id: taskId, status: 'PENDING' },
      data: {
        status: 'PROCESSING',
        attempts: { increment: 1 },
        assignedTo: actor.type === 'ADMIN' ? actor.id : undefined,
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException('Task already claimed by another worker');
    }
    const updated = await this.getTask(taskId);
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'fulfillment.claimed', entityType: 'fulfillment_task', entityId: taskId,
      before: { status: task.status }, after: { status: 'PROCESSING' },
      ipAddress: actor.ip ?? null,
    });
    await this.moveCustomer(task.orderId, 'FULFILLMENT_PROCESSING', actor);
    return updated;
  }

  /**
   * Admin (or API provider) completes delivery: PROCESSING/MANUAL_REVIEW →
   * COMPLETED, order → FULFILLED → ACTIVE. Only after this may the customer
   * be told the service was delivered.
   */
  async completeTask(taskId: string, actor: StateTransitionActor, resultNote?: string) {
    const task = await this.getTask(taskId);
    assertTaskTransition(task.status, 'COMPLETED');
    const completed = await this.prisma.$transaction(async (tx) => {
      const updatedTask = await tx.fulfillmentTask.update({
        where: { id: taskId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          result: { completedAt: new Date().toISOString(), note: resultNote ?? null } as Prisma.InputJsonValue,
        },
      });
      const order = await tx.order.findUniqueOrThrow({ where: { id: task.orderId } });
      if (order.status === 'FULFILLING') {
        await tx.order.update({ where: { id: order.id }, data: { status: 'FULFILLED' } });
      }
      const current = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      if (current.status === 'FULFILLED') {
        await tx.order.update({ where: { id: order.id }, data: { status: 'ACTIVE' } });
      }
      await this.audit.log(
        {
          actorType: actor.type, actorId: actor.id ?? null,
          action: 'fulfillment.completed', entityType: 'fulfillment_task', entityId: taskId,
          before: { status: task.status },
          after: { status: 'COMPLETED', orderStatus: 'ACTIVE', note: resultNote ?? null },
          ipAddress: actor.ip ?? null,
        },
        tx,
      );
      return updatedTask;
    });
    await this.moveCustomer(task.orderId, 'FULFILLED', actor);
    await this.moveCustomer(task.orderId, 'ACTIVE', actor);
    // The customer hears "delivered" ONLY here — never at payment
    // confirmation, proof receipt, or webhook time (Phase 8 invariant).
    await this.queueDeliveredNotification(task.orderId, actor);
    return completed;
  }

  /**
   * Queues the order_fulfilled template notification. Called ONLY from
   * completeTask() — this is the single point where a delivery message may
   * originate. The dispatcher (Phase 5) enforces opt-in + 24h-window/template
   * policy when it actually sends.
   */
  private async queueDeliveredNotification(orderId: string, actor: StateTransitionActor) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: { include: { plan: true, product: true } },
        customer: true,
        subscription: true,
      },
    });
    const item = order.items[0];
    const subscription = order.subscription;
    const expiry = subscription
      ? subscription.expiresAt.toISOString().slice(0, 10)
      : item?.plan
        ? new Date(Date.now() + item.plan.durationDays * 86_400_000).toISOString().slice(0, 10)
        : '';
    // Owner-editable via system_settings (templates.order_fulfilled); the
    // default matches the draft in workflows/n8n/message-templates.draft.md.
    const templateName = await this.settings.getSetting('templates.order_fulfilled', 'order_fulfilled');
    await this.notifications.queue(
      order.customerId,
      {
        templateName,
        payload: {
          languageCode: 'en',
          variables: [
            order.orderNumber,
            item?.product?.name ?? 'your service',
            item?.plan?.name ?? '',
            expiry,
          ],
        },
      },
      actor,
    );
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'fulfillment.delivered_notification_queued',
      entityType: 'order', entityId: orderId,
      after: { template: templateName },
      ipAddress: actor.ip ?? null,
    });
  }

  /** Provider failure: PROCESSING → FAILED. Retry re-queues via retryTask(). */
  async failTask(taskId: string, actor: StateTransitionActor, error: string) {
    const task = await this.getTask(taskId);
    assertTaskTransition(task.status, 'FAILED');
    const updated = await this.prisma.fulfillmentTask.update({
      where: { id: taskId },
      data: {
        status: 'FAILED',
        result: { error, failedAt: new Date().toISOString() } as Prisma.InputJsonValue,
      },
    });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'fulfillment.failed', entityType: 'fulfillment_task', entityId: taskId,
      before: { status: task.status }, after: { status: 'FAILED', error },
      ipAddress: actor.ip ?? null,
    });
    return updated;
  }

  /** Idempotent retry: FAILED → PENDING. */
  async retryTask(taskId: string, actor: StateTransitionActor) {
    const task = await this.getTask(taskId);
    assertTaskTransition(task.status, 'PENDING');
    const updated = await this.prisma.fulfillmentTask.update({
      where: { id: taskId },
      data: { status: 'PENDING', result: Prisma.DbNull },
    });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'fulfillment.retried', entityType: 'fulfillment_task', entityId: taskId,
      before: { status: task.status }, after: { status: 'PENDING' },
      ipAddress: actor.ip ?? null,
    });
    return updated;
  }

  /** PROCESSING → MANUAL_REVIEW when a human decision is needed mid-flow. */
  async markManualReview(taskId: string, actor: StateTransitionActor, note: string) {
    const task = await this.getTask(taskId);
    assertTaskTransition(task.status, 'MANUAL_REVIEW');
    if (!note?.trim()) throw new BadRequestException('A review note is required');
    const updated = await this.prisma.fulfillmentTask.update({
      where: { id: taskId },
      data: {
        status: 'MANUAL_REVIEW',
        result: { note: note.trim(), at: new Date().toISOString() } as Prisma.InputJsonValue,
      },
    });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'fulfillment.manual_review', entityType: 'fulfillment_task', entityId: taskId,
      before: { status: task.status }, after: { status: 'MANUAL_REVIEW', note: note.trim() },
      ipAddress: actor.ip ?? null,
    });
    return updated;
  }

  /**
   * Worker entry point: picks up PENDING tasks and runs the provider.
   * The manual provider always defers to a human; API providers execute.
   * Each task is claimed atomically (PENDING → PROCESSING with a conditional
   * update) so concurrent workers never execute the same task twice.
   */
  async processPendingTasks(limit = 25): Promise<{ processed: number; deferred: number }> {
    const tasks = await this.prisma.fulfillmentTask.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    let processed = 0;
    let deferred = 0;
    const systemActor: StateTransitionActor = { type: 'SYSTEM' };
    for (const task of tasks) {
      const provider = this.providers.get(task.provider) ?? this.providers.get('manual')!;
      if (provider.name === 'manual') {
        deferred++;
        continue; // waits for an admin in the queue
      }
      // Atomic claim: only one worker wins the PENDING → PROCESSING race.
      const claimed = await this.prisma.fulfillmentTask.updateMany({
        where: { id: task.id, status: 'PENDING' },
        data: { status: 'PROCESSING', attempts: { increment: 1 } },
      });
      if (claimed.count === 0) continue; // lost the race; another worker has it
      await this.audit.log({
        actorType: 'SYSTEM', action: 'fulfillment.claimed',
        entityType: 'fulfillment_task', entityId: task.id,
        before: { status: 'PENDING' }, after: { status: 'PROCESSING', by: 'worker' },
      });
      await this.moveCustomer(task.orderId, 'FULFILLMENT_PROCESSING', systemActor);
      try {
        const result = await provider.execute({ ...task, status: 'PROCESSING' });
        if (result.requiresManualAction) {
          await this.markManualReview(task.id, systemActor, result.detail ?? 'Provider deferred to manual');
        } else {
          await this.completeTask(task.id, systemActor, result.detail);
        }
        processed++;
      } catch (err) {
        await this.failTask(task.id, systemActor, err instanceof Error ? err.message : String(err));
        processed++;
      }
    }
    return { processed, deferred };
  }

  /** Best-effort customer move; skips (with audit note) when the customer is not in the expected state. */
  private async moveCustomer(orderId: string, to: 'FULFILLMENT_PROCESSING' | 'FULFILLED' | 'ACTIVE', actor: StateTransitionActor) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { customerId: true },
    });
    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id: order.customerId } });
    if (customer.state === to) return;
    const expectedFrom: Record<string, string[]> = {
      FULFILLMENT_PROCESSING: ['FULFILLMENT_PENDING'],
      FULFILLED: ['FULFILLMENT_PROCESSING'],
      ACTIVE: ['FULFILLED'],
    };
    if (!expectedFrom[to].includes(customer.state)) {
      await this.audit.log({
        actorType: actor.type, actorId: actor.id ?? null,
        action: 'fulfillment.customer_state_skipped',
        entityType: 'customer', entityId: customer.id,
        after: { expected: expectedFrom[to], actual: customer.state, target: to },
      });
      return;
    }
    await this.customers.transitionState(customer.id, to, actor);
  }
}
