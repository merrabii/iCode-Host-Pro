import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';

// Phase 5 (ADR-020): inviting is a privileged ADMIN action. Token lifecycle:
// pending → used/revoked/expired. Acceptance endpoints live under /auth (covered
// by auth.e2e) — here we prove RBAC + admin management + accept-time rejections.
describe('Invitations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = Date.now();
  const adminEmail = `invadmin_${stamp}@example.com`;
  const userEmail = `invuser_${stamp}@example.com`;
  const invitedEmail = `target_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let userToken = '';
  const acceptedInviteEmail = `fresh_${stamp}@example.com`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);

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
    await prisma.invitation.deleteMany({ where: { email: { in: [invitedEmail, acceptedInviteEmail] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } }).catch(() => {});
    await app.close();
  });

  it('is 401 unauthenticated and 403 for a USER', async () => {
    await request(app.getHttpServer()).get(`/${GlobalPrefix}/invitations`).expect(401);
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/invitations`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/invitations`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ email: 'nope@example.com' })
      .expect(403);
  });

  it('ADMIN issues an invitation and gets the raw one-time token', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: invitedEmail })
      .expect(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.email).toBe(invitedEmail);
    expect(typeof res.body.expiresAt).toBe('string');
  });

  it('refuses a duplicate pending invite (409) and an existing-account email (409)', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: invitedEmail })
      .expect(409);
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: userEmail })
      .expect(409);
  });

  it('ADMIN lists invitations with a derived status', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    const mine = res.body.find(
      (i: { email: string }) => i.email === invitedEmail,
    );
    expect(mine).toBeTruthy();
    expect(mine.status).toBe('pending');
  });

  it('an expired invitation shows status expired', async () => {
    const created = await prisma.invitation.findFirst({ where: { email: invitedEmail } });
    await prisma.invitation.update({
      where: { id: created!.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.find((i: { email: string }) => i.email === invitedEmail).status).toBe('expired');
  });

  it('rejects acceptance of a revoked invite (400) and lists it revoked (idempotent revoke)', async () => {
    const reinvite = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: acceptedInviteEmail })
      .expect(201);
    const token = reinvite.body.token as string;
    const id = reinvite.body.id as string;

    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/invitations/${id}/revoke`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    // idempotent second revoke
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/invitations/${id}/revoke`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/accept-invite`)
      .send({ token, email: acceptedInviteEmail, password })
      .expect(400);

    const after = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(after.body.find((i: { id: string }) => i.id === id).status).toBe('revoked');
  });
});
