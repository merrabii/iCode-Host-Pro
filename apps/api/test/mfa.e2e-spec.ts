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
import { MailTransportFactory } from './../src/mail/mail-transport.factory';

// Phase 10 (ADR-027): MFA self-service + the two-step login. TOTP math is
// stubbed in Jest (otplib stub accepts any 6-digit code — see
// src/test-utils/otplib.stub.ts), so the "wrong code / lockout" paths are
// exercised through the EMAIL OTP method, which uses a real timing-safe
// sha256 comparison of the emailed code. MailTransportFactory is overridden so
// no real SMTP server is ever contacted; a MailSetting row with host+fromEmail
// makes canSend() true so the email method is offered.
describe('MFA (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let limiter: SaRateLimiter;
  const transportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const factoryStub = { create: jest.fn().mockReturnValue(transportStub) };
  const stamp = Date.now();
  const userEmail = `mfauser_${stamp}@example.com`;
  const password = 'password123';
  let userToken = '';
  let challengeId = '';
  let challengeEmail = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransportFactory)
      .useValue(factoryStub)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    limiter = moduleRef.get(SaRateLimiter);

    // Start from a clean singleton mail row so canSend() → email method offered.
    await prisma.mailSetting.deleteMany({}).catch(() => {});
    await prisma.mailSetting.create({
      data: { enabled: false, host: 'smtp.example.test', port: 587, fromEmail: 'noreply@example.test' },
    });

    await prisma.user.create({
      data: { email: userEmail, passwordHash: await bcrypt.hash(password, 10), role: Role.USER },
    });
    userToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: userEmail, password })
        .expect(201)
    ).body.accessToken as string;
  });

  afterAll(async () => {
    await prisma.mailSetting.deleteMany({}).catch(() => {});
    await prisma.user.deleteMany({ where: { email: userEmail } }).catch(() => {});
    await app.close();
  });

  it('self-service TOTP enrollment: setup (secret+uri, password re-checked) → confirm', async () => {
    const setup = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/mfa/setup`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ password })
      .expect(201);
    expect(setup.body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.body.uri).toContain('otpauth://totp/');

    const confirm = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/mfa/confirm`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ code: '123456' })
      .expect(201);
    expect(confirm.body).toEqual({ mfaEnabled: true });

    // The API never exposes the secret.
    const me = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    expect(me.body.mfaEnabled).toBe(true);
    expect(me.body.mfaSecretEnc).toBeUndefined();
  });

  it('login now requires the two-step (no tokens, challenge with methods)', async () => {
    limiter.reset();
    const login = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email: userEmail, password })
      .expect(201);
    expect(login.body.mfaRequired).toBe(true);
    expect(login.body.accessToken).toBeUndefined();
    expect(login.body.challengeId).toBeTruthy();
    expect(login.body.methods).toEqual(expect.arrayContaining(['totp', 'email']));
    challengeId = login.body.challengeId as string;
  });

  it('completes login with a TOTP code → access token works', async () => {
    limiter.reset();
    const verify = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/mfa/verify`)
      .send({ challengeId, code: '123456', method: 'totp' })
      .expect(201);
    expect(verify.body.accessToken).toBeTruthy();

    const me = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${verify.body.accessToken}`)
      .expect(200);
    expect(me.body.email).toBe(userEmail);
  });

  it('a wrong EMAIL OTP is refused (401)', async () => {
    limiter.reset();
    const login = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email: userEmail, password })
      .expect(201);
    challengeEmail = login.body.challengeId as string;

    const sent = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/mfa/email/send`)
      .send({ challengeId: challengeEmail })
      .expect(201);
    expect(sent.body.sent).toBe(true);

    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/mfa/verify`)
      .send({ challengeId: challengeEmail, code: '000000', method: 'email' })
      .expect(401);
  });

  it('5 wrong attempts lock the challenge out (destroyed)', async () => {
    limiter.reset();
    for (let i = 0; i < 4; i++) {
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/mfa/verify`)
        .send({ challengeId: challengeEmail, code: '000000', method: 'email' })
        .expect(401);
    }
    // 5th wrong attempt: the challenge is consumed.
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/mfa/verify`)
      .send({ challengeId: challengeEmail, code: '000000', method: 'email' })
      .expect(401);

    // The challenge no longer exists — even asking for an email OTP on it fails.
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/mfa/email/send`)
      .send({ challengeId: challengeEmail })
      .expect(401);
  });

  it('self-service disable (password + TOTP) → login is single-step again', async () => {
    limiter.reset();
    const disable = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/mfa/disable`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ password, code: '123456' })
      .expect(201);
    expect(disable.body).toEqual({ mfaEnabled: false });

    const login = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email: userEmail, password })
      .expect(201);
    expect(login.body.accessToken).toBeTruthy();
  });
});
