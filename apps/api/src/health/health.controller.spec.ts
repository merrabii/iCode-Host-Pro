import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthController', () => {
  let controller: HealthController;
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  it('returns ok when the database is reachable', async () => {
    const res = await controller.check();
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(res.status).toBe('ok');
    expect(res.database).toBe('ok');
    expect(res.timestamp).toEqual(expect.any(String));
  });

  it('returns degraded when the database is unreachable', async () => {
    prisma.$queryRaw.mockRejectedValueOnce(new Error('connection refused'));
    const res = await controller.check();
    expect(res.status).toBe('degraded');
    expect(res.database).toBe('unreachable');
  });
});