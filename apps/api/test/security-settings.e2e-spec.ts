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

// Phase 10 (ADR-027): every security option is NON-mandatory and driven by the
// ADMIN-only singleton flags (defaults all OFF). Toggling a flag applies live:
// OAuth provider on/off, order-time registration on/off, and the admin MFA
// policy (login returns an enrollment token when an ADMIN has no MFA yet).
describe('Security settings (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;
  const stamp = Date.now();
  const adminEmail = `secadmin_${stamp}@example.com`;
  const userEmail = `secuser_${stamp}@example.com`;
  const buyerA = `secbuyer_a_${stamp}@example.com`;
  const buyerB = `secbuyer_b_${stamp}@example.com`;
  const buyerC = `secbuyer_c_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let userToken = '';
  let adminId = '';
  let productId = '';

  const setCookies = (res: request.Response): string[] =>
    (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];

  const checkoutCookieFrom = (res: request.Response): string => {
    const raw = setCookies(res).find((c) => c.startsWith('ihp_checkout='));
    if (!raw) throw new Error('ihp_checkout cookie not set');
    return raw.split(';')[0];
  };

  const intent = async (): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/checkout/intent`)
      .send({ productId })
      .expect(201);
    return checkoutCookieFrom(res);
  };

  beforeAll(async () => {
    // Make the google provider "configured" (flag still OFF → must stay 403).
    process.env.GOOGLE_CLIENT_ID = 'e2e-sec-google-id';
    process.env.GOOGLE_CLIENT_SECRET = 'e2e-sec-google-secret';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    limiter = moduleRef.get(SaRateLimiter);

    // Clean singleton → every flag defaults OFF.
    await prisma.securitySetting.deleteMany({}).catch(() => {});

    await prisma.user.create({
      data: { email: adminEmail, passwordHash: await bcrypt.hash(password, 10), role: Role.ADMIN },
    });
    await prisma.user.create({
      data: { email: userEmail, passwordHash: await bcrypt.hash(password, 10), role: Role.USER },
    });
    adminToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: adminEmail, password })
        .expect(201)
    ).body.accessToken as string;
    userToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: userEmail, password })
        .expect(201)
    ).body.accessToken as string;
    const adminMe = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    adminId = adminMe.body.id as string;

    productId = (
      await prisma.product.create({
        data: { name: `prod_sec_${stamp}`, kind: 'deployment' },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.user
      .deleteMany({
        where: { email: { in: [adminEmail, userEmail, buyerA, buyerB, buyerC] } },
      })
      .catch(() => {});
    await prisma.product.deleteMany({ where: { id: productId } }).catch(() => {});
    await prisma.securitySetting.deleteMany({}).catch(() => {});
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    await app.close();
  });

  it('GET /admin/security: 401 unauth, 403 for a USER, all flags OFF for ADMIN', async () => {
    await request(app.getHttpServer()).get(`/${GlobalPrefix}/admin/security`).expect(401);
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/admin/security`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);

    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/admin/security`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        turnstileEnabled: false,
        oauthGoogleEnabled: false,
        oauthGithubEnabled: false,
        mfaRequiredForAdmins: false,
        selfRegistrationEnabled: false,
        deployEnabled: false,
      }),
    );
  });

  it('the OAuth toggle applies live: on → provider reachable, off → 403', async () => {
    await request(app.getHttpServer())
      .put(`/${GlobalPrefix}/admin/security`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ oauthGoogleEnabled: true })
      .expect(200);

    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/auth/oauth/google`)
      .redirects(0)
      .expect(302);

    await request(app.getHttpServer())
      .put(`/${GlobalPrefix}/admin/security`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ oauthGoogleEnabled: false })
      .expect(200);

    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/auth/oauth/google`)
      .redirects(0)
      .expect(403);
  });

  it('the registration toggle applies live: off → 403, on → 201, off → 403', async () => {
    // OFF by default.
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/register`)
      .set('Cookie', await intent())
      .send({ email: buyerA, password, name: 'A' })
      .expect(403);

    await request(app.getHttpServer())
      .put(`/${GlobalPrefix}/admin/security`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ selfRegistrationEnabled: true })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/register`)
      .set('Cookie', await intent())
      .send({ email: buyerB, password, name: 'B' })
      .expect(201);

    await request(app.getHttpServer())
      .put(`/${GlobalPrefix}/admin/security`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ selfRegistrationEnabled: false })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/register`)
      .set('Cookie', await intent())
      .send({ email: buyerC, password, name: 'C' })
      .expect(403);
  });

  it('mfaRequiredForAdmins: an ADMIN without MFA gets an enrollment token, then must complete the two-step', async () => {
    await request(app.getHttpServer())
      .put(`/${GlobalPrefix}/admin/security`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mfaRequiredForAdmins: true })
      .expect(200);

    limiter.reset();
    const login = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email: adminEmail, password })
      .expect(201);
    expect(login.body).toEqual(
      expect.objectContaining({ mfaRequired: false, enroll: true }),
    );
    expect(login.body.accessToken).toBeUndefined();
    const enrollToken = login.body.enrollToken as string;
    expect(enrollToken).toBeTruthy();

    // The enrollment token may ONLY touch the MFA setup/confirm endpoints.
    const setup = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/mfa/setup`)
      .set('Authorization', `Bearer ${enrollToken}`)
      .send({ password })
      .expect(201);
    expect(setup.body.secret).toBeTruthy();
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/mfa/confirm`)
      .set('Authorization', `Bearer ${enrollToken}`)
      .send({ code: '123456' })
      .expect(201);

    // Now login demands the second step.
    limiter.reset();
    const second = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email: adminEmail, password })
      .expect(201);
    expect(second.body.mfaRequired).toBe(true);
    const verify = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/mfa/verify`)
      .send({ challengeId: second.body.challengeId, code: '123456', method: 'totp' })
      .expect(201);
    expect(verify.body.accessToken).toBeTruthy();

    // Cleanup: ADMIN recovery resets the admin's MFA, flag back OFF.
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/users/${adminId}/mfa-reset`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    await request(app.getHttpServer())
      .put(`/${GlobalPrefix}/admin/security`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mfaRequiredForAdmins: false })
      .expect(200);

    const me = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(me.body.mfaEnabled).toBe(false);
  });
});
