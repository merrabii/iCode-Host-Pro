import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';

// Phase 5 (ADR-020): public registration is CLOSED — POST /auth/register is 410
// Gone. New USER accounts arrive only through an ADMIN-issued one-time
// invitation, accepted via POST /auth/accept-invite.
describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = Date.now();
  const adminEmail = `authadmin_${stamp}@example.com`;
  const inviteEmail = `invite_${stamp}@example.com`;
  const wrongEmail = `wrong_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let accessToken = '';
  let inviteTokenRaw = '';
  let wrongTokenRaw = '';

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
        name: 'AuthAdmin',
      },
    });
    adminToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: adminEmail, password })
        .expect(201)
    ).body.accessToken as string;

    // Mint an invitation for the invitee.
    inviteTokenRaw = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/invitations`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: inviteEmail })
        .expect(201)
    ).body.token as string;
    // A second invitation, used only for the wrong-email check.
    wrongTokenRaw = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/invitations`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: wrongEmail })
        .expect(201)
    ).body.token as string;
  });

  afterAll(async () => {
    await prisma.invitation
      .deleteMany({ where: { email: { in: [inviteEmail, wrongEmail] } } })
      .catch(() => {});
    await prisma.user
      .deleteMany({ where: { email: { in: [adminEmail, inviteEmail, wrongEmail] } } })
      .catch(() => {});
    await app.close();
  });

  it('POST /api/auth/register is 410 Gone (registration closed)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/register`)
      .send({ email: `closed_${stamp}@example.com`, password, name: 'X' })
      .expect(410);
    expect(typeof res.body.message).toBe('string');
  });

  it('accept-invite returns an access token', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/accept-invite`)
      .send({ token: inviteTokenRaw, email: inviteEmail, password, name: 'Invited' })
      .expect(201);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.accessToken.length).toBeGreaterThan(20);
    accessToken = res.body.accessToken;
  });

  it('GET /api/users/me works with the token (role USER)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/users/me`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.email).toBe(inviteEmail);
    expect(res.body.role).toBe(Role.USER);
    expect(res.body.passwordHash).toBeUndefined();
  });

  it('GET /api/users/me is denied without a token', async () => {
    await request(app.getHttpServer()).get(`/${GlobalPrefix}/users/me`).expect(401);
  });

  it('login with wrong password is unauthorized', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email: inviteEmail, password: 'wrongpassword!' })
      .expect(401);
  });

  it('login works after the invitation was accepted', async () => {
    const login = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/login`)
      .send({ email: inviteEmail, password })
      .expect(201);
    expect(typeof login.body.accessToken).toBe('string');
  });

  it('the invitation token is ONE-SHOT (second accept is 400)', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/accept-invite`)
      .send({ token: inviteTokenRaw, email: inviteEmail, password })
      .expect(400);
  });

  it('accepting with an email that does not match the invite is 400', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/accept-invite`)
      .send({ token: wrongTokenRaw, email: inviteEmail, password })
      .expect(400);
  });
});
