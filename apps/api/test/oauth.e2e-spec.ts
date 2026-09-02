import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role, SubscriptionStatus } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import {
  GOOGLE_OAUTH,
  OAuthProviderClient,
} from './../src/auth/oauth/oauth-provider.client';

// Phase 10 (ADR-027): OAuth Google — the provider client is mocked (no network).
// Scenarios resolved on the callback: LOGIN (existing account), order-time
// REGISTER (only with a valid ihp_checkout cookie), LINK (authenticated attach
// to the current account). CSRF state is a signed httpOnly cookie compared
// timing-safe against the query param; the redirect_uri is the PUBLIC base URL
// (never :3001).
describe('OAuth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const stamp = Date.now();
  const googleId = 'e2e-google-id';
  const googleSecret = 'e2e-google-secret';
  const existingEmail = `oauthuser_${stamp}@example.com`;
  const linkUserEmail = `oauthlink_${stamp}@example.com`;
  const conflictUserEmail = `oauthconflict_${stamp}@example.com`;
  const socialEmail = `social_${stamp}@example.com`;
  const registerEmail = `oauthbuyer_${stamp}@example.com`;
  const password = 'password123';
  let productId = '';
  let linkUserToken = '';
  let conflictUserToken = '';

  const getAuthorizeUrl = jest.fn();
  const exchangeCode = jest.fn();
  const googleMock: OAuthProviderClient = {
    kind: 'google',
    getAuthorizeUrl: (input) => {
      getAuthorizeUrl(input);
      return 'https://accounts.google.com/o/oauth2/v2/auth?mock=1';
    },
    exchangeCode: (input) => exchangeCode(input),
  };

  const setCookies = (res: request.Response): string[] =>
    (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];

  const checkoutCookieFrom = (res: request.Response): string => {
    const raw = setCookies(res).find((c) => c.startsWith('ihp_checkout='));
    if (!raw) throw new Error('ihp_checkout cookie not set');
    return raw.split(';')[0];
  };

  const stateCookie = async (
    state: string,
    mode: 'login' | 'link',
    sub?: string,
  ): Promise<string> => {
    const token = await jwt.signAsync({ state, mode, sub }, { expiresIn: 600 });
    return `ihp_oauth_state=${token}`;
  };

  beforeAll(async () => {
    // Make the google provider "configured" before the config module loads.
    process.env.GOOGLE_CLIENT_ID = googleId;
    process.env.GOOGLE_CLIENT_SECRET = googleSecret;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GOOGLE_OAUTH)
      .useValue(googleMock)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);

    // Clean singleton + seed: google enabled + self-registration at order time.
    await prisma.securitySetting.deleteMany({}).catch(() => {});
    await prisma.securitySetting.create({
      data: {
        oauthGoogleEnabled: true,
        selfRegistrationEnabled: true,
      },
    });

    for (const email of [existingEmail, linkUserEmail, conflictUserEmail]) {
      await prisma.user.create({
        data: { email, passwordHash: await bcrypt.hash(password, 10), role: Role.USER },
      });
    }
    linkUserToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: linkUserEmail, password })
        .expect(201)
    ).body.accessToken as string;
    conflictUserToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: conflictUserEmail, password })
        .expect(201)
    ).body.accessToken as string;

    productId = (
      await prisma.product.create({
        data: { name: `prod_oauth_${stamp}`, kind: 'deployment' },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.user
      .deleteMany({
        where: { email: { in: [existingEmail, linkUserEmail, conflictUserEmail, registerEmail, socialEmail] } },
      })
      .catch(() => {}); // cascades subscriptions
    await prisma.product.deleteMany({ where: { id: productId } }).catch(() => {});
    await prisma.securitySetting.deleteMany({}).catch(() => {});
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    await app.close();
  });

  it('authorize redirects to the provider with the PUBLIC redirect_uri (never :3001)', async () => {
    getAuthorizeUrl.mockClear();
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/auth/oauth/google`)
      .redirects(0)
      .expect(302);
    expect(res.headers.location).toContain('accounts.google.com');
    expect(setCookies(res).some((c) => c.startsWith('ihp_oauth_state='))).toBe(true);

    const input = getAuthorizeUrl.mock.calls[0][0] as {
      redirectUri: string;
      state: string;
      scope: string;
    };
    expect(input.redirectUri).toBe('http://localhost:3000/api/auth/oauth/google/callback');
    expect(input.redirectUri).not.toContain(':3001');
    expect(input.scope).toContain('openid email profile');
  });

  it('a provider that is not admin-enabled is refused (403)', async () => {
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/auth/oauth/github`)
      .redirects(0)
      .expect(403);
  });

  it('a CSRF state mismatch is refused (redirect to error)', async () => {
    exchangeCode.mockResolvedValue({
      email: existingEmail,
      emailVerified: true,
      accessToken: 'tok',
    });
    const cookie = await stateCookie('expected-state', 'login');
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/auth/oauth/google/callback?code=mock&state=other-state`)
      .set('Cookie', cookie)
      .redirects(0)
      .expect(302);
    expect(res.headers.location).toContain('error=oauth_state_mismatch');
  });

  it('login: an existing account signs in (302 /client?oauth=ok + refresh cookie)', async () => {
    const state = 'login-state';
    const cookie = await stateCookie(state, 'login');
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/auth/oauth/google/callback?code=mock&state=${state}`)
      .set('Cookie', cookie)
      .redirects(0)
      .expect(302);
    expect(res.headers.location).toBe('http://localhost:3000/client?oauth=ok');
    expect(setCookies(res).some((c) => c.startsWith('ihp_refresh='))).toBe(true);
  });

  it('an unknown email WITHOUT a checkout intent is refused (no auto-creation)', async () => {
    exchangeCode.mockResolvedValue({
      email: `ghost_${stamp}@example.com`,
      emailVerified: true,
      accessToken: 'tok-ghost',
    });
    const state = 'ghost-state';
    const cookie = await stateCookie(state, 'login');
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/auth/oauth/google/callback?code=mock&state=${state}`)
      .set('Cookie', cookie)
      .redirects(0)
      .expect(302);
    expect(res.headers.location).toContain('error=oauth_unknown_account');
  });

  it('order-time REGISTER: unknown email + valid checkout intent creates account + PENDING subscription', async () => {
    exchangeCode.mockResolvedValue({
      email: registerEmail,
      emailVerified: true,
      accessToken: 'tok-register',
    });
    const intentRes = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/checkout/intent`)
      .send({ productId })
      .expect(201);
    const checkout = checkoutCookieFrom(intentRes);

    const state = 'register-state';
    const cookie = `${await stateCookie(state, 'login')}; ${checkout}`;
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/auth/oauth/google/callback?code=mock&state=${state}`)
      .set('Cookie', cookie)
      .redirects(0)
      .expect(302);
    expect(res.headers.location).toBe('http://localhost:3000/client?registered=google');

    // The refresh cookie lets us obtain an access token for the new account.
    const refreshRaw = setCookies(res).find((c) => c.startsWith('ihp_refresh='));
    expect(refreshRaw).toBeTruthy();
    const refresh = (refreshRaw as string).split(';')[0];
    const refreshed = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/refresh`)
      .set('Cookie', refresh)
      .expect(201);
    const me = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
      .expect(200);
    expect(me.body.email).toBe(registerEmail);
    expect(me.body.oauthProvider).toBe('google');
    const sub = await prisma.subscription.findFirst({
      where: { userId: me.body.id, productId },
    });
    expect(sub?.status).toBe(SubscriptionStatus.PENDING);
  });

  it('link: an authenticated user attaches a Google identity (302 /profil?linked=google)', async () => {
    const authorize = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/auth/oauth/link/google`)
      .set('Authorization', `Bearer ${linkUserToken}`)
      .redirects(0)
      .expect(302);
    // The authorize response's own state cookie already carries mode=link + sub.
    const cookie = setCookies(authorize).find((c) => c.startsWith('ihp_oauth_state=')) as string;
    const state = getAuthorizeUrl.mock.calls[getAuthorizeUrl.mock.calls.length - 1][0]
      .state as string;

    exchangeCode.mockResolvedValue({
      email: socialEmail,
      emailVerified: true,
      accessToken: 'tok-link',
    });
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/auth/oauth/google/callback?code=mock&state=${state}`)
      .set('Cookie', cookie)
      .redirects(0)
      .expect(302);
    expect(res.headers.location).toBe('http://localhost:3000/profil?linked=google');

    const linked = await prisma.user.findUnique({ where: { email: linkUserEmail } });
    expect(linked?.oauthProvider).toBe('google');
    expect(linked?.oauthSubject).toBe(socialEmail);
  });

  it('link conflict: the same identity already attached to another account → /profil?link=conflict', async () => {
    const authorize = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/auth/oauth/link/google`)
      .set('Authorization', `Bearer ${conflictUserToken}`)
      .redirects(0)
      .expect(302);
    const cookie = setCookies(authorize).find((c) => c.startsWith('ihp_oauth_state=')) as string;
    const state = getAuthorizeUrl.mock.calls[getAuthorizeUrl.mock.calls.length - 1][0]
      .state as string;

    exchangeCode.mockResolvedValue({
      email: socialEmail, // already linked to linkUser
      emailVerified: true,
      accessToken: 'tok-conflict',
    });
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/auth/oauth/google/callback?code=mock&state=${state}`)
      .set('Cookie', cookie)
      .redirects(0)
      .expect(302);
    expect(res.headers.location).toBe('http://localhost:3000/profil?link=conflict');
  });

  it('unlink: self-service detach removes the provider identity', async () => {
    const unlinked = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/oauth/unlink`)
      .set('Authorization', `Bearer ${linkUserToken}`)
      .send({ provider: 'google' })
      .expect(201);
    expect(unlinked.body).toEqual({ unlinked: true });

    const updated = await prisma.user.findUnique({ where: { email: linkUserEmail } });
    expect(updated?.oauthProvider).toBeNull();

    // Second call: nothing left to detach → no-op 200.
    const again = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/oauth/unlink`)
      .set('Authorization', `Bearer ${linkUserToken}`)
      .send({ provider: 'google' })
      .expect(201);
    expect(again.body).toEqual({ unlinked: false });
  });
});
