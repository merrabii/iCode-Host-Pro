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
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    server: { findUnique: jest.fn() },
  };
  const mockAudit = { record: jest.fn() };
  const mockProvisioning = { syncAppLimits: jest.fn() };
  const user = { sub: 'u1', email: 'user@example.com' };
  const admin = { sub: 'a1', email: 'admin@example.com' };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SubscriptionsService(
      mockPrisma as never,
      mockAudit as never,
      mockProvisioning as never,
    );
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

  describe('ownership guards', () => {
    it('listMySubscriptions scopes to the actor', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([]);
      await service.listMySubscriptions(user);
      expect(mockPrisma.subscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u1' } }),
      );
    });
  });

  describe('syncSubscriptionLimits (admin)', () => {
    it('delegates to ProvisioningService.syncAppLimits (Bloc 2/3 resync)', async () => {
      mockPrisma.subscription.findUniqueOrThrow.mockResolvedValue({ id: 's1' });
      mockProvisioning.syncAppLimits.mockResolvedValue({
        subscriptionId: 's1',
        checked: 2,
        applied: 2,
        failed: 0,
      });
      const out = await service.syncSubscriptionLimits('s1');
      expect(mockPrisma.subscription.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 's1' },
      });
      expect(mockProvisioning.syncAppLimits).toHaveBeenCalledWith('s1');
      expect(out).toMatchObject({ subscriptionId: 's1', applied: 2 });
    });
  });
});
