import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { MailTransportFactory } from './../src/mail/mail-transport.factory';
import { GlobalPrefix } from './../src/config/constants';

// Phase 6 (ADR-022): SMTP configuration is ADMIN-only; the password is stored
// AES-256-GCM at rest and NEVER echoed (hasPassword only). The test endpoint
// surfaces the real SMTP error as a 400. MailTransportFactory is overridden
// with a stub — NO real SMTP server is ever contacted.
describe('Mail settings (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const transportStub = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const factoryStub = { create: jest.fn().mockReturnValue(transportStub) };

  const stamp = Date.now();
  const adminEmail = `mailadmin_${stamp}@example.com`;
  const userEmail = `mailuser_${stamp}@example.com`;
  const invitedEmail = `mailtarget_${stamp}@example.com`;
  const invitedEmail2 = `mailtarget2_${stamp}@example.com`;
  const testRecipient = `mailme_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let userToken = '';

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

    // Start from a clean singleton row
    await prisma.mailSetting.deleteMany({}).catch(() => {});

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
  });

  afterAll(async () => {
    await prisma.invitation
      .deleteMany({ where: { email: { in: [invitedEmail, invitedEmail2] } } })
      .catch(() => {});
    await prisma.mailSetting.deleteMany({}).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } }).catch(() => {});
    await app.close();
  });

  it('is 401 unauthenticated and 403 for a USER (GET/PUT/test)', async () => {
    await request(app.getHttpServer()).get(`/${GlobalPrefix}/admin/mail`).expect(401);
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/admin/mail`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .put(`/${GlobalPrefix}/admin/mail`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ host: 'x' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/admin/mail/test`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ to: 'a@b.com' })
      .expect(403);
  });

  it('GET returns masked defaults when no configuration exists', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/admin/mail`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body).toMatchObject({ enabled: false, host: null, port: 587, hasPassword: false });
    expect(res.body).not.toHaveProperty('passwordEnc');
  });

  it('ADMIN saves the SMTP config (password encrypted, never echoed back)', async () => {
    const res = await request(app.getHttpServer())
      .put(`/${GlobalPrefix}/admin/mail`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        enabled: true,
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'smtp-user',
        password: 'smtp-password-secret',
        fromEmail: 'no-reply@example.com',
        fromName: 'iCode Host Pro',
      })
      .expect(200);
    expect(res.body.host).toBe('smtp.example.com');
    expect(res.body.enabled).toBe(true);
    expect(res.body.hasPassword).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('smtp-password-secret');

    const row = await prisma.mailSetting.findFirst();
    expect(row).toBeTruthy();
    expect(row!.passwordEnc).toBeTruthy();
    expect(row!.passwordEnc).not.toContain('smtp-password-secret');
  });

  it('GET is masked: hasPassword true but the raw password never appears', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/admin/mail`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.hasPassword).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('smtp-password-secret');
    expect(JSON.stringify(res.body)).not.toContain('passwordEnc');
  });

  it('refuses to enable mail without host+fromEmail (400)', async () => {
    await prisma.mailSetting.deleteMany({});
    const res = await request(app.getHttpServer())
      .put(`/${GlobalPrefix}/admin/mail`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('host');
    // restore a working config for the rest of the suite
    await request(app.getHttpServer())
      .put(`/${GlobalPrefix}/admin/mail`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        enabled: true,
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'smtp-user',
        password: 'smtp-password-secret',
        fromEmail: 'no-reply@example.com',
      })
      .expect(200);
  });

  it('test endpoint succeeds through the saved config and journals mail.test', async () => {
    transportStub.sendMail.mockClear();
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/admin/mail/test`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ to: testRecipient })
      .expect(201);
    expect(res.body.ok).toBe(true);
    expect(transportStub.sendMail).toHaveBeenCalled();
    const audit = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/audit?action=mail.test`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(audit.body.items.some((a: { details: { ok?: boolean } }) => a.details?.ok === true)).toBe(true);
  });

  it('test endpoint surfaces the SMTP error as a 400', async () => {
    transportStub.sendMail.mockRejectedValueOnce(
      new Error('535 5.7.8 Username and Password not accepted'),
    );
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/admin/mail/test`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ to: testRecipient })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('535 5.7.8');
    const audit = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/audit?action=mail.test`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(
      audit.body.items.some((a: { details: { ok?: boolean; error?: string } }) => a.details?.ok === false),
    ).toBe(true);
  });

  it('invitation creation sends the email when mail is enabled → emailSent true', async () => {
    transportStub.sendMail.mockClear();
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: invitedEmail })
      .expect(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.emailSent).toBe(true);
    expect(transportStub.sendMail).toHaveBeenCalled();

    const audit = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/audit?action=invite.email`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(
      audit.body.items.some(
        (a: { details: { email?: string; emailSent?: boolean } }) =>
          a.details?.email === invitedEmail && a.details?.emailSent === true,
      ),
    ).toBe(true);
  });

  it('invitation creation does NOT email when mail is disabled → emailSent false', async () => {
    await request(app.getHttpServer())
      .put(`/${GlobalPrefix}/admin/mail`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: false })
      .expect(200);
    transportStub.sendMail.mockClear();
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: invitedEmail2 })
      .expect(201);
    expect(res.body.emailSent).toBe(false);
    expect(res.body.token).toBeTruthy(); // manual fallback still returned
    expect(transportStub.sendMail).not.toHaveBeenCalled();
  });

  it('journals mail.settings.update (masked) in the audit journal', async () => {
    const audit = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/audit?action=mail.settings.update`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(audit.body.items.length).toBeGreaterThan(0);
    for (const item of audit.body.items) {
      expect(JSON.stringify(item.details)).not.toContain('password');
    }
  });
});
