import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { DeploymentModuleKind, Role, ServerPanelProvider } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { CryptoService } from './../src/crypto/crypto.service';
import { GlobalPrefix } from './../src/config/constants';
import { PanelTransportFactory, PanelTransport } from './../src/servers/panel-transport.factory';

/**
 * A0 — RBAC des 3 routes GET de `/api/admin/deployment-modules` (audit C-02).
 *
 * Politique appliquée : `RolesGuard` + `@Roles(ADMIN)` sur `GET /`,
 * `GET :id` et `GET :id/projects` (les GET exposaient hostname/panelProvider
 * et `:id/projects` déclenche un appel panneau côté serveur).
 *
 * Matrice permanente : anonyme 401 · USER 403 · SUPPORT (autres rôles) 403 ·
 * ADMIN 200 — avec preuve que AUCUN appel panneau n'est émis lors d'un refus
 * (compteur sur le transport factice) et qu'aucune donnée sensible n'apparaît
 * dans les corps de refus. Aucun appel provider réel : le transport est stubé.
 */
describe('RBAC admin/deployment-modules (A0) — e2e permanent', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = Date.now();
  const adminEmail = `rbac_admin_${stamp}@example.com`;
  const userEmail = `rbac_user_${stamp}@example.com`;
  const supportEmail = `rbac_l1_${stamp}@example.com`;
  const password = 'password123';
  const secretHostname = `panel-secret-${stamp}.example.internal`;

  let adminToken = '';
  let userToken = '';
  let supportToken = '';
  let serverId = '';
  let moduleId = '';

  // Compteur d'appels panneau : doit rester à 0 pour tout refus.
  const listProjectsCalls: string[] = [];
  const fakeListProjects = jest.fn().mockResolvedValue([
    { uuid: 'fake-proj-1', name: 'Projet factice' },
  ]);
  const fakeFactory = {
    create: (): PanelTransport =>
      ({
        verify: jest.fn().mockResolvedValue({ ok: true }),
        createGitApp: jest.fn().mockResolvedValue({ uuid: 'app-1' }),
        createProject: jest.fn().mockResolvedValue({ uuid: 'proj-1', name: 'x' }),
        listProjects: (target: { baseUrl: string }) => {
          listProjectsCalls.push(target.baseUrl);
          return fakeListProjects();
        },
        listServers: jest.fn().mockResolvedValue([]),
        deployApp: jest.fn().mockResolvedValue(undefined),
        deploymentStatus: jest.fn().mockResolvedValue({ rawStatus: 'in_progress' }),
        applyAppLimits: jest.fn().mockResolvedValue(undefined),
        setAppEnvironment: jest.fn().mockResolvedValue(undefined),
        applyNodePort: jest.fn().mockResolvedValue(undefined),
        resolveExposedPort: jest.fn().mockResolvedValue(null),
        setAppDomain: jest.fn().mockResolvedValue(undefined),
        deleteApplication: jest.fn().mockResolvedValue(undefined),
      }) as unknown as PanelTransport,
  } as unknown as PanelTransportFactory;

  const login = async (email: string): Promise<string> =>
    (
      await request(app.getHttpServer())
        .post(`/${GlobalPrefix}/auth/login`)
        .send({ email, password })
        .expect(201)
    ).body.accessToken as string;

  const forbiddenWithoutPanel = async (
    token: string | null,
    label: string,
  ): Promise<void> => {
    const before = listProjectsCalls.length;
    for (const path of ['', '/any-id', '/any-id/projects']) {
      const r = await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/admin/deployment-modules${path}`)
        .set('Authorization', `Bearer ${token ?? 'invalid'}`)
        .expect(token ? 403 : 401);
      const body = JSON.stringify(r.body);
      expect(body).not.toContain(secretHostname);
      expect(body).not.toContain('panelProvider');
      expect(body).not.toContain('apiBaseUrl');
    }
    expect(listProjectsCalls.length).toBe(before);
    expect(label.length).toBeGreaterThan(0);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PanelTransportFactory)
      .useValue(fakeFactory)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    const crypto = moduleRef.get(CryptoService);

    const server = await prisma.server.create({
      data: {
        name: `RBAC serveur factice ${stamp}`,
        hostname: secretHostname,
        panelProvider: ServerPanelProvider.COOLIFY,
        apiBaseUrl: 'https://panel-factice-localhost.example/api/v1',
        apiTokenEnc: crypto.encrypt('jeton-factice-recette'),
        strictTls: false,
      },
    });
    serverId = server.id;

    const module_ = await prisma.deploymentModule.create({
      data: {
        name: `Module RBAC ${stamp}`,
        code: `RB${stamp}`,
        kind: DeploymentModuleKind.SHARED_PROJECT,
        serverId,
      },
    });
    moduleId = module_.id;

    for (const [email, role] of [
      [adminEmail, Role.ADMIN],
      [userEmail, Role.USER],
      [supportEmail, Role.SUPPORT_L1],
    ] as const) {
      await prisma.user.create({
        data: { email, passwordHash: await bcrypt.hash(password, 10), role, name: role },
      });
    }
    adminToken = await login(adminEmail);
    userToken = await login(userEmail);
    supportToken = await login(supportEmail);
  });

  afterAll(async () => {
    await prisma.deploymentModule.delete({ where: { id: moduleId } }).catch(() => {});
    await prisma.server.delete({ where: { id: serverId } }).catch(() => {});
    await prisma.user
      .deleteMany({ where: { email: { in: [adminEmail, userEmail, supportEmail] } } })
      .catch(() => {});
    await app.close();
  });

  it('anonyme (jeton absent) → 401 sur les 3 GET, 0 appel panneau', async () => {
    const before = listProjectsCalls.length;
    for (const path of ['', '/x', '/x/projects']) {
      await request(app.getHttpServer())
        .get(`/${GlobalPrefix}/admin/deployment-modules${path}`)
        .expect(401);
    }
    expect(listProjectsCalls.length).toBe(before);
  });

  it('USER → 403 sur les 3 GET, 0 appel panneau, aucune donnée sensible', async () => {
    await forbiddenWithoutPanel(userToken, 'user');
  });

  it('SUPPORT_L1 (autre rôle authentifié) → 403 sur les 3 GET, 0 appel panneau', async () => {
    await forbiddenWithoutPanel(supportToken, 'support-l1');
  });

  it('USER → 403 sur la mutation POST (non-régression) sans appel panneau', async () => {
    const before = listProjectsCalls.length;
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/admin/deployment-modules`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'tentative', code: 'T1', kind: 'SHARED_PROJECT' })
      .expect(403);
    expect(listProjectsCalls.length).toBe(before);
  });

  it('ADMIN → 200 sur GET / et GET :id avec données visibles pour l’admin', async () => {
    const list = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/admin/deployment-modules`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const row = (list.body as { id: string; server?: { hostname?: string } }[]).find(
      (m) => m.id === moduleId,
    );
    expect(row).toBeTruthy();

    const one = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/admin/deployment-modules/${moduleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((one.body as { server?: { hostname?: string } }).server?.hostname).toBe(
      secretHostname,
    );
  });

  it('ADMIN → 200 sur GET :id/projects — appel panneau émis (transport factice)', async () => {
    const before = listProjectsCalls.length;
    const r = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/admin/deployment-modules/${moduleId}/projects`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(listProjectsCalls.length).toBe(before + 1);
    expect((r.body as { projects: unknown[] }).projects).toHaveLength(1);
  });

  it('après la matrice : le compteur panneau n’a bougé que pour l’ADMIN', () => {
    expect(listProjectsCalls.length).toBe(1);
  });
});
