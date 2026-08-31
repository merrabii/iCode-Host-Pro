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

  const admin = {
    id: 'a1',
    email: 'admin@example.com',
    name: 'Admin',
    role: Role.ADMIN,
    isActive: true,
    passwordHash: 'secret',
  };
  const user = {
    id: 'u1',
    email: 'user@example.com',
    name: 'User',
    role: Role.USER,
    isActive: true,
    passwordHash: 'secret',
  };

  beforeEach(() => {
    service = new UsersService(mockPrisma as never);
    jest.clearAllMocks();
  });

  it('getProfile strips passwordHash', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(admin);
    const result = await service.getProfile('a1');
    expect(result).not.toHaveProperty('passwordHash');
    expect(result.role).toBe(Role.ADMIN);
  });

  it('findAll returns only public users (no passwordHash)', async () => {
    mockPrisma.user.findMany.mockResolvedValue([admin, user]);
    const result = await service.findAll();
    expect(result).toHaveLength(2);
    for (const u of result) expect(u).not.toHaveProperty('passwordHash');
  });

  it('update throws NotFoundException for an unknown user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(service.update('nope', {}, 'a1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to demote your own role (self-lock-out guard)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(admin);
    await expect(service.update('a1', { role: Role.USER }, 'a1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(mockPrisma.user.count).not.toHaveBeenCalled();
  });

  it('refuses to deactivate the last active admin', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(admin);
    mockPrisma.user.count.mockResolvedValue(1);
    await expect(
      service.update('a1', { isActive: false }, 'other-admin'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows demoting another admin when a second active admin exists', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(admin);
    mockPrisma.user.count.mockResolvedValue(2);
    mockPrisma.user.update.mockResolvedValue({ ...admin, role: Role.USER });
    await expect(
      service.update('a1', { role: Role.USER }, 'other-admin'),
    ).resolves.toMatchObject({ role: Role.USER });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { role: Role.USER, isActive: true },
    });
  });

  it('promotes a user to ADMIN', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(user);
    mockPrisma.user.update.mockResolvedValue({ ...user, role: Role.ADMIN });
    const dto: UpdateUserDto = { role: Role.ADMIN };
    await expect(service.update('u1', dto, 'a1')).resolves.toMatchObject({ role: Role.ADMIN });
  });

  it('deactivates a regular user (no admin guard applies)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(user);
    mockPrisma.user.update.mockResolvedValue({ ...user, isActive: false });
    await expect(
      service.update('u1', { isActive: false }, 'a1'),
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
      service.update('a1', { role: Role.USER }, 'other-admin'),
    ).resolves.toMatchObject({ role: Role.USER });
    expect(mockPrisma.user.count).not.toHaveBeenCalled();
  });

  it('allows deactivating an already-inactive admin (guard must not fire)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(inactiveAdmin);
    mockPrisma.user.update.mockResolvedValue(inactiveAdmin);
    await expect(
      service.update('a1', { isActive: false }, 'other-admin'),
    ).resolves.toMatchObject({ isActive: false });
    expect(mockPrisma.user.count).not.toHaveBeenCalled();
  });
});