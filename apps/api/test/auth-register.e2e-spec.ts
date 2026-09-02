import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role, SubscriptionStatus } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';

// Phase 10 (ADR-027): account creation happens ONLY during an order. A visitor
// browses the PUBLIC catalogue, picks a product → POST /api/checkout/intent
// (httpOnly cookie ihp_checkout) → POST /api/auth/register creates the account
// AND the PENDING subscription atomically. Without the intent, or with the
// admin's selfRegistrationEnabled OFF, registration is 403. GET /api/products
// stays authenticated (non-regression).
describe('Order-time registration (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = Date.now();
  const adminEmail = `regadmin_${stamp}@example.com`;
  const buyerEmail = `buyer_${stamp}@example.com`;
  const buyer2Email = `buyer2_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let productId = '';
  let checkoutCookie = '';

  const setCookies = (res: request.Response): string[] =>
    (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];

  const checkoutCookieFrom = (res: request.Response): string => {
    const raw = setCookies(res).find((c) => c.startsWith('ihp_checkout='));
    if (!raw) throw new Error('ihp_checkout cookie not set');
    return raw.split(';')[0];
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);

    // Clean singleton so all security flags default OFF.
    await prisma.securitySetting.deleteMany({}).catch(() => {});

    await prisma.user.create({
      data: { email: adminEmail, passwordHash: await bcrypt.hash(password, 10), role: Role.ADMIN },
    });
    adminToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: adminEmail, password })
        .expect(201)
    ).body.accessToken as string;

    productId = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/products`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `prod_reg_${stamp}`, kind: 'deployment' })
        .expect(201)
    ).body.id as string;
  });

  afterAll(async () => {
    await prisma.user
      .deleteMany({ where: { email: { in: [adminEmail, buyerEmail, buyer2Email] } } })
      .catch(() => {}); // cascades subscriptions
    await prisma.product.deleteMany({ where: { id: productId } }).catch(() => {});
    await prisma.securitySetting.deleteMany({}).catch(() => {});
    await app.close();
  });

  it('registration without a checkout intent is 403 (self-registration stays closed)', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/register`)
      .send({ email: `closed_${stamp}@example.com`, password, name: 'X' })
      .expect(403);
  });

  it('the catalogue is public (no auth) but /products stays authenticated', async () => {
    const pub = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/public/products`)
      .expect(200);
    expect(pub.body.some((p: { id: string }) => p.id === productId)).toBe(true);

    await request(app.getHttpServer()).get(`/${GlobalPrefix}/products`).expect(401);
  });

  it('a checkout intent sets the httpOnly cookie (unknown product → 404)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/checkout/intent`)
      .send({ productId })
      .expect(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.expiresInSeconds).toBeGreaterThan(0);
    checkoutCookie = checkoutCookieFrom(res);
    expect(checkoutCookie).toContain('ihp_checkout=');

    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/checkout/intent`)
      .send({ productId: 'does-not-exist' })
      .expect(404);
  });

  it('registration with a valid intent but the flag OFF is 403', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/checkout/intent`)
      .send({ productId })
      .expect(201);
    const cookie = checkoutCookieFrom(res);

    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/register`)
      .set('Cookie', cookie)
      .send({ email: `flagoff_${stamp}@example.com`, password, name: 'X' })
      .expect(403);
  });

  it('ADMIN toggles selfRegistrationEnabled (GET reflects it)', async () => {
    const put = await request(app.getHttpServer())
      .put(`/${GlobalPrefix}/admin/security`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ selfRegistrationEnabled: true })
      .expect(200);
    expect(put.body.selfRegistrationEnabled).toBe(true);

    const get = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/admin/security`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(get.body.selfRegistrationEnabled).toBe(true);
  });

  it('register with intent + flag ON → account + PENDING subscription, login works', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/checkout/intent`)
      .send({ productId })
      .expect(201);
    const cookie = checkoutCookieFrom(res);

    const register = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/register`)
      .set('Cookie', cookie)
      .send({ email: buyerEmail, password, name: 'Acheteur' })
      .expect(201);
    expect(register.body.accessToken).toBeTruthy();
    expect(setCookies(register).some((c) => c.startsWith('ihp_refresh='))).toBe(true);

    // The account exists and carries a PENDING subscription to the product.
    const me = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${register.body.accessToken}`)
      .expect(200);
    expect(me.body.email).toBe(buyerEmail);
    expect(me.body.role).toBe(Role.USER);
    const userId = me.body.id as string;
    const sub = await prisma.subscription.findFirst({
      where: { userId, productId },
    });
    expect(sub?.status).toBe(SubscriptionStatus.PENDING);

    // And the new account can log in normally.
    const login = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email: buyerEmail, password })
      .expect(201);
    expect(login.body.accessToken).toBeTruthy();
  });

  it('a second order for the same email is refused (account already exists)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/checkout/intent`)
      .send({ productId })
      .expect(201);
    const cookie = checkoutCookieFrom(res);

    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/register`)
      .set('Cookie', cookie)
      .send({ email: buyerEmail, password, name: 'Encore' })
      .expect(403);
  });
});
