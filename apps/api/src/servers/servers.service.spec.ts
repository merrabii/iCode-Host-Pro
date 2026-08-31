import { NotFoundException } from '@nestjs/common';
import { ServersService } from './servers.service';

describe('ServersService', () => {
  let service: ServersService;
  const mockPrisma = {
    server: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };

  beforeEach(() => {
    service = new ServersService(mockPrisma as never);
    jest.clearAllMocks();
  });

  it('creates a server with name and hostname', async () => {
    mockPrisma.server.create.mockResolvedValue({ id: '1', name: 'vps-eu', hostname: 'vps1.ihp', status: 'UNKNOWN' });
    await expect(service.create({ name: 'vps-eu', hostname: 'vps1.ihp' })).resolves.toMatchObject({
      hostname: 'vps1.ihp',
    });
    expect(mockPrisma.server.create).toHaveBeenCalledWith({
      data: { name: 'vps-eu', hostname: 'vps1.ihp', status: undefined },
    });
  });

  it('throws NotFoundException on findOne for an unknown id', async () => {
    mockPrisma.server.findUnique.mockResolvedValue(null);
    await expect(service.findOne('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException on update for an unknown id', async () => {
    mockPrisma.server.findUnique.mockResolvedValue(null);
    await expect(service.update('nope', { name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
    expect(mockPrisma.server.update).not.toHaveBeenCalled();
  });

  it('deletes an existing server', async () => {
    mockPrisma.server.findUnique.mockResolvedValue({ id: '1' });
    mockPrisma.server.delete.mockResolvedValue({ id: '1' });
    await expect(service.remove('1')).resolves.toEqual({ id: '1' });
    expect(mockPrisma.server.delete).toHaveBeenCalledWith({ where: { id: '1' } });
  });
});