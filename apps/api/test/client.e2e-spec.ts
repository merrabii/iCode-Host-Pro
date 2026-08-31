import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';

// Phase 5 (ADR-021): client workspace. Full loop subscribe → admin approve →
// client requests service → admin assigns server + (stub) provisions → ACTIVE.
// Ownership isolation: A's resources are 404/absent for B. The client never
// reaches /api/admin/* (403) and never sees server details.
describe('Client workspace (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = Date.now();
  const adminEmail = `admin5_${stamp}@example.com`;
  const userA = `clienta_${stamp}@example.com`;
  const userB = `clientb_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let aToken = '';
  let bToken = '';
  let productId = '';
  let serverId = '';
  let subId = '';
  let subBId = '';
  let serviceId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);

    for (const [email, role] of [
      [adminEmail, Role.ADMIN],
      [userA, Role.USER],
      [userB, Role.USER],
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
    aToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: userA, password })
        .expect(201)
    ).body.accessToken as string;
    bToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: userB, password })
        .expect(201)
    ).body.accessToken as string;

    // Platform fixture: one product + one server (ADMIN-managed).
    productId = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/products`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `prod5_${stamp}`, kind: 'deployment' })
        .expect(201)
    ).body.id as string;
    serverId = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/servers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `srv5_${stamp}`, hostname: `srv5_${stamp}.ihp` })
        .expect(201)
    ).body.id as string;
  });

  afterAll(async () => {
    // Deleting users cascades subscriptions then services; product/server
    // remain free (Restrict/SetNull respected).
    await prisma.user
      .deleteMany({ where: { email: { in: [userA, userB, adminEmail] } } })
      .catch(() => {});
    if (productId) await prisma.product.deleteMany({ where: { id: productId } }).catch(() => {});
    if (serverId) await prisma.server.deleteMany({ where: { id: serverId } }).catch(() => {});
    await app.close();
  });

  it('register stays closed (410)', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/auth/register`)
      .send({ email: `x${stamp}@example.com`, password })
      .expect(410);
  });

  it('a USER cannot reach the admin overlay (403)', async () => {
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/admin/subscriptions`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(403);
  });

  it('client can browse the catalogue (products)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/products`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(res.body.some((p: { id: string }) => p.id === productId)).toBe(true);
  });

  it('client subscribes → PENDING, listed in own workspace', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/subscriptions`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ productId })
      .expect(201);
    expect(res.body.status).toBe('PENDING');
    subId = res.body.id as string;
    expect(subId).toBeTruthy();

    const list = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/subscriptions`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(list.body.some((s: { id: string }) => s.id === subId)).toBe(true);
  });

  it('client cannot request a service under a non-ACTIVE subscription (400)', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/services`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ subscriptionId: subId, name: 'Trop tôt' })
      .expect(400);
  });

  it('ADMIN lists all subscriptions and approves → ACTIVE', async () => {
    const list = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/admin/subscriptions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(list.body.some((s: { id: string }) => s.id === subId)).toBe(true);

    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/subscriptions/${subId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ACTIVE' })
      .expect(200);
  });

  it('client requests a service → REQUESTED (no serverId in the DTO path)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/services`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ subscriptionId: subId, name: 'Mon app' })
      .expect(201);
    expect(res.body.status).toBe('REQUESTED');
    expect(res.body.serverId).toBeNull();
    serviceId = res.body.id as string;
  });

  it('ADMIN assigns the server + provisions, then activates (stub)', async () => {
    const provisioned = await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/services/${serviceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'PROVISIONING', serverId })
      .expect(200);
    expect(provisioned.body.status).toBe('PROVISIONING');
    expect(provisioned.body.serverId).toBe(serverId);

    const active = await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/services/${serviceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ACTIVE' })
      .expect(200);
    expect(active.body.status).toBe('ACTIVE');
  });

  it('client sees the service ACTIVE — WITHOUT any server/infra details', async () => {
    const list = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/services`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    const mine = list.body.find((s: { id: string }) => s.id === serviceId);
    expect(mine).toBeTruthy();
    expect(mine.status).toBe('ACTIVE');
    expect(mine).not.toHaveProperty('server');
    expect(mine).not.toHaveProperty('serverId');
  });

  it('ADMIN cannot skip the provisioning step (REQUESTED → ACTIVE is 400)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/services`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ subscriptionId: subId, name: 'Encore' })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/services/${res.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ACTIVE' })
      .expect(400);
  });

  it('cross-client isolation: B never sees A’s resources (404 / absent)', async () => {
    // B's own subscription list does not contain A's subscription.
    const bList = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/subscriptions`)
      .set('Authorization', `Bearer ${bToken}`)
      .expect(200);
    expect(bList.body.some((s: { id: string }) => s.id === subId)).toBe(false);

    // B cannot mutate A's subscription (404, no existence leak).
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/client/subscriptions/${subId}/cancel`)
      .set('Authorization', `Bearer ${bToken}`)
      .expect(404);

    // B cannot see A's service in their own workspace.
    const bServices = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/client/services`)
      .set('Authorization', `Bearer ${bToken}`)
      .expect(200);
    expect(bServices.body.some((s: { id: string }) => s.id === serviceId)).toBe(false);
  });

  it('client cancels their own ACTIVE subscription → CANCELLED; admin approve then 400', async () => {
    const cancelled = await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/client/subscriptions/${subId}/cancel`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');

    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/subscriptions/${subId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ACTIVE' })
      .expect(400);
  });

  it('ADMIN can reject a pending subscription (→ REJECTED), then activate is 400', async () => {
    const created = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/client/subscriptions`)
      .set('Authorization', `Bearer ${bToken}`)
      .send({ productId })
      .expect(201);
    subBId = created.body.id as string;

    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/subscriptions/${subBId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'REJECTED' })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/admin/subscriptions/${subBId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ACTIVE' })
      .expect(400);
  });
});
