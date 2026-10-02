import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

describe('UsersService', () => {
  let service: UsersService;
  const mockPrisma = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    subscription: {
      findFirst: jest.fn(),
    },
    clientProject: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  };
  const mockAudit = { record: jest.fn() };
  const mockDeployments = {
    getOrCreateClientProject: jest.fn(),
  };

  const admin = {
    id: 'a1',
    email: 'admin@example.com',
    name: 'Admin',
    role: Role.ADMIN,
    isActive: true,
    passwordHash: 'secret',
    mfaSecretEnc: 'enc-secret',
    githubTokenEnc: 'enc-token',
    mfaEnabled: true,
    oauthProvider: 'google',
  };
  const user = {
    id: 'u1',
    email: 'user@example.com',
    name: 'User',
    role: Role.USER,
    isActive: true,
    passwordHash: 'secret',
    mfaSecretEnc: 'enc-secret',
    githubTokenEnc: 'enc-token',
    mfaEnabled: false,
    oauthProvider: null,
  };

  const actorSelf = { sub: 'a1', email: 'admin@example.com' };
  const actorOther = { sub: 'o1', email: 'other@example.com' };

  beforeEach(() => {
    service = new UsersService(mockPrisma as never, mockAudit as never, mockDeployments as never);
    jest.clearAllMocks();
  });

  it('getProfile strips passwordHash + at-rest secrets, keeps mfaEnabled/oauthProvider', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(admin);
    const result = await service.getProfile('a1');
    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('mfaSecretEnc');
    expect(result).not.toHaveProperty('githubTokenEnc');
    expect(result.role).toBe(Role.ADMIN);
    expect(result.mfaEnabled).toBe(true);
    expect(result.oauthProvider).toBe('google');
  });

  it('findAll returns only public users (no passwordHash nor at-rest secrets)', async () => {
    mockPrisma.user.findMany.mockResolvedValue([admin, user]);
    const result = await service.findAll();
    expect(result).toHaveLength(2);
    for (const u of result) {
      expect(u).not.toHaveProperty('passwordHash');
      expect(u).not.toHaveProperty('mfaSecretEnc');
      expect(u).not.toHaveProperty('githubTokenEnc');
    }
  });

  it('update throws NotFoundException for an unknown user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(service.update('nope', {}, actorOther)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to demote your own role (self-lock-out guard)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(admin);
    await expect(service.update('a1', { role: Role.USER }, actorSelf)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(mockPrisma.user.count).not.toHaveBeenCalled();
  });

  it('refuses to deactivate the last active admin', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(admin);
    mockPrisma.user.count.mockResolvedValue(1);
    await expect(service.update('a1', { isActive: false }, actorOther)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows demoting another admin when a second active admin exists, and journals it', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(admin);
    mockPrisma.user.count.mockResolvedValue(2);
    mockPrisma.user.update.mockResolvedValue({ ...admin, role: Role.USER });
    await expect(
      service.update('a1', { role: Role.USER }, actorOther),
    ).resolves.toMatchObject({ role: Role.USER });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { role: Role.USER, isActive: true },
    });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.demote', actorId: 'o1', resourceId: 'a1' }),
    );
  });

  it('promotes a user to ADMIN', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(user);
    mockPrisma.user.update.mockResolvedValue({ ...user, role: Role.ADMIN });
    const dto: UpdateUserDto = { role: Role.ADMIN };
    await expect(service.update('u1', dto, actorSelf)).resolves.toMatchObject({ role: Role.ADMIN });
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.promote', actorId: 'a1', resourceId: 'u1' }),
    );
  });

  it('deactivates a regular user (no admin guard applies)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(user);
    mockPrisma.user.update.mockResolvedValue({ ...user, isActive: false });
    await expect(
      service.update('u1', { isActive: false }, actorSelf),
    ).resolves.toMatchObject({ isActive: false });
  });

  // Regression (owner bug report): demoting/deactivating an ALREADY-INACTIVE
  // admin must be allowed — it never removes an active admin, so the "at least
  // one active admin" guard must NOT fire.
  const inactiveAdmin = { ...admin, isActive: false };

  it('allows demoting an already-inactive admin (guard must not fire)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(inactiveAdmin);
    mockPrisma.user.update.mockResolvedValue({ ...inactiveAdmin, role: Role.USER });
    await expect(
      service.update('a1', { role: Role.USER }, actorOther),
    ).resolves.toMatchObject({ role: Role.USER });
    expect(mockPrisma.user.count).not.toHaveBeenCalled();
  });

  it('allows deactivating an already-inactive admin (guard must not fire)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(inactiveAdmin);
    mockPrisma.user.update.mockResolvedValue(inactiveAdmin);
    await expect(
      service.update('a1', { isActive: false }, actorOther),
    ).resolves.toMatchObject({ isActive: false });
    expect(mockPrisma.user.count).not.toHaveBeenCalled();
  });

  describe('findAll with clientProjects (Phase 13)', () => {
    it('includes clientProject for Module B users', async () => {
      const moduleB = {
        id: 'modB',
        kind: 'PER_CLIENT_PROJECT',
        name: 'Module B',
        code: 'B',
      };
      mockPrisma.user.findMany.mockResolvedValue([
        { ...user, clientProjects: [{ id: 'cp1', name: 'client-u1', projectUuid: 'uuid-1', module: moduleB }] },
        { ...admin, clientProjects: [] },
      ]);
      const result = await service.findAll();
      expect(result).toHaveLength(2);
      expect(result[0].clientProject).toEqual({
        id: 'cp1',
        name: 'client-u1',
        projectUuid: 'uuid-1',
      });
      expect(result[1].clientProject).toBeNull();
    });

    it('excludes non-Module B clientProjects', async () => {
      const moduleA = {
        id: 'modA',
        kind: 'SHARED_PROJECT',
        name: 'Module A',
        code: 'A',
      };
      mockPrisma.user.findMany.mockResolvedValue([
        { ...user, clientProjects: [{ id: 'cp1', name: 'client-u1', projectUuid: 'uuid-1', module: moduleA }] },
      ]);
      const result = await service.findAll();
      expect(result[0].clientProject).toBeNull();
    });
  });

  describe('createClientProject (Phase 13)', () => {
    const pack = {
      id: 'pack1',
      ramMb: 1024,
      cpuCores: 1,
      storageLimit: 10,
      status: 'ACTIVE',
      deploymentModule: {
        id: 'modB',
        kind: 'PER_CLIENT_PROJECT',
        name: 'Module B',
        code: 'B',
        perClientPrefix: 'client',
        server: { id: 'srv1', coolifyServerUuid: 'coolify-srv-1' },
      },
    };

    it('throws NotFoundException if user has no active subscription with pack/module', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(user);
      mockPrisma.subscription.findFirst.mockResolvedValue(null);
      await expect(service.createClientProject('u1', actorOther)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ForbiddenException if pack module is not PER_CLIENT_PROJECT', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(user);
      mockPrisma.subscription.findFirst.mockResolvedValue({
        product: { pack: { ...pack, deploymentModule: { ...pack.deploymentModule, kind: 'SHARED_PROJECT' } } },
      });
      await expect(service.createClientProject('u1', actorOther)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws NotFoundException if module has no server', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(user);
      mockPrisma.subscription.findFirst.mockResolvedValue({
        product: { pack: { ...pack, deploymentModule: { ...pack.deploymentModule, server: null } } },
      });
      await expect(service.createClientProject('u1', actorOther)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('calls deployments.getOrCreateClientProject and returns result + audit', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(user);
      mockPrisma.subscription.findFirst.mockResolvedValue({
        product: { pack },
      });
      mockDeployments.getOrCreateClientProject.mockResolvedValue({
        id: 'cp-new',
        projectUuid: 'coolify-project-uuid',
      });

      const result = await service.createClientProject('u1', actorOther);

      expect(result).toEqual({
        id: 'cp-new',
        name: 'client-u1',
        projectUuid: 'coolify-project-uuid',
      });
      expect(mockDeployments.getOrCreateClientProject).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ id: 'srv1' }),
        expect.objectContaining({ id: 'modB' }),
      );
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'clientProject.create',
          actorId: 'o1',
          resourceId: 'cp-new',
        }),
      );
    });
  });

  // ── GO socle (lot A1): self-service profile edit (PATCH /users/me) ─────────
  describe('updateProfile (own account only)', () => {
    it('refuses an empty body before touching the database', async () => {
      await expect(service.updateProfile('u1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('unknown account → NotFoundException', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.updateProfile('ghost', { name: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('updates name + email, strips secrets, audits the changed field names', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(user) // load own account
        .mockResolvedValueOnce(null); // email conflict check: free
      mockPrisma.user.update.mockResolvedValue({
        ...user,
        name: 'Ada L.',
        email: 'ada@example.com',
      });

      const res = await service.updateProfile('u1', { name: '  Ada L.  ', email: 'ada@example.com' });

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { name: 'Ada L.', email: 'ada@example.com' },
      });
      expect(res).not.toHaveProperty('passwordHash');
      expect(res).not.toHaveProperty('mfaSecretEnc');
      expect(res).not.toHaveProperty('githubTokenEnc');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.profile.update',
          actorId: 'u1',
          details: { fields: ['name', 'email'] },
        }),
      );
    });

    it('email already used by ANOTHER account → ConflictException', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce({ id: 'other', email: 'taken@example.com' });
      await expect(
        service.updateProfile('u1', { email: 'taken@example.com' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('blank name clears it (null)', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce(user);
      mockPrisma.user.update.mockResolvedValue({ ...user, name: null });
      const res = await service.updateProfile('u1', { name: '   ' });
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { name: null, email: 'user@example.com' },
      });
      expect(res).not.toHaveProperty('passwordHash');
    });

    it('no-op when values are already identical (no write, no audit)', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce(user);
      const res = await service.updateProfile('u1', { email: 'user@example.com', name: 'User' });
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
      expect(res).toEqual(expect.objectContaining({ id: 'u1' }));
    });
  });
});