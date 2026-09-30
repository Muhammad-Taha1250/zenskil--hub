import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TicketAuthorType, TicketPriority, TicketStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { StateTransitionActor } from '../customers/customers.service';

// Support ticket lifecycle:
//   OPEN → ASSIGNED → (WAITING_CUSTOMER | WAITING_INTERNAL) → RESOLVED → CLOSED
// Tickets store returnState so the conversation resumes where the customer
// left off after SUPPORT_REQUIRED.
@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private ticketNumber(): string {
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const rand = Math.floor(10000 + Math.random() * 90000);
    return `ZSH-T-${day}-${rand}`;
  }

  async createTicket(
    customerId: string,
    input: {
      subject: string;
      description?: string;
      orderId?: string;
      priority?: TicketPriority;
      returnState?: Prisma.SupportTicketCreateInput['returnState'];
      authorType?: TicketAuthorType;
    },
    actor: StateTransitionActor,
  ) {
    if (!input.subject?.trim()) throw new BadRequestException('Ticket subject is required');
    // Bounded retry on ticket-number collision (unique constraint).
    let ticket = null;
    for (let attempt = 0; attempt < 5 && !ticket; attempt++) {
      try {
        ticket = await this.prisma.supportTicket.create({
          data: {
            ticketNumber: this.ticketNumber(),
            customerId,
            orderId: input.orderId ?? null,
            subject: input.subject.trim(),
            priority: input.priority ?? 'MEDIUM',
            returnState: input.returnState ?? null,
            messages: input.description
              ? {
                  create: {
                    authorType: input.authorType ?? 'CUSTOMER',
                    authorId: actor.type === 'ADMIN' ? actor.id : null,
                    bodyText: input.description,
                  },
                }
              : undefined,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < 4) continue;
        throw err;
      }
    }
    if (!ticket) throw new BadRequestException('Could not allocate a ticket number; please retry');
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'ticket.created', entityType: 'support_ticket', entityId: ticket.id,
      after: { ticketNumber: ticket.ticketNumber, subject: ticket.subject, priority: ticket.priority },
      ipAddress: actor.ip ?? null,
    });
    return ticket;
  }

  async listTickets(params: {
    page?: number; pageSize?: number; status?: TicketStatus; priority?: TicketPriority; assignedTo?: string;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const where: Prisma.SupportTicketWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.priority) where.priority = params.priority;
    if (params.assignedTo) where.assignedTo = params.assignedTo;
    const [total, items] = await this.prisma.$transaction([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          customer: { select: { whatsappNumber: true, name: true } },
          assignee: { select: { id: true, name: true } },
        },
      }),
    ]);
    return { total, page, pageSize, items };
  }

  async getTicket(id: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        customer: { select: { whatsappNumber: true, name: true } },
        assignee: { select: { id: true, name: true } },
        order: { select: { orderNumber: true, status: true } },
      },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  async addMessage(
    ticketId: string,
    authorType: TicketAuthorType,
    authorId: string | null,
    bodyText: string,
    actor: StateTransitionActor,
  ) {
    if (!bodyText?.trim()) throw new BadRequestException('Message body is required');
    await this.getTicket(ticketId);
    const message = await this.prisma.ticketMessage.create({
      data: { ticketId, authorType, authorId, bodyText: bodyText.trim() },
    });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'ticket.message_added', entityType: 'support_ticket', entityId: ticketId,
      after: { authorType },
      ipAddress: actor.ip ?? null,
    });
    return message;
  }

  async assignTicket(ticketId: string, assigneeId: string, actor: StateTransitionActor) {
    const ticket = await this.getTicket(ticketId);
    await this.prisma.adminUser.findUniqueOrThrow({ where: { id: assigneeId } });
    const updated = await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: { assignedTo: assigneeId, status: ticket.status === 'OPEN' ? 'ASSIGNED' : ticket.status },
    });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'ticket.assigned', entityType: 'support_ticket', entityId: ticketId,
      before: { assignedTo: ticket.assignedTo }, after: { assignedTo: assigneeId },
      ipAddress: actor.ip ?? null,
    });
    return updated;
  }

  async setStatus(ticketId: string, status: TicketStatus, actor: StateTransitionActor) {
    const ticket = await this.getTicket(ticketId);
    const order: TicketStatus[] = ['OPEN', 'ASSIGNED', 'WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'];
    if (order.indexOf(status) < order.indexOf(ticket.status) && status !== 'OPEN') {
      throw new BadRequestException(`Cannot move ticket backwards from ${ticket.status} to ${status}`);
    }
    const data: Prisma.SupportTicketUpdateInput = { status };
    if (status === 'RESOLVED') data.resolvedAt = new Date();
    if (status === 'CLOSED') data.closedAt = new Date();
    const updated = await this.prisma.supportTicket.update({ where: { id: ticketId }, data });
    await this.audit.log({
      actorType: actor.type, actorId: actor.id ?? null,
      action: 'ticket.status_changed', entityType: 'support_ticket', entityId: ticketId,
      before: { status: ticket.status }, after: { status },
      ipAddress: actor.ip ?? null,
    });
    return updated;
  }

  /** Open tickets for a customer — used by the AI to avoid duplicate tickets. */
  async findOpenForCustomer(customerId: string) {
    return this.prisma.supportTicket.findMany({
      where: { customerId, status: { in: ['OPEN', 'ASSIGNED', 'WAITING_CUSTOMER', 'WAITING_INTERNAL'] } },
      orderBy: { createdAt: 'desc' },
    });
  }
}
