import { ForbiddenException, NotFoundException } from '@nestjs/common';
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
  };
  const mockAudit = { record: jest.fn() };

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
    service = new UsersService(mockPrisma as never, mockAudit as never);
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
});