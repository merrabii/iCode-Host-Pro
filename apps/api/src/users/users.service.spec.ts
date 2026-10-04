import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ClosureRequestStatus, Role } from '@prisma/client';
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
    emailChangeToken: {
      findFirst: jest.fn(),
      deleteMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
    accountClosureRequest: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const mockAudit = { record: jest.fn() };
  const mockDeployments = {
    getOrCreateClientProject: jest.fn(),
  };
  const mockAuth = {
    requestEmailChange: jest.fn(),
    confirmEmailChange: jest.fn(),
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
    service = new UsersService(
      mockPrisma as never,
      mockAudit as never,
      mockDeployments as never,
      mockAuth as never,
    );
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

  // ── GO socle (lot A1) + GO Q3: self-service profile edit (PATCH /users/me) ─
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

    it('GO Q3: name applied immediately, email becomes a PENDING verification (no immediate write)', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(user) // load own account
        .mockResolvedValueOnce(null); // email conflict check: free
      mockPrisma.user.update.mockResolvedValue({ ...user, name: 'Ada L.' });

      const res = await service.updateProfile('u1', { name: '  Ada L.  ', email: 'ada@example.com' });

      // Jamais d'écriture immédiate de User.email : seul le nom change.
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { name: 'Ada L.' },
      });
      expect(mockPrisma.user.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: 'ada@example.com' }) }),
      );
      // La vérification part vers la NOUVELLE adresse.
      expect(mockAuth.requestEmailChange).toHaveBeenCalledWith(
        { id: 'u1', email: 'user@example.com' },
        'ada@example.com',
      );
      expect(res).not.toHaveProperty('passwordHash');
      expect(res).not.toHaveProperty('mfaSecretEnc');
      expect(res).not.toHaveProperty('githubTokenEnc');
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.profile.update',
          actorId: 'u1',
          details: { fields: ['name'] },
        }),
      );
    });

    it('GO Q3: email-only change → pending flow, NO user.write, NO auth.profile.update', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce(null);
      mockAuth.requestEmailChange.mockResolvedValue({ pendingEmail: 'new@example.com', expiresAt: new Date() });

      await service.updateProfile('u1', { email: 'new@example.com' });

      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockAuth.requestEmailChange).toHaveBeenCalledTimes(1);
      expect(mockAudit.record).not.toHaveBeenCalled(); // l'audit est porté par requestEmailChange
    });

    it('email already used by ANOTHER account → ConflictException before any verification mail', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce({ id: 'other', email: 'taken@example.com' });
      await expect(
        service.updateProfile('u1', { email: 'taken@example.com' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockAuth.requestEmailChange).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('blank name clears it (null)', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce(user);
      mockPrisma.user.update.mockResolvedValue({ ...user, name: null });
      const res = await service.updateProfile('u1', { name: '   ' });
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { name: null },
      });
      expect(res).not.toHaveProperty('passwordHash');
    });

    it('no-op when values are already identical (no write, no audit, no verification mail)', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce(user);
      const res = await service.updateProfile('u1', { email: 'user@example.com', name: 'User' });
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
      expect(mockAuth.requestEmailChange).not.toHaveBeenCalled();
      expect(res).toEqual(expect.objectContaining({ id: 'u1' }));
    });

    it('getProfile exposes pendingEmail from the live verification request', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(user);
      mockPrisma.emailChangeToken.findFirst.mockResolvedValue({ newEmail: 'pending@example.com' });
      const res = await service.getProfile('u1');
      expect(res.pendingEmail).toBe('pending@example.com');
    });
  });

  // ── GO Q3: demande de clôture de compte (demander ≠ exécuter) ──────────────
  describe('account closure request', () => {
    const closureRow = {
      id: 'cl1',
      userId: 'u1',
      reason: 'plus besoin',
      status: ClosureRequestStatus.PENDING,
      createdAt: new Date('2026-10-01'),
      updatedAt: new Date('2026-10-01'),
      resolvedAt: null,
      resolvedById: null,
      resolutionNote: null,
    };

    it('getClosureRequest returns null when there is none', async () => {
      mockPrisma.accountClosureRequest.findUnique.mockResolvedValue(null);
      await expect(service.getClosureRequest('u1')).resolves.toBeNull();
    });

    it('requestClosure creates a PENDING row + audits (no financial touch)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(user);
      mockPrisma.accountClosureRequest.findUnique.mockResolvedValue(null);
      mockPrisma.accountClosureRequest.create.mockResolvedValue(closureRow);

      const res = await service.requestClosure('u1', '  plus besoin ');
      expect(res.status).toBe(ClosureRequestStatus.PENDING);
      expect(mockPrisma.accountClosureRequest.create).toHaveBeenCalledWith({
        data: { userId: 'u1', reason: 'plus besoin' },
      });
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'account.closure_requested', resourceId: 'u1' }),
      );
      // Aucune écriture sur User ni sur des entités financières.
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('requestClosure is idempotent on an existing PENDING row', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(user);
      mockPrisma.accountClosureRequest.findUnique.mockResolvedValue(closureRow);
      const res = await service.requestClosure('u1', 'autre motif');
      expect(res).toMatchObject({ id: 'cl1', status: ClosureRequestStatus.PENDING });
      expect(mockPrisma.accountClosureRequest.create).not.toHaveBeenCalled();
      expect(mockPrisma.accountClosureRequest.update).not.toHaveBeenCalled();
      expect(mockAudit.record).not.toHaveBeenCalled();
    });

    it('requestClosure refuses when already COMPLETED (409)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(user);
      mockPrisma.accountClosureRequest.findUnique.mockResolvedValue({
        ...closureRow,
        status: ClosureRequestStatus.COMPLETED,
      });
      await expect(service.requestClosure('u1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('cancelClosureRequest: 404 without a pending row, else CANCELLED + audit', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(user);
      mockPrisma.accountClosureRequest.findUnique.mockResolvedValue(null);
      await expect(service.cancelClosureRequest('u1')).rejects.toBeInstanceOf(NotFoundException);

      mockPrisma.accountClosureRequest.findUnique.mockResolvedValue(closureRow);
      mockPrisma.accountClosureRequest.update.mockResolvedValue({
        ...closureRow,
        status: ClosureRequestStatus.CANCELLED,
        resolvedAt: new Date(),
        resolvedById: 'u1',
      });
      const res = await service.cancelClosureRequest('u1');
      expect(res.status).toBe(ClosureRequestStatus.CANCELLED);
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'account.closure_cancelled' }),
      );
    });

    it('resolveClosureRequest (admin): 404 unknown, 409 already resolved, COMPLETED + audit', async () => {
      mockPrisma.accountClosureRequest.findUnique.mockResolvedValue(null);
      await expect(
        service.resolveClosureRequest('nope', { status: ClosureRequestStatus.COMPLETED }, actorOther),
      ).rejects.toBeInstanceOf(NotFoundException);

      mockPrisma.accountClosureRequest.findUnique.mockResolvedValue({
        ...closureRow,
        status: ClosureRequestStatus.CANCELLED,
        user: { id: 'u1', email: 'user@example.com', name: 'User' },
      });
      await expect(
        service.resolveClosureRequest('cl1', { status: ClosureRequestStatus.COMPLETED }, actorOther),
      ).rejects.toBeInstanceOf(ConflictException);

      mockPrisma.accountClosureRequest.findUnique.mockResolvedValue({
        ...closureRow,
        user: { id: 'u1', email: 'user@example.com', name: 'User' },
      });
      mockPrisma.accountClosureRequest.update.mockResolvedValue({
        ...closureRow,
        status: ClosureRequestStatus.COMPLETED,
        resolvedAt: new Date(),
        resolvedById: 'o1',
      });
      const res = await service.resolveClosureRequest(
        'cl1',
        { status: ClosureRequestStatus.COMPLETED, note: 'traité' },
        actorOther,
      );
      expect(res.status).toBe(ClosureRequestStatus.COMPLETED);
      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'account.closure_resolved', actorId: 'o1' }),
      );
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });
});