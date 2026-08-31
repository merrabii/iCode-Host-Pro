import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { MailException } from '../mail/mail.service';
import { InvitationsService } from './invitations.service';

describe('InvitationsService', () => {
  let service: InvitationsService;
  const mockPrisma = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    invitation: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };
  const mockAudit = { record: jest.fn() };
  const mockConfig = { get: jest.fn() };
  const mockMailSettings = { isEnabled: jest.fn(), sendInvitationMail: jest.fn() };
  const actor = { sub: 'admin', email: 'admin@example.com' };

  beforeEach(() => {
    mockConfig.get.mockReturnValue(undefined); // default 7 days
    mockMailSettings.isEnabled.mockResolvedValue(false); // mail off by default
    service = new InvitationsService(
      mockPrisma as never,
      mockConfig as never,
      mockAudit as never,
      mockMailSettings as never,
    );
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('refuses when a user already exists with that email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@x.com' });
      await expect(service.create({ email: 'a@x.com' }, actor)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mockPrisma.invitation.create).not.toHaveBeenCalled();
    });

    it('refuses when a pending invite already exists for that email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.invitation.findFirst.mockResolvedValue({ id: 'i1' });
      await expect(service.create({ email: 'a@x.com' }, actor)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('creates an invite (sha256 tokenHash, future expiry) and journals it', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.invitation.findFirst.mockResolvedValue(null);
      mockPrisma.invitation.create.mockImplementation(async ({ data }) => ({
        id: 'inv1',
        email: data.email,
        tokenHash: data.tokenHash,
        issuerId: data.issuerId,
        expiresAt: data.expiresAt,
      }));
      const res = await service.create({ email: 'a@x.com' }, actor);

      expect(res.token.length).toBeGreaterThan(20);
      expect(res.id).toBe('inv1');
      expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(res.emailSent).toBe(false); // mail disabled by default
      const call = mockPrisma.invitation.create.mock.calls[0][0];
      expect(call.data.tokenHash).not.toBe(res.token); // raw never stored
      expect(call.data.tokenHash).toHaveLength(64); // sha256 hex
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'invite.create', actorId: 'admin', resourceId: 'inv1' }),
      );
      expect(mockMailSettings.sendInvitationMail).not.toHaveBeenCalled();
    });

    it('sends the invitation email when mail is enabled → emailSent true', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.invitation.findFirst.mockResolvedValue(null);
      mockPrisma.invitation.create.mockImplementation(async ({ data }) => ({
        id: 'inv1',
        email: data.email,
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
      }));
      mockMailSettings.isEnabled.mockResolvedValue(true);
      mockMailSettings.sendInvitationMail.mockResolvedValue(undefined);

      const res = await service.create({ email: 'a@x.com' }, actor);

      expect(res.emailSent).toBe(true);
      expect(mockMailSettings.sendInvitationMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'a@x.com', token: res.token, email: 'a@x.com' }),
      );
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'invite.email',
          details: expect.objectContaining({ email: 'a@x.com', emailSent: true }),
        }),
      );
    });

    it('mail enabled but send fails → emailSent false, token still returned, reason journaled', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.invitation.findFirst.mockResolvedValue(null);
      mockPrisma.invitation.create.mockImplementation(async ({ data }) => ({
        id: 'inv1',
        email: data.email,
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
      }));
      mockMailSettings.isEnabled.mockResolvedValue(true);
      mockMailSettings.sendInvitationMail.mockRejectedValue(
        new MailException('ECONNREFUSED smtp.example.com:587'),
      );

      const res = await service.create({ email: 'a@x.com' }, actor);

      expect(res.emailSent).toBe(false);
      expect(res.token.length).toBeGreaterThan(20); // manual fallback kept
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'invite.email',
          details: expect.objectContaining({ emailSent: false, reason: 'ECONNREFUSED smtp.example.com:587' }),
        }),
      );
    });
  });

  describe('list', () => {
    it('derives pending/used/revoked/expired statuses from the fields', async () => {
      const now = Date.now();
      mockPrisma.invitation.findMany.mockResolvedValue([
        { id: 'a', usedAt: null, revokedAt: null, expiresAt: new Date(now + 1000) },
        { id: 'b', usedAt: new Date(), revokedAt: null, expiresAt: new Date(now + 1000) },
        { id: 'c', usedAt: null, revokedAt: new Date(), expiresAt: new Date(now + 1000) },
        { id: 'd', usedAt: null, revokedAt: null, expiresAt: new Date(now - 1000) },
      ]);
      const list = await service.list();
      expect(list.map((i) => [i.id, i.status])).toEqual([
        ['a', 'pending'],
        ['b', 'used'],
        ['c', 'revoked'],
        ['d', 'expired'],
      ]);
    });
  });

  describe('revoke', () => {
    it('throws NotFound for an unknown id', async () => {
      mockPrisma.invitation.findUnique.mockResolvedValue(null);
      await expect(service.revoke('nope', actor)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to revoke a used invite', async () => {
      mockPrisma.invitation.findUnique.mockResolvedValue({ id: 'i', usedAt: new Date() });
      await expect(service.revoke('i', actor)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('is idempotent when already revoked (no second journal entry)', async () => {
      mockPrisma.invitation.findUnique.mockResolvedValue({
        id: 'i',
        usedAt: null,
        revokedAt: new Date(),
      });
      await expect(service.revoke('i', actor)).resolves.toMatchObject({ status: 'revoked' });
      expect(mockPrisma.invitation.update).not.toHaveBeenCalled();
    });

    it('revokes a pending invite and journals invite.revoke', async () => {
      mockPrisma.invitation.findUnique.mockResolvedValue({
        id: 'i',
        email: 'a@x.com',
        usedAt: null,
        revokedAt: null,
      });
      mockPrisma.invitation.update.mockResolvedValue({ id: 'i' });
      await expect(service.revoke('i', actor)).resolves.toMatchObject({
        id: 'i',
        status: 'revoked',
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'invite.revoke', resourceId: 'i' }),
      );
    });
  });

  describe('consume', () => {
    const inv = {
      id: 'i1',
      email: 'guest@example.com',
      tokenHash: 'x',
      issuerId: 'admin',
      usedAt: null as Date | null,
      revokedAt: null as Date | null,
      expiresAt: new Date(Date.now() + 1000),
    };

    it('rejects an unknown token', async () => {
      mockPrisma.invitation.findUnique.mockResolvedValue(null);
      await expect(
        service.consume('bad-token', 'guest@example.com', 'password123'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a revoked invite', async () => {
      mockPrisma.invitation.findUnique.mockResolvedValue({ ...inv, revokedAt: new Date() });
      await expect(
        service.consume('tok', 'guest@example.com', 'password123'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a used invite', async () => {
      mockPrisma.invitation.findUnique.mockResolvedValue({ ...inv, usedAt: new Date() });
      await expect(
        service.consume('tok', 'guest@example.com', 'password123'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an expired invite', async () => {
      mockPrisma.invitation.findUnique.mockResolvedValue({
        ...inv,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(
        service.consume('tok', 'guest@example.com', 'password123'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an email that does not match the invitation', async () => {
      mockPrisma.invitation.findUnique.mockResolvedValue(inv);
      await expect(
        service.consume('tok', 'other@example.com', 'password123'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates the USER account (role USER), marks used, journals invite.accept', async () => {
      mockPrisma.invitation.findUnique.mockResolvedValue(inv);
      mockPrisma.user.create.mockResolvedValue({
        id: 'u1',
        email: 'guest@example.com',
        role: 'USER',
      });
      mockPrisma.invitation.update.mockResolvedValue(inv);
      const user = await service.consume('tok', 'GUEST@example.com', 'password123', 'Guest');
      expect(user).toMatchObject({ id: 'u1', role: 'USER' });
      expect(mockPrisma.invitation.update).toHaveBeenCalledWith({
        where: { id: 'i1' },
        data: { usedAt: expect.any(Date) },
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'invite.accept', resourceId: 'i1', actorEmail: 'guest@example.com' }),
      );
    });
  });
});
