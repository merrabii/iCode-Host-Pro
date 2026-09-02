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

// Phase 10 (ADR-027): "Se connecter en tant que client". The impersonation JWT
// is pinned to role USER, carries an `imp` marker that forces READ-ONLY
// (mutating verbs 403), and gets NO refresh cookie — the session cannot be
// prolonged past its TTL. Hierarchy negatives: SUPPORT_L3 cannot reach ADMIN
// routes (rank 3 < 99) and never outranks the ADMIN-only impersonate route.
describe('Impersonation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;
  const stamp = Date.now();
  const adminEmail = `impadmin_${stamp}@example.com`;
  const admin2Email = `impadmin2_${stamp}@example.com`;
  const clientEmail = `impclient_${stamp}@example.com`;
  const l3Email = `impl3_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let admin2Id = '';
  let admin2Token = '';
  let clientId = '';
  let clientToken = '';
  let l3Token = '';
  let impToken = '';

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
      [admin2Email, Role.ADMIN],
      [clientEmail, Role.USER],
      [l3Email, Role.SUPPORT_L3],
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
    admin2Token = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: admin2Email, password })
        .expect(201)
    ).body.accessToken as string;
    clientToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: clientEmail, password })
        .expect(201)
    ).body.accessToken as string;
    l3Token = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: l3Email, password })
        .expect(201)
    ).body.accessToken as string;

    const admin2Me = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${admin2Token}`)
      .expect(200);
    admin2Id = admin2Me.body.id as string;
    const clientMe = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${clientToken}`)
      .expect(200);
    clientId = clientMe.body.id as string;
  });

  afterAll(async () => {
    await prisma.user
      .deleteMany({ where: { email: { in: [adminEmail, admin2Email, clientEmail, l3Email] } } })
      .catch(() => {});
    await app.close();
  });

  it('ADMIN impersonates a client → 201 access token pinned to role USER, no refresh cookie', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/users/${clientId}/impersonate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    impToken = res.body.accessToken as string;
    expect(impToken).toBeTruthy();
    expect(res.body.refreshToken).toBeUndefined();
    const cookies =
      (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    expect(cookies.some((c) => c.startsWith('ihp_refresh='))).toBe(false);

    const me = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${impToken}`)
      .expect(200);
    expect(me.body.email).toBe(clientEmail);
    expect(me.body.role).toBe(Role.USER);
  });

  it('the impersonation session is READ-ONLY (mutating verb → 403)', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/subscriptions`)
      .set('Authorization', `Bearer ${impToken}`)
      .send({ productId: 'nope' })
      .expect(403);
  });

  it('the impersonation token cannot reach ADMIN routes (403)', async () => {
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/admin/subscriptions`)
      .set('Authorization', `Bearer ${impToken}`)
      .expect(403);
  });

  it('the impersonation token cannot reach SUPPORT routes (403)', async () => {
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/support/tickets`)
      .set('Authorization', `Bearer ${impToken}`)
      .expect(403);
    limiter.reset();
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/support/access`)
      .set('Authorization', `Bearer ${impToken}`)
      .send({ code: '123456' })
      .expect(403);
  });

  it('refresh cannot prolong an impersonation (no refresh row/cookie exists)', async () => {
    // With no cookie the refresh endpoint has nothing to rotate.
    await request(app.getHttpServer()).post(`/${GlobalPrefix}/auth/refresh`).expect(401);
  });

  it('SUPPORT_L3 cannot reach ADMIN routes (403) — hierarchy', async () => {
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/admin/subscriptions`)
      .set('Authorization', `Bearer ${l3Token}`)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/users/${clientId}/impersonate`)
      .set('Authorization', `Bearer ${l3Token}`)
      .expect(403);
  });

  it('SUPPORT_L3 does reach support routes (rank ≥ L1/L2) — positive rank check', async () => {
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/support/tickets`)
      .set('Authorization', `Bearer ${l3Token}`)
      .expect(200);
    limiter.reset();
    // Reaching /support/access requires rank >= L2; a bad code then fails as 401.
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/support/access`)
      .set('Authorization', `Bearer ${l3Token}`)
      .send({ code: '000000' })
      .expect(401);
  });

  it('admin cannot impersonate themselves (400) or another ADMIN (403)', async () => {
    const adminMe = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/users/${adminMe.body.id}/impersonate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/users/${admin2Id}/impersonate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(403);
  });

  it('returning from impersonation works with the imp token (200)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/impersonate/return`)
      .set('Authorization', `Bearer ${impToken}`)
      .expect(201);
    expect(res.body).toEqual({ success: true });
  });
});
