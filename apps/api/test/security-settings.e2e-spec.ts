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
  // État du singleton AVANT la suite : s'il existait, il est restauré à
  // l'identique en afterAll ; s'il n'existait pas, les rows créées par les
  // tests sont supprimées (aucune configuration résiduelle).
  type PriorSettings = {
    turnstileEnabled: boolean;
    turnstileSiteKey: string | null;
    turnstileSecretEnc: string | null;
    oauthGoogleEnabled: boolean;
    oauthGithubEnabled: boolean;
    mfaRequiredForAdmins: boolean;
    selfRegistrationEnabled: boolean;
    deployEnabled: boolean;
    orderStatusRateLimitEnabled: boolean;
    orderStatusRateLimitMax: number;
    orderStatusRateLimitWindowSec: number;
  };
  let priorSettings: PriorSettings | null = null;

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

    // Clean singleton → every flag defaults OFF, APRÈS avoir mémorisé l'état
    // initial (restauré à la fin : aucune config résiduelle laissée derrière).
    const existing = await prisma.securitySetting.findFirst();
    priorSettings = existing
      ? {
          turnstileEnabled: existing.turnstileEnabled,
          turnstileSiteKey: existing.turnstileSiteKey,
          turnstileSecretEnc: existing.turnstileSecretEnc,
          oauthGoogleEnabled: existing.oauthGoogleEnabled,
          oauthGithubEnabled: existing.oauthGithubEnabled,
          mfaRequiredForAdmins: existing.mfaRequiredForAdmins,
          selfRegistrationEnabled: existing.selfRegistrationEnabled,
          deployEnabled: existing.deployEnabled,
          orderStatusRateLimitEnabled: existing.orderStatusRateLimitEnabled,
          orderStatusRateLimitMax: existing.orderStatusRateLimitMax,
          orderStatusRateLimitWindowSec: existing.orderStatusRateLimitWindowSec,
        }
      : null;
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
    // Restauration EXACTE : la row préexistante est recréée telle quelle ;
    // sinon les rows du test sont supprimées (aucune config résiduelle).
    await prisma.securitySetting.deleteMany({}).catch(() => {});
    if (priorSettings) {
      await prisma.securitySetting.create({ data: priorSettings }).catch(() => {});
    }
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

  it('order status rate-limit: 401/403, bornes 400, 200 ADMIN, lecture après mise à jour', async () => {
    const url = `/${GlobalPrefix}/admin/security`;

    // 401 sans authentification, 403 pour un utilisateur non ADMIN.
    await request(app.getHttpServer()).put(url).send({ orderStatusRateLimitMax: 30 }).expect(401);
    await request(app.getHttpServer())
      .put(url)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ orderStatusRateLimitMax: 30 })
      .expect(403);

    try {
      // Bornes : limit 5..1000, fenêtre 10..3600 s (entiers uniquement).
      for (const bad of [
        { orderStatusRateLimitMax: 4 },
        { orderStatusRateLimitMax: 1001 },
        { orderStatusRateLimitMax: 30.5 },
        { orderStatusRateLimitWindowSec: 9 },
        { orderStatusRateLimitWindowSec: 3601 },
        { orderStatusRateLimitWindowSec: 60.5 },
      ]) {
        await request(app.getHttpServer())
          .put(url)
          .set('Authorization', `Bearer ${adminToken}`)
          .send(bad)
          .expect(400);
      }

      // 200 ADMIN + lecture après mise à jour (valeurs persistées).
      const updated = await request(app.getHttpServer())
        .put(url)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ orderStatusRateLimitEnabled: true, orderStatusRateLimitMax: 7, orderStatusRateLimitWindowSec: 120 })
        .expect(200);
      expect(updated.body).toEqual(
        expect.objectContaining({
          orderStatusRateLimitEnabled: true,
          orderStatusRateLimitMax: 7,
          orderStatusRateLimitWindowSec: 120,
        }),
      );
      const read = await request(app.getHttpServer())
        .get(url)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(read.body).toEqual(
        expect.objectContaining({
          orderStatusRateLimitEnabled: true,
          orderStatusRateLimitMax: 7,
          orderStatusRateLimitWindowSec: 120,
        }),
      );

      // Désactivation administrable → enabled=false persisté.
      const disabled = await request(app.getHttpServer())
        .put(url)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ orderStatusRateLimitEnabled: false })
        .expect(200);
      expect(disabled.body.orderStatusRateLimitEnabled).toBe(false);
    } finally {
      // Restauration : le formulaire revient aux valeurs par défaut de la suite.
      await request(app.getHttpServer())
        .put(url)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ orderStatusRateLimitEnabled: true, orderStatusRateLimitMax: 30, orderStatusRateLimitWindowSec: 60 })
        .catch(() => {});
    }
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

  it('Turnstile keys (Phase 11/3): admin saves site+secret, secret is write-only, public config serves the site key', async () => {
    // Site + secret sont stockés ; le secret n'est JAMAIS renvoyé (hasSecretKey).
    // Phase 3: la clé site n'est servie au public QUE si Turnstile est ACTIF
    // (flag admin ET clés présentes) → on active le flag pour valider l'exposition.
    const saved = await request(app.getHttpServer())
      .put(`/${GlobalPrefix}/admin/security`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        turnstileEnabled: true,
        turnstileSiteKey: '0x4AAA_TEST',
        turnstileSecretKey: '1x00000000000000000000_AA',
      })
      .expect(200);
    expect(saved.body.turnstileSiteKey).toBe('0x4AAA_TEST');
    expect(saved.body.turnstileHasSecretKey).toBe(true);
    expect(saved.body).not.toHaveProperty('turnstileSecretKey');
    expect(saved.body).not.toHaveProperty('turnstileSecretEnc');

    // La clé site arrive sur le config public (widget), jamais le secret.
    const pub = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/public/auth-config`)
      .expect(200);
    expect(pub.body.turnstileSiteKey).toBe('0x4AAA_TEST');
    expect(pub.body).not.toHaveProperty('turnstileSecretKey');

    // Phase 3: flag OFF (même avec clés présentes) → Turnstile non annoncé actif.
    await request(app.getHttpServer())
      .put(`/${GlobalPrefix}/admin/security`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ turnstileEnabled: false })
      .expect(200);
    const off = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/public/auth-config`)
      .expect(200);
    expect(off.body.turnstileSiteKey).toBe('');

    // '' efface les deux clés (retour au fallback env). Flag OFF → tests suivants
    // (login sans token, ex. MFA) non gated par Turnstile.
    const cleared = await request(app.getHttpServer())
      .put(`/${GlobalPrefix}/admin/security`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ turnstileEnabled: false, turnstileSiteKey: '', turnstileSecretKey: '' })
      .expect(200);
    expect(cleared.body.turnstileSiteKey).toBeNull();
    expect(cleared.body.turnstileHasSecretKey).toBe(false);
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
