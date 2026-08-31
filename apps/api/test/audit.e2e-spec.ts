import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';

// Phase 4 (ADR-019): the audit journal is append-only and readable only by
// ADMIN. Writing is emitted by the services (not reachable by clients). Here we
// prove: USER is forbidden, ADMIN can read/filter, and a real admin action
// (promote) produces a visible journal entry.
describe('Audit journal RBAC (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = Date.now();
  const adminEmail = `admin4_${stamp}@example.com`;
  const userEmail = `user4_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let userToken = '';
  let userToPromoteId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);

    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.ADMIN,
        name: 'Admin4',
      },
    });

    // Phase 5 (ADR-020): registration is closed — create the USER directly.
    await prisma.user.create({
      data: {
        email: userEmail,
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.USER,
        name: 'User4',
      },
    });
    userToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: userEmail, password })
        .expect(201)
    ).body.accessToken as string;

    adminToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: adminEmail, password })
        .expect(201)
    ).body.accessToken as string;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [userEmail, adminEmail] } } }).catch(() => {});
    await app.close();
  });

  it('USER cannot read the audit journal (403)', async () => {
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/audit`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);
  });

  it('ADMIN can read the journal: paginated page shape', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/audit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body).toHaveProperty('items');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('page', 1);
    expect(Array.isArray(res.body.items)).toBe(true);
    // The login calls above already produced entries.
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  it('login produced auth journal entries for this user', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/audit?resourceType=user`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const actions = res.body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.login']));
    expect(
      res.body.items.some(
        (e: { action: string; actorEmail?: string | null }) =>
          e.action === 'auth.login' && e.actorEmail === userEmail,
      ),
    ).toBe(true);
  });

  it('an admin promote action is visible and filterable in the journal', async () => {
    // Resolve the user id then promote them (ADMIN mutation).
    const list = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    userToPromoteId = list.body.find(
      (u: { email: string }) => u.email === userEmail,
    )?.id as string;
    expect(userToPromoteId).toBeTruthy();

    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/users/${userToPromoteId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: Role.ADMIN })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/audit?action=user.promote`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(
      res.body.items.some(
        (e: { resourceId: string; actorEmail?: string | null }) =>
          e.resourceId === userToPromoteId && e.actorEmail === adminEmail,
      ),
    ).toBe(true);
  });

  it('ADMIN can paginate the journal', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/audit?perPage=1`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.perPage).toBe(1);
  });
});