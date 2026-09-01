import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { ProbeTransportFactory, ProbeTransport } from './../src/servers/probe-transport.factory';

// Phase 8 (ADR-025): sonde de connectivité réelle POST /api/servers/:id/check.
// Comme pour MailTransportFactory, la factory de sonde est overridée en e2e → AUCUN
// réseau réel n'est contacté pendant les tests.
describe('ProbeServer check (e2e, Phase 8)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = Date.now();
  const adminEmail = `admin_probe_${stamp}@example.com`;
  const userEmail = `user_probe_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let userToken = '';

  // Couture : transport factice dont `probe` est reconfiguré test par test.
  const fakeProbe = jest.fn().mockResolvedValue({ ok: true, detail: 'FAKE OK' });
  const fakeFactory: ProbeTransportFactory = {
    create: (): ProbeTransport => ({ probe: fakeProbe as unknown as ProbeTransport['probe'] }),
  } as unknown as ProbeTransportFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ProbeTransportFactory)
      .useValue(fakeFactory)
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
    await request(app.getHttpServer()).post(`/${GlobalPrefix}/servers/whatever/check`).expect(401);
  });

  it('403 for a USER (infra is ADMIN-only)', async () => {
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers/whatever/check`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);
  });

  it('404 for an unknown server id (no probe)', async () => {
    fakeProbe.mockClear();
    await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers/nope_${stamp}/check`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
    expect(fakeProbe).not.toHaveBeenCalled();
  });

  it('ADMIN: probe success persists lastProbeOk=true and returns server+probe', async () => {
    const created = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `srv_probe_${stamp}`, hostname: 'node1.exemple.com', port: 22 })
      .expect(201);
    const id = created.body.id as string;

    fakeProbe.mockResolvedValueOnce({ ok: true, detail: 'TCP 22 : accessible (4 ms)', latencyMs: 4 });

    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers/${id}/check`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    expect(res.body.probe.ok).toBe(true);
    expect(res.body.probe.detail).toBe('TCP 22 : accessible (4 ms)');
    expect(res.body.server.id).toBe(id);
    expect(res.body.server.lastProbeOk).toBe(true);
    expect(res.body.server.lastProbeDetail).toBe('TCP 22 : accessible (4 ms)');
    expect(res.body.server.lastCheckedAt).toBeTruthy();
    // Le statut reste celui tapé par l'admin — la sonde ne le force pas.
    expect(res.body.server.status).toBe('UNKNOWN');

    // Persisté en base : relecture via GET.
    const reread = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/servers/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(reread.body.lastProbeOk).toBe(true);
    expect(reread.body.lastProbeDetail).toBe('TCP 22 : accessible (4 ms)');

    await request(app.getHttpServer())
      .delete(`/${GlobalPrefix}/servers/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('ADMIN: probe failure persists lastProbeOk=false and journals server.check', async () => {
    const created = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `srv_probe_fail_${stamp}`, hostname: 'node2.exemple.com' })
      .expect(201);
    const id = created.body.id as string;

    fakeProbe.mockResolvedValueOnce({ ok: false, detail: 'Connexion refusée' });

    const res = await request(app.getHttpServer())
      .post(`/${GlobalPrefix}/servers/${id}/check`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    expect(res.body.probe.ok).toBe(false);
    expect(res.body.server.lastProbeOk).toBe(false);
    expect(res.body.server.lastProbeDetail).toBe('Connexion refusée');

    // Le point d'accès honore strictTls/port du serveur : port par défaut 22, strictTls défaut true.
    expect(fakeProbe).toHaveBeenLastCalledWith({
      host: 'node2.exemple.com',
      port: 22,
      strictTls: true,
    });

    // Audit journalisé.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'server.check', resourceId: id, actorEmail: adminEmail },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeTruthy();
    const details = audit?.details as { ok: boolean; port: number; statusLeft: string };
    expect(details.ok).toBe(false);
    expect(details.port).toBe(22);
    expect(details.statusLeft).toBe('UNKNOWN');

    await request(app.getHttpServer())
      .delete(`/${GlobalPrefix}/servers/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });
});