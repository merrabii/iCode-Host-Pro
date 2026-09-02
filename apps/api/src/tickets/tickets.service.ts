import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, TicketStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { JwtPayload } from '../auth/types';
import { roleRank } from '../auth/roles';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { EscalateTicketDto } from './dto/escalate-ticket.dto';
import { TicketMessageDto } from './dto/ticket-message.dto';
import { UpdateTicketStatusDto } from './dto/update-ticket-status.dto';

const L1 = Role.SUPPORT_L1;

/**
 * Phase 10 (ADR-027): minimal support tickets. A client opens a ticket; L1
 * replies + escalates to L2/L3 (rank-aware); everything is audited. Access
 * rule: a ticket is visible to its OWNER or to any support rank >= L1
 * (roleRank semantics from auth/roles.ts).
 */
@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Owner-or-support access control, returns the ticket or throws. */
  private async assertAccess(ticketId: string, actor: JwtPayload) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) throw new NotFoundException('Ticket introuvable.');
    const isSupport = roleRank(actor.role) >= roleRank(L1);
    if (ticket.userId !== actor.sub && !isSupport) {
      throw new ForbiddenException('Accès refusé à ce ticket.');
    }
    return ticket;
  }

  private auditRecord(
    actor: { sub: string; email: string },
    action: string,
    ticketId: string | null,
    details?: Prisma.InputJsonObject,
  ) {
    return this.audit.record({
      actorId: actor.sub,
      actorEmail: actor.email,
      action,
      resourceType: 'ticket',
      resourceId: ticketId,
      ...(details ? { details } : {}),
    });
  }

  async create(actor: JwtPayload, dto: CreateTicketDto) {
    const ticket = await this.prisma.$transaction(async (tx) => {
      const created = await tx.ticket.create({
        data: {
          userId: actor.sub,
          subject: dto.subject,
          priority: dto.priority,
          messages: {
            create: {
              authorId: actor.sub,
              authorEmail: actor.email,
              body: dto.body,
            },
          },
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.sub,
          actorEmail: actor.email,
          action: 'ticket.create',
          resourceType: 'ticket',
          resourceId: created.id,
          details: { subject: dto.subject, priority: dto.priority },
        },
      });
      return created;
    });
    return this.prisma.ticket.findUnique({
      where: { id: ticket.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
  }

  /** List the caller's own tickets (support sees its own tickets only here —
   *  the support queue is the manager panel, not this endpoint). */
  async listMine(actor: JwtPayload) {
    return this.prisma.ticket.findMany({
      where: { userId: actor.sub },
      orderBy: { updatedAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
  }

  /** Support console: the whole ticket queue (L1+), newest-updated first. */
  async listAll(actor: JwtPayload) {
    const tickets = await this.prisma.ticket.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        user: { select: { id: true, email: true, name: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    await this.auditRecord(actor, 'support.tickets.list', null, {
      count: tickets.length,
    });
    return tickets;
  }

  /** Full ticket with messages (owner or support >= L1). */
  async findOne(ticketId: string, actor: JwtPayload) {
    const ticket = await this.assertAccess(ticketId, actor);
    const full = await this.prisma.ticket.findUnique({
      where: { id: ticket.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    return full;
  }

  async addMessage(ticketId: string, actor: JwtPayload, dto: TicketMessageDto) {
    const ticket = await this.assertAccess(ticketId, actor);
    const message = await this.prisma.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        authorId: actor.sub,
        authorEmail: actor.email,
        body: dto.body,
      },
    });
    await this.auditRecord(actor, 'ticket.message', ticket.id);
    return message;
  }

  /** Escalate to a higher support tier (L2 or L3) — support L1+. */
  async escalate(ticketId: string, actor: JwtPayload, dto: EscalateTicketDto) {
    if (dto.to !== Role.SUPPORT_L2 && dto.to !== Role.SUPPORT_L3) {
      throw new BadRequestException('Cible d’escalade invalide (SUPPORT_L2 ou SUPPORT_L3).');
    }
    if (roleRank(dto.to) <= roleRank(actor.role)) {
      throw new BadRequestException(
        'Vous ne pouvez pas escalader vers un rang inférieur ou égal au vôtre.',
      );
    }
    const ticket = await this.assertAccess(ticketId, actor);
    const updated = await this.prisma.ticket.update({
      where: { id: ticket.id },
      data: { escalatedTo: dto.to, escalatedAt: new Date() },
    });
    await this.auditRecord(actor, 'ticket.escalate', ticket.id, { to: dto.to });
    return updated;
  }

  /** Update status — support L1+. */
  async updateStatus(ticketId: string, actor: JwtPayload, dto: UpdateTicketStatusDto) {
    const ticket = await this.assertAccess(ticketId, actor);
    if (dto.status === TicketStatus.CLOSED) {
      throw new BadRequestException('Clôture interdite — utilisez RESOLVED.');
    }
    const updated = await this.prisma.ticket.update({
      where: { id: ticket.id },
      data: { status: dto.status },
    });
    await this.auditRecord(actor, 'ticket.status', ticket.id, { status: dto.status });
    return updated;
  }
}
