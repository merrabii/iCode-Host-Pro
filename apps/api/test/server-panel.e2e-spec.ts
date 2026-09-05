import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import {
  PanelTransportFactory,
  PanelTransport,
} from './../src/servers/panel-transport.factory';
import { HostResolverFactory } from './../src/servers/host-resolver.factory';

// Phase 9 (ADR-010): vérification de l'API du panneau serveur
// POST /api/servers/:id/panel-verify + credentials chiffrées au repos.
// Comme ProbeTransportFactory (Phase 8), la factory est overridée en e2e → AUCUN
// réseau réel n'est contacté. Le CryptoService, lui, est le VRAI (chiffrement
// AES-256-GCM au repos via ENCRYPTION_KEY) — on couvre ainsi le cycle complet.
describe('Server panel verify (e2e, Phase 9)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = Date.now();
  const name = `srv_panel_${stamp}`;
  const adminEmail = `admin_panel_${stamp}@example.com`;
  const userEmail = `user_panel_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let userToken = '';

  // Couture : transport factice dont `verify` est reconfiguré test par test.
  // Phase 10bis : les 3 opérations de déploiement sont fournies (jamais appelées
  // par cette suite — seules verify l'est), l'objet reste conforme au contrat.
  const fakeVerify = jest.fn().mockResolvedValue({ ok: true, detail: 'FAKE PANEL OK' });
  const fakeFactory: PanelTransportFactory = {
    create: (): PanelTransport => ({
      verify: fakeVerify as unknown as PanelTransport['verify'],
      createGitApp: jest.fn(),
      deployApp: jest.fn(),
      applyAppLimits: jest.fn(),
      deploymentStatus: jest.fn(),
    }),
  } as unknown as PanelTransportFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PanelTransportFactory)
      .useValue(fakeFactory)
      .overrideProvider(HostResolverFactory)
      .useValue({ create: () => ({ resolveIp: () => Promise.resolve(null) }) })
      .compile();
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
        name: 'Admin',
      },
    });
    await prisma.user.create({
      data: { email: userEmail, passwordHash: await bcrypt.hash(password, 10), role: Role.USER, name: 'User' },
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
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } }).catch(() => {});
    await app.close();
  });

  it('401 without a token', async () => {
    await request(app.getHttpServer()).post(`/${GlobalPrefix}/servers/whatever/panel-verify`).expect(401);
  });

  it('403 for a USER (infra is ADMIN-only)', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers/whatever/panel-verify`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);
  });

  it('404 for an unknown server id (no verify)', async () => {
    fakeVerify.mockClear();
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers/nope_${stamp}/panel-verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
    expect(fakeVerify).not.toHaveBeenCalled();
  });

  it('create with an API token: hasApiToken=true, token never exposed', async () => {
    const created = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name,
        hostname: 'panel1.exemple.com',
        panelProvider: 'COOLIFY',
        apiBaseUrl: 'https://panel.exemple.com/api/v1',
        apiToken: 'secret-token-raw',
        apiUser: 'api',
      })
      .expect(201);

    expect(created.body.hasApiToken).toBe(true);
    expect(created.body).not.toHaveProperty('apiTokenEnc');
    expect(created.body.panelProvider).toBe('COOLIFY');
    expect(created.body.apiBaseUrl).toBe('https://panel.exemple.com/api/v1');
    expect(created.body.apiUser).toBe('api');
    expect(created.body.panelOk).toBeNull();
  });

  it('GET list exposes hasApiToken but never the token, on every view', async () => {
    const list = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/servers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const row = (list.body as Array<Record<string, unknown>>).find((s) => s.name === name);
    expect(row).toBeTruthy();
    expect(row?.hasApiToken).toBe(true);
    expect(row).not.toHaveProperty('apiTokenEnc');
    const single = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/servers/${(row as { id: string }).id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(single.body.hasApiToken).toBe(true);
    expect(single.body).not.toHaveProperty('apiTokenEnc');
  });

  it('ADMIN: panel verify success persists panelOk=true, decouples the token, journals server.panel.verify', async () => {
    const id = (
      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/servers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
    ).body.find((s: { name: string }) => s.name === name).id as string;

    fakeVerify.mockResolvedValueOnce({
      ok: true,
      detail: 'Coolify API : joignable + authentifié (version 4.0.0-beta) (213 ms)',
      latencyMs: 213,
      version: '4.0.0-beta',
    });

    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers/${id}/panel-verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    expect(res.body.result.ok).toBe(true);
    expect(res.body.server.panelOk).toBe(true);
    expect(res.body.server.panelDetail).toContain('Coolify API');
    expect(res.body.server.panelVerifiedAt).toBeTruthy();
    // Le transport a reçu le jeton DÉCHIFFRÉ (le bon), jamais exposé.
    expect(fakeVerify).toHaveBeenLastCalledWith({
      provider: 'COOLIFY',
      baseUrl: 'https://panel.exemple.com/api/v1',
      token: 'secret-token-raw',
      user: 'api',
      strictTls: true,
    });

    // Persisté en base.
    const reread = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/servers/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(reread.body.panelOk).toBe(true);
    expect(reread.body.panelDetail).toContain('Coolify API');

    // Audit journalisé.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'server.panel.verify', resourceId: id, actorEmail: adminEmail },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeTruthy();
    const details = audit?.details as { provider: string; ok: boolean; version: string | null };
    expect(details.provider).toBe('COOLIFY');
    expect(details.ok).toBe(true);
    expect(details.version).toBe('4.0.0-beta');
  });

  it('ADMIN: a failed verify persists panelOk=false with a readable detail', async () => {
    const id = (
      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/servers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
    ).body.find((s: { name: string }) => s.name === name).id as string;

    fakeVerify.mockResolvedValueOnce({ ok: false, detail: 'Jeton API rejeté (401)' });

    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers/${id}/panel-verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    expect(res.body.result.ok).toBe(false);
    expect(res.body.server.panelOk).toBe(false);
    expect(res.body.server.panelDetail).toBe('Jeton API rejeté (401)');
  });

  it('Phase 9bis: create accepts manual metrics and verify fills only empty fields', async () => {
    const created = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `srv_metrics_${stamp}`,
        hostname: 'metered.exemple.com',
        panelProvider: 'HESTIA',
        apiBaseUrl: 'https://metered.exemple.com/api/',
        apiToken: 'tok-metrics',
        apiUser: 'api',
        ramMb: 8192, // saisi manuellement => préservé par la vérification
      })
      .expect(201);
    expect(created.body.ramMb).toBe(8192);
    expect(created.body.cpuCores).toBeNull();
    expect(created.body.diskGb).toBeNull();
    const id = created.body.id as string;

    // La vérification Hestia auto-détecte CPU/Disque mais PAS la RAM (déjà renseignée).
    fakeVerify.mockResolvedValueOnce({
      ok: true,
      detail: 'Hestia API : joignable + authentifié (50 ms)',
      latencyMs: 50,
      metrics: { ramMb: 4096, cpuCores: 8, diskGb: 200 },
    });
    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers/${id}/panel-verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    // RAM manuelle conservée ; CPU/Disque auto-remplis.
    expect(res.body.server.ramMb).toBe(8192);
    expect(res.body.server.cpuCores).toBe(8);
    expect(res.body.server.diskGb).toBe(200);
  });

  it('400 when no panel credentials are configured (no token)', async () => {
    fakeVerify.mockClear();
    const id = (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/servers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `srv_panel_notoken_${stamp}`, hostname: 'plain.exemple.com', panelProvider: 'HESTIA', apiBaseUrl: 'https://p/api/' })
        .expect(201)
    ).body.id as string;

    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers/${id}/panel-verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    expect(fakeVerify).not.toHaveBeenCalled();

    await request(app.getHttpServer())
      .delete(`/${GlobalPrefix}/servers/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('PATCH apiToken="" clears the stored token (hasApiToken=false)', async () => {
    const id = (
      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/servers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
    ).body.find((s: { name: string }) => s.name === name).id as string;

    const patched = await request(app.getHttpServer())
      .patch(`/${GlobalPrefix}/servers/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ apiToken: '' })
      .expect(200);

    expect(patched.body.hasApiToken).toBe(false);
    expect(patched.body).not.toHaveProperty('apiTokenEnc');

    const reread = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/servers/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(reread.body.hasApiToken).toBe(false);
    // Le reste de la config panneau est inchangé.
    expect(reread.body.apiBaseUrl).toBe('https://panel.exemple.com/api/v1');

    await request(app.getHttpServer())
      .delete(`/${GlobalPrefix}/servers/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });
});
