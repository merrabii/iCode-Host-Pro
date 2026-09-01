import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';

// Phase 2 RBAC (ADR-017): Product read = any authenticated; Product mutation &
// all Server routes = ADMIN only; internal infra never exposed to clients.
describe('Core management RBAC (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = Date.now();
  const userEmail = `user_${stamp}@example.com`;
  const adminEmail = `admin_${stamp}@example.com`;
  const password = 'password123';
  let userToken = '';
  let adminToken = '';
  let createdProductId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);

    // Phase 5 (ADR-020): registration is closed — seed test accounts directly
    // via Prisma, then log in through the real API to mint same-shape tokens.
    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.ADMIN,
        name: 'Admin',
      },
    });
    await prisma.user.create({
      data: {
        email: userEmail,
        passwordHash: await bcrypt.hash(password, 10),
        role: Role.USER,
        name: 'User',
      },
    });

    userToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: userEmail, password })
        .expect(201)
    ).body.accessToken as string;

    adminToken = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email: adminEmail, password })
        .expect(201)
    ).body.accessToken as string;
  });

  afterAll(async () => {
    if (createdProductId) {
      await prisma.product.deleteMany({ where: { id: createdProductId } }).catch(() => {});
    }
    await prisma.user.deleteMany({ where: { email: { in: [userEmail, adminEmail] } } }).catch(() => {});
    await app.close();
  });

  // ---- Unauthenticated: 401 everywhere ----
  it('GET /api/products is 401 without a token', async () => {
    await request(app.getHttpServer()).get(`/${GlobalPrefix}/products`).expect(401);
  });
  it('GET /api/servers is 401 without a token', async () => {
    await request(app.getHttpServer()).get(`/${GlobalPrefix}/servers`).expect(401);
  });

  // ---- USER (client): read products, but no mutations, no servers ----
  it('USER can list products (200)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/products`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
  it('USER cannot create a product (403)', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/products`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'forbidden' })
      .expect(403);
  });
  it('USER cannot list servers (403) — infra hidden from clients', async () => {
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/servers`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);
  });
  it('USER cannot create a server (403)', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'forbidden', hostname: 'x' })
      .expect(403);
  });

  // ---- ADMIN: full CRUD on both ----
  it('ADMIN can create a product (201)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/products`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `prod_${stamp}`, kind: 'deployment' })
      .expect(201);
    expect(res.body.name).toBe(`prod_${stamp}`);
    createdProductId = res.body.id as string;
    expect(createdProductId).toBeTruthy();
  });
  it('ADMIN can list servers (200)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/servers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
  it('ADMIN can create + read + delete a server', async () => {
    const created = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `srv_${stamp}`, hostname: `srv_${stamp}.ihp` })
      .expect(201);
    const id = created.body.id as string;
    await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/servers/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/${GlobalPrefix}/servers/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('ADMIN can store + patch the infra detail fields (ADR-024)', async () => {
    const created = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `srv_dtl_${stamp}`,
        hostname: `node_${stamp}.exemple.com`,
        ipAddress: '198.51.100.7',
        port: 22,
        provider: 'Hetzner',
        region: 'fra1',
        quotaMaxAccounts: 20,
        strictTls: false,
        panelProvider: 'HESTIA',
      })
      .expect(201);
    const body = created.body;
    expect(body).toMatchObject({
      ipAddress: '198.51.100.7',
      port: 22,
      provider: 'Hetzner',
      region: 'fra1',
      quotaMaxAccounts: 20,
      strictTls: false,
      panelProvider: 'HESTIA',
    });
    await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/servers/${body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ panelProvider: 'COOLIFY', port: 2222 })
      .expect(200)
      .expect((r) => {
        expect(r.body.panelProvider).toBe('COOLIFY');
        expect(r.body.port).toBe(2222);
      });
    await request(app.getHttpServer())
      .delete(`/${GlobalPrefix}/servers/${body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });
});