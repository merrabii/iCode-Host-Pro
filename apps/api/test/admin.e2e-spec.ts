import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';

// Phase 3 (admin management + /manager dashboard).
// Listing users, mutating role/active state and the /manager summary are ADMIN
// only. Guards against self-lock-out (cannot demote/deactivate yourself).
describe('Admin management RBAC (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = Date.now();
  const adminEmail = `admin3_${stamp}@example.com`;
  const userEmail = `user3_${stamp}@example.com`;
  const inactiveAdminEmail = `inactive3_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let userToken = '';
  let adminId = '';
  let userToPromoteId = '';
  let inactiveAdminId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);

    // Direct ADMIN (register only creates USER by design).
    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.ADMIN,
        name: 'Admin3',
      },
    });

    // An ALREADY-INACTIVE admin (regression: demoting/deactivating it must be
    // allowed — it never reduces the active-admin pool).
    const inactiveAdmin = await prisma.user.create({
      data: {
        email: inactiveAdminEmail,
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.ADMIN,
        isActive: false,
        name: 'Inactive3',
      },
    });
    inactiveAdminId = inactiveAdmin.id;

    userToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/register`)
        .send({ email: userEmail, password, name: 'User3' })
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
    await prisma.user
      .deleteMany({ where: { email: { in: [userEmail, adminEmail, inactiveAdminEmail] } } })
      .catch(() => {});
    await app.close();
  });

  // ---- USER (regular client): all admin routes forbidden ----
  it('USER cannot list users (403)', async () => {
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);
  });
  it('USER cannot update a user (403)', async () => {
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/users/some-id`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ role: Role.ADMIN })
      .expect(403);
  });
  it('USER cannot reach /manager/summary (403)', async () => {
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/manager/summary`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);
  });

  // ---- ADMIN: list + summary ----
  it('ADMIN can list users (200), public shape, ids resolved', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const u of res.body) expect(u).not.toHaveProperty('passwordHash');
    adminId = res.body.find((u: { email: string }) => u.email === adminEmail)?.id as string;
    userToPromoteId = res.body.find((u: { email: string }) => u.email === userEmail)?.id as string;
    expect(adminId).toBeTruthy();
    expect(userToPromoteId).toBeTruthy();
  });

  it('ADMIN can open /manager/summary (200) with dashboard shape', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/manager/summary`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.products).toHaveProperty('total');
    expect(res.body.servers).toHaveProperty('total');
    expect(res.body.users).toHaveProperty('active');
    expect(res.body.users.byRole).toHaveProperty(Role.ADMIN);
  });

  // ---- ADMIN: role management + validation ----
  it('ADMIN can promote a USER to ADMIN, then demote back', async () => {
    const promote = await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/users/${userToPromoteId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: Role.ADMIN })
      .expect(200);
    expect(promote.body.role).toBe(Role.ADMIN);

    const demote = await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/users/${userToPromoteId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: Role.USER })
      .expect(200);
    expect(demote.body.role).toBe(Role.USER);
  });

  it('ADMIN cannot demote their own account (403, self-lock-out guard)', async () => {
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/users/${adminId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: Role.USER })
      .expect(403);
  });

  it('rejects an invalid role value (400)', async () => {
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/users/${userToPromoteId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'SUPERUSER' })
      .expect(400);
  });

  // Regression (owner bug report): an ALREADY-INACTIVE admin can always be
  // demoted — the lock-out guard must not fire, active-admin count stays 1.
  it('ADMIN can demote an already-inactive admin (200, no lock-out guard)', async () => {
    const demote = await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/users/${inactiveAdminId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: Role.USER })
      .expect(200);
    expect(demote.body.role).toBe(Role.USER);
  });
});