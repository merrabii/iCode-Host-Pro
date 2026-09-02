import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role, TicketStatus } from '@prisma/client';
import { TicketsService } from './tickets.service';

describe('TicketsService (minimal support tickets, ADR-027)', () => {
  const mockPrisma = {
    $transaction: jest.fn(),
    ticket: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    ticketMessage: { create: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const mockAudit = { record: jest.fn() };

  let service: TicketsService;
  beforeEach(() => {
    service = new TicketsService(mockPrisma as never, mockAudit as never);
    jest.clearAllMocks();
  });

  const owner = { sub: 'u1', email: 'u1@example.com', role: Role.USER } as never;
  const otherUser = { sub: 'u2', email: 'u2@example.com', role: Role.USER } as never;
  const l1 = { sub: 'l1', email: 'l1@example.com', role: Role.SUPPORT_L1 } as never;
  const ticket = { id: 't1', userId: 'u1', subject: 'Aide', status: TicketStatus.OPEN };

  describe('access control (owner or support >= L1)', () => {
    it('the owner can read their own ticket', async () => {
      mockPrisma.ticket.findUnique.mockResolvedValue({ ...ticket, messages: [] });
      await expect(service.findOne('t1', owner)).resolves.toMatchObject({ id: 't1' });
    });

    it('another user is forbidden (403)', async () => {
      mockPrisma.ticket.findUnique.mockResolvedValue(ticket);
      await expect(service.findOne('t1', otherUser)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('any support rank >= L1 can read the ticket', async () => {
      mockPrisma.ticket.findUnique.mockResolvedValue({ ...ticket, messages: [] });
      await expect(service.findOne('t1', l1)).resolves.toMatchObject({ id: 't1' });
    });

    it('an unknown ticket is a 404', async () => {
      mockPrisma.ticket.findUnique.mockResolvedValue(null);
      await expect(service.findOne('nope', l1)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('create wraps the ticket + first message + audit in one transaction', async () => {
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
    mockPrisma.ticket.create.mockResolvedValue({ id: 't1', userId: 'u1' });
    mockPrisma.ticket.findUnique.mockResolvedValue({ id: 't1', messages: [] });

    await service.create(owner, { subject: 'Aide', body: 'Salut' });
    expect(mockPrisma.ticket.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1',
        messages: {
          create: expect.objectContaining({ authorId: 'u1', body: 'Salut' }),
        },
      }),
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'ticket.create' }) }),
    );
  });

  it('listMine scopes to the caller', async () => {
    mockPrisma.ticket.findMany.mockResolvedValue([]);
    await service.listMine(owner);
    expect(mockPrisma.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1' } }),
    );
  });

  it('listAll returns the whole queue for the support console and audits it', async () => {
    mockPrisma.ticket.findMany.mockResolvedValue([ticket]);
    const rows = await service.listAll(l1);
    expect(rows).toHaveLength(1);
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'support.tickets.list' }),
    );
  });

  it('escalate refuses a target at or below the actor rank', async () => {
    mockPrisma.ticket.findUnique.mockResolvedValue(ticket);
    // The DTO type only admits L2/L3, but the service must also defend against
    // any invalid target (cast simulates a tampered/older payload).
    await expect(
      service.escalate('t1', l1, { to: Role.SUPPORT_L1 } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.escalate('t1', l1, { to: Role.ADMIN } as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('escalate to L2 works for L1 and audits', async () => {
    mockPrisma.ticket.findUnique.mockResolvedValue(ticket);
    mockPrisma.ticket.update.mockResolvedValue({ ...ticket, escalatedTo: Role.SUPPORT_L2 });
    const updated = await service.escalate('t1', l1, { to: Role.SUPPORT_L2 });
    expect(updated.escalatedTo).toBe(Role.SUPPORT_L2);
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ticket.escalate' }),
    );
  });

  it('updateStatus forbids CLOSED (the flow ends at RESOLVED)', async () => {
    mockPrisma.ticket.findUnique.mockResolvedValue(ticket);
    await expect(
      service.updateStatus('t1', l1, { status: TicketStatus.CLOSED }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updateStatus to RESOLVED works and audits', async () => {
    mockPrisma.ticket.findUnique.mockResolvedValue(ticket);
    mockPrisma.ticket.update.mockResolvedValue({ ...ticket, status: TicketStatus.RESOLVED });
    const updated = await service.updateStatus('t1', l1, { status: TicketStatus.RESOLVED });
    expect(updated.status).toBe(TicketStatus.RESOLVED);
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ticket.status' }),
    );
  });
});
