import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ActorType, CustomerState, Language, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { assertTransition } from './state-machine';

export interface StateTransitionActor {
  type: ActorType;
  id?: string | null;
  ip?: string | null;
}

const SYSTEM_ACTOR: StateTransitionActor = { type: 'SYSTEM' };

// Customers + their conversation session. The session state drives message
// routing; customers.state mirrors it. transitionState() moves both together
// inside one transaction and writes an audit row — it is the ONLY way state
// may change.
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findOrCreateByWhatsapp(
    whatsappNumber: string,
    name?: string,
  ): Promise<{ id: string; whatsappNumber: string; state: CustomerState; language: Language; name: string | null }> {
    const normalized = whatsappNumber.replace(/[^0-9]/g, '');
    // Create-first: concurrent first messages from the same number race on
    // the unique whatsapp_number — the loser re-reads instead of throwing.
    let customer;
    try {
      customer = await this.prisma.customer.create({
        data: { whatsappNumber: normalized, name: name ?? null, state: 'NEW' },
      });
      await this.audit.log({
        actorType: 'CUSTOMER',
        actorId: customer.id,
        action: 'customer.created',
        entityType: 'customer',
        entityId: customer.id,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      customer = await this.prisma.customer.findUniqueOrThrow({
        where: { whatsappNumber: normalized },
      });
    }
    await this.getOrCreateSession(customer.id);
    return customer;
  }

  async getCustomer(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        sessions: { orderBy: { updatedAt: 'desc' }, take: 1 },
        orders: { orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, orderNumber: true, status: true, totalPaisa: true, createdAt: true } },
        subscriptions: { where: { status: { in: ['ACTIVE', 'EXPIRING_SOON'] } } },
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  async listCustomers(params: { page?: number; pageSize?: number; state?: CustomerState; search?: string }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const where: Prisma.CustomerWhereInput = {};
    if (params.state) where.state = params.state;
    if (params.search) {
      where.OR = [
        { whatsappNumber: { contains: params.search } },
        { name: { contains: params.search, mode: 'insensitive' } },
      ];
    }
    const [total, items] = await this.prisma.$transaction([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, page, pageSize, items };
  }

  async updateCustomer(
    id: string,
    data: { name?: string; email?: string; language?: Language; notes?: string; optedIn?: boolean },
    actor: StateTransitionActor,
  ) {
    const before = await this.prisma.customer.findUniqueOrThrow({ where: { id } });
    const updated = await this.prisma.customer.update({ where: { id }, data });
    await this.audit.log({
      actorType: actor.type,
      actorId: actor.id ?? null,
      action: 'customer.updated',
      entityType: 'customer',
      entityId: id,
      before: { name: before.name, email: before.email, language: before.language, optedIn: before.optedIn },
      after: { name: updated.name, email: updated.email, language: updated.language, optedIn: updated.optedIn },
      ipAddress: actor.ip ?? null,
    });
    return updated;
  }

  async getOrCreateSession(customerId: string) {
    // Serialize concurrent creators with a transaction-scoped advisory lock
    // on the customer id: exactly one session is created for a burst of
    // simultaneous first messages, instead of one per racing worker.
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${customerId}))`;
      const existing = await tx.conversationSession.findFirst({
        where: { customerId },
        orderBy: { updatedAt: 'desc' },
      });
      if (existing) return existing;
      const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
      return tx.conversationSession.create({
        data: { customerId, channel: 'whatsapp', state: customer.state, context: {} },
      });
    });
  }

  async getSessionContext(sessionId: string): Promise<Record<string, unknown>> {
    const session = await this.prisma.conversationSession.findUniqueOrThrow({ where: { id: sessionId } });
    return (session.context as Record<string, unknown>) ?? {};
  }

  async updateSessionContext(sessionId: string, patch: Record<string, unknown>): Promise<void> {
    const current = await this.getSessionContext(sessionId);
    await this.prisma.conversationSession.update({
      where: { id: sessionId },
      data: { context: { ...current, ...patch } as Prisma.InputJsonValue },
    });
  }

  /**
   * Move a customer (and their active session) to a new state.
   * Illegal transitions throw IllegalStateTransitionError and are logged.
   */
  async transitionState(
    customerId: string,
    to: CustomerState,
    actor: StateTransitionActor = SYSTEM_ACTOR,
  ): Promise<CustomerState> {
    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    const from = customer.state;
    if (from === to) return from;
    try {
      assertTransition(from, to);
    } catch (err) {
      await this.audit.log({
        actorType: actor.type,
        actorId: actor.id ?? null,
        action: 'customer.illegal_transition_attempt',
        entityType: 'customer',
        entityId: customerId,
        after: { from, to },
        ipAddress: actor.ip ?? null,
      });
      throw new BadRequestException(`Illegal state transition: ${from} → ${to}`);
    }

    const session = await this.getOrCreateSession(customerId);
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.customer.update({ where: { id: customerId }, data: { state: to } });
      await tx.conversationSession.update({
        where: { id: session.id },
        data: {
          state: to,
          // Entering support stores where to resume; leaving support restores nothing automatically.
          returnState: to === 'SUPPORT_REQUIRED' ? from : undefined,
        },
      });
      await this.audit.log(
        {
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'customer.state_changed',
          entityType: 'customer',
          entityId: customerId,
          before: { state: from },
          after: { state: to },
          ipAddress: actor.ip ?? null,
        },
        tx,
      );
      return updated;
    });
    return result.state;
  }

  /** Admin override: force a state without transition checks (audited, OWNER only at the route layer). */
  async forceState(customerId: string, to: CustomerState, actor: StateTransitionActor): Promise<CustomerState> {
    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    const from = customer.state;
    const session = await this.getOrCreateSession(customerId);
    await this.prisma.$transaction(async (tx) => {
      await tx.customer.update({ where: { id: customerId }, data: { state: to } });
      await tx.conversationSession.update({ where: { id: session.id }, data: { state: to } });
      await this.audit.log(
        {
          actorType: actor.type,
          actorId: actor.id ?? null,
          action: 'customer.state_forced',
          entityType: 'customer',
          entityId: customerId,
          before: { state: from },
          after: { state: to },
          ipAddress: actor.ip ?? null,
        },
        tx,
      );
    });
    return to;
  }
}

/** True when err is a Prisma unique-constraint violation (P2002). */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
