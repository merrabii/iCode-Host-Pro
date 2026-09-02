import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { SaRateLimiter } from './../src/auth/rate-limiter';

// Phase 10 (ADR-027): the 6-digit support access code. A client generates one
// (shown once, only the HMAC digest is stored), L2+ redeems it to open a
// READ-ONLY impersonation. Hierarchy negatives: USER and L1 can never redeem.
// Anti-brute-force is the per-IP throttle on /support/access (codes are hashed
// at rest, so a miss cannot be attributed to a specific code → the 5-attempt
// lockout lives in the MFA challenge where the target IS known).
describe('Support access codes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;
  const stamp = Date.now();
  const adminEmail = `supadmin_${stamp}@example.com`;
  const clientEmail = `supclient_${stamp}@example.com`;
  const l2Email = `supl2_${stamp}@example.com`;
  const l1Email = `supl1_${stamp}@example.com`;
  const userBEmail = `supuserb_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let clientToken = '';
  let l2Token = '';
  let l1Token = '';
  let userBToken = '';
  let code = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    limiter = moduleRef.get(SaRateLimiter);

    for (const [email, role] of [
      [adminEmail, Role.ADMIN],
      [clientEmail, Role.USER],
      [l2Email, Role.SUPPORT_L2],
      [l1Email, Role.SUPPORT_L1],
      [userBEmail, Role.USER],
    ] as const) {
      await prisma.user.create({
        data: { email, passwordHash: await bcrypt.hash(password, 10), role },
      });
    }
    adminToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: adminEmail, password })
        .expect(201)
    ).body.accessToken as string;
    clientToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: clientEmail, password })
        .expect(201)
    ).body.accessToken as string;
    l2Token = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: l2Email, password })
        .expect(201)
    ).body.accessToken as string;
    l1Token = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: l1Email, password })
        .expect(201)
    ).body.accessToken as string;
    userBToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: userBEmail, password })
        .expect(201)
    ).body.accessToken as string;
  });

  afterAll(async () => {
    // Deleting users cascades support codes (onDelete: Cascade).
    await prisma.user
      .deleteMany({
        where: { email: { in: [adminEmail, clientEmail, l2Email, l1Email, userBEmail] } },
      })
      .catch(() => {});
    await app.close();
  });

  it('client generates a 6-digit code (shown once) and sees its status', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/support-code`)
      .set('Authorization', `Bearer ${clientToken}`)
      .expect(201);
    expect(res.body.code).toMatch(/^\d{6}$/);
    code = res.body.code as string;
    expect(res.body.expiresAt).toBeTruthy();

    const status = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/support-code`)
      .set('Authorization', `Bearer ${clientToken}`)
      .expect(200);
    expect(status.body).toEqual({ active: true, expiresAt: expect.any(String) });
    // The API never leaks the code back.
    expect(status.body.code).toBeUndefined();
  });

  it('regenerating revokes the previous code (single active per user)', async () => {
    const second = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/support-code`)
      .set('Authorization', `Bearer ${clientToken}`)
      .expect(201);
    const secondCode = second.body.code as string;
    expect(secondCode).toMatch(/^\d{6}$/);

    // The old code is dead.
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/support/access`)
      .set('Authorization', `Bearer ${l2Token}`)
      .send({ code })
      .expect(401);
    code = secondCode;
  });

  it('a USER can never redeem a code (403)', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/support/access`)
      .set('Authorization', `Bearer ${userBToken}`)
      .send({ code: '123456' })
      .expect(403);
  });

  it('a SUPPORT_L1 can never redeem a code (403) — hierarchy', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/support/access`)
      .set('Authorization', `Bearer ${l1Token}`)
      .send({ code: '123456' })
      .expect(403);
  });

  it('L2 redeems the code → read-only impersonation of the client', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/support/access`)
      .set('Authorization', `Bearer ${l2Token}`)
      .send({ code })
      .expect(201);
    const impToken = res.body.accessToken as string;
    expect(impToken).toBeTruthy();

    // The session is the client's profile, pinned to role USER.
    const me = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${impToken}`)
      .expect(200);
    expect(me.body.email).toBe(clientEmail);
    expect(me.body.role).toBe(Role.USER);

    // READ-ONLY: a mutating client route is refused (403).
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/subscriptions`)
      .set('Authorization', `Bearer ${impToken}`)
      .send({ productId: 'nope' })
      .expect(403);
  });

  it('client revokes the code → status inactive, redeem now 401', async () => {
    const revoked = await request(app.getHttpServer())
      .delete(`/${GlobalPrefix}/client/support-code`)
      .set('Authorization', `Bearer ${clientToken}`)
      .expect(200);
    expect(revoked.body).toEqual({ revoked: true });

    const status = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/support-code`)
      .set('Authorization', `Bearer ${clientToken}`)
      .expect(200);
    expect(status.body).toEqual({ active: false, expiresAt: null });

    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/support/access`)
      .set('Authorization', `Bearer ${l2Token}`)
      .send({ code })
      .expect(401);
  });

  it('repeated bad codes hit the per-IP throttle (lockout → 429)', async () => {
    limiter.reset();
    const bad = '000000';
    for (let i = 0; i < 10; i++) {
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/support/access`)
        .set('Authorization', `Bearer ${l2Token}`)
        .send({ code: bad })
        .expect(401);
    }
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/support/access`)
      .set('Authorization', `Bearer ${l2Token}`)
      .send({ code: bad })
      .expect(429);
  });

  it('admin cannot redeem either — impersonation is for support tiers only? no: ADMIN rank passes the guard (401 on bad code)', async () => {
    // ADMIN (rank 99) outranks SUPPORT_L2 (rank 2): the guard admits an admin,
    // but a bad code still fails. This documents the rank semantics.
    limiter.reset();
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/support/access`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: '000000' })
      .expect(401);
  });
});
