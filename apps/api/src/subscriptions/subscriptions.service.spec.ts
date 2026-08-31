import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';

describe('SubscriptionsService', () => {
  let service: SubscriptionsService;
  const mockPrisma = {
    product: { findUnique: jest.fn() },
    subscription: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    service: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    server: { findUnique: jest.fn() },
  };
  const mockAudit = { record: jest.fn() };
  const user = { sub: 'u1', email: 'user@example.com' };
  const admin = { sub: 'a1', email: 'admin@example.com' };

  beforeEach(() => {
    service = new SubscriptionsService(mockPrisma as never, mockAudit as never);
    jest.clearAllMocks();
  });

  describe('createSubscription (client)', () => {
    it('throws NotFound when the product does not exist', async () => {
      mockPrisma.product.findUnique.mockResolvedValue(null);
      await expect(service.createSubscription({ productId: 'p1' }, user)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws BadRequest for a DRAFT/DISABLED product', async () => {
      mockPrisma.product.findUnique.mockResolvedValue({ id: 'p1', status: 'DRAFT' });
      await expect(service.createSubscription({ productId: 'p1' }, user)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('creates a PENDING subscription and journals it', async () => {
      mockPrisma.product.findUnique.mockResolvedValue({ id: 'p1', name: 'Hébergement', status: 'ACTIVE' });
      mockPrisma.subscription.create.mockResolvedValue({ id: 's1', userId: 'u1', status: 'PENDING' });
      await expect(service.createSubscription({ productId: 'p1' }, user)).resolves.toMatchObject({
        id: 's1',
        status: 'PENDING',
      });
      expect(mockPrisma.subscription.create).toHaveBeenCalledWith({
        data: { userId: 'u1', productId: 'p1' },
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'subscription.create', actorId: 'u1', resourceId: 's1' }),
      );
    });
  });

  describe('cancelMySubscription (client)', () => {
    it('returns 404 for a subscription that is not the actor’s (no existence leak)', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(null);
      await expect(service.cancelMySubscription('s1', user)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockPrisma.subscription.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 's1', userId: 'u1' } }),
      );
    });

    it('refuses to cancel a CANCELLED subscription', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({ id: 's1', status: 'CANCELLED' });
      await expect(service.cancelMySubscription('s1', user)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('cancels an ACTIVE subscription and journals subscription.cancel', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({ id: 's1', status: 'ACTIVE' });
      mockPrisma.subscription.update.mockResolvedValue({ id: 's1', status: 'CANCELLED' });
      await expect(service.cancelMySubscription('s1', user)).resolves.toMatchObject({
        status: 'CANCELLED',
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'subscription.cancel', actorId: 'u1', resourceId: 's1' }),
      );
    });
  });

  describe('createMyService (client)', () => {
    it('requires an ACTIVE own subscription', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({ id: 's1', status: 'PENDING' });
      await expect(
        service.createMyService({ subscriptionId: 's1', name: 'App' }, user),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.service.create).not.toHaveBeenCalled();
    });

    it('creates a REQUESTED service and journals service.request', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({ id: 's1', status: 'ACTIVE' });
      mockPrisma.service.create.mockResolvedValue({ id: 'sv1', name: 'App', status: 'REQUESTED' });
      await expect(
        service.createMyService({ subscriptionId: 's1', name: 'App' }, user),
      ).resolves.toMatchObject({ id: 'sv1', status: 'REQUESTED' });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'service.request', actorId: 'u1', resourceId: 'sv1' }),
      );
    });
  });

  describe('updateSubscription (admin)', () => {
    const base = { id: 's1', productId: 'p1', status: 'PENDING' };

    it('throws NotFound for an unknown subscription', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      await expect(
        service.updateSubscription('nope', { status: 'ACTIVE' }, admin),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is idempotent when the status is unchanged', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({ ...base });
      await expect(
        service.updateSubscription('s1', { status: 'PENDING' }, admin),
      ).resolves.toMatchObject({ status: 'PENDING' });
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });

    it('rejects a transition that is not in the whitelist', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({ ...base, status: 'REJECTED' });
      await expect(
        service.updateSubscription('s1', { status: 'ACTIVE' }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('approves PENDING → ACTIVE and journals subscription.approve', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({ ...base });
      mockPrisma.subscription.update.mockResolvedValue({ ...base, status: 'ACTIVE' });
      await expect(
        service.updateSubscription('s1', { status: 'ACTIVE' }, admin),
      ).resolves.toMatchObject({ status: 'ACTIVE' });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'subscription.approve', resourceId: 's1' }),
      );
    });

    it('reactivates SUSPENDED → ACTIVE', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({ ...base, status: 'SUSPENDED' });
      mockPrisma.subscription.update.mockResolvedValue({ ...base, status: 'ACTIVE' });
      await expect(
        service.updateSubscription('s1', { status: 'ACTIVE' }, admin),
      ).resolves.toMatchObject({ status: 'ACTIVE' });
    });
  });

  describe('updateService (admin)', () => {
    const base = { id: 'sv1', name: 'App', status: 'REQUESTED', serverId: null };

    it('throws NotFound for an unknown service', async () => {
      mockPrisma.service.findUnique.mockResolvedValue(null);
      await expect(service.updateService('nope', { status: 'ACTIVE' }, admin)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses to assign a server that does not exist', async () => {
      mockPrisma.service.findUnique.mockResolvedValue({ ...base, server: null });
      mockPrisma.server.findUnique.mockResolvedValue(null);
      await expect(
        service.updateService('sv1', { serverId: 'nope' }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('assigns an existing server and journals service.assign', async () => {
      mockPrisma.service.findUnique.mockResolvedValue({ ...base, server: null });
      mockPrisma.server.findUnique.mockResolvedValue({ id: 'srv1', name: 'vps', hostname: 'vps.ihp' });
      mockPrisma.service.update.mockResolvedValue({ ...base, serverId: 'srv1' });
      await expect(service.updateService('sv1', { serverId: 'srv1' }, admin)).resolves.toMatchObject({
        serverId: 'srv1',
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'service.assign', resourceId: 'sv1' }),
      );
    });

    it('advances REQUESTED → PROVISIONING (then → ACTIVE), stubbed', async () => {
      mockPrisma.service.findUnique.mockResolvedValue({ ...base, server: null });
      mockPrisma.service.update.mockResolvedValue({ ...base, status: 'PROVISIONING' });
      await expect(
        service.updateService('sv1', { status: 'PROVISIONING' }, admin),
      ).resolves.toMatchObject({ status: 'PROVISIONING' });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'service.provision' }),
      );
    });

    it('rejects an illegal service transition (REQUESTED → ACTIVE)', async () => {
      mockPrisma.service.findUnique.mockResolvedValue({ ...base, server: null });
      await expect(
        service.updateService('sv1', { status: 'ACTIVE' }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('ownership guards', () => {
    it('listMyServices scopes to the actor’s subscriptions', async () => {
      mockPrisma.service.findMany.mockResolvedValue([]);
      await service.listMyServices(user);
      expect(mockPrisma.service.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { subscription: { userId: 'u1' } } }),
      );
    });

    it('listMySubscriptions scopes to the actor', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([]);
      await service.listMySubscriptions(user);
      expect(mockPrisma.subscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u1' } }),
      );
    });
  });
});
