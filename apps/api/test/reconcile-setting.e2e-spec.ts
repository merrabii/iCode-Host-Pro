import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as bcrypt from 'bcryptjs';
import request = require('supertest');
import { Role } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { RECONCILE_DEFAULT_SETTINGS, RECONCILE_SETTING_SINGLETON_ID } from './../src/store/reconcile-settings';
import { ReconcileSettingsService } from './../src/store/reconcile-settings.service';

// 17B.4C1 — persistance PostgreSQL + API admin des réglages de réconciliation.
// AppModule réel + PostgreSQL local : aucune ligne active initialement ;
// rectifications d'overrides administrées strictement ADMIN ; sources exactes ;
// atomicité (PATCH invalide → 400, DB inchangée) ; singleton garanti ;
// persistance à travers une recréation d'application ; AUCUN worker démarré
// même avec enabled=true (l'activation réelle est 17B.4C2).
describe('Reconcile settings (e2e, 17B.4C1)', () => {
  const url = `/${GlobalPrefix}/admin/reconcile`;

  let app: INestApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let settings: ReconcileSettingsService;
  const stamp = Date.now();
  const adminEmail = `recadmin_${stamp}@example.com`;
  const userEmail = `recuser_${stamp}@example.com`;
  const password = 'password123';
  let adminToken = '';
  let userToken = '';
  type Prior = {
    enabled: boolean | null;
    scanIntervalMs: number | null;
    batchSize: number | null;
    leaseMs: number | null;
    attemptAlertThreshold: number | null;
    backoffInitialMs: number | null;
    maxBackoffMs: number | null;
  } | null;
  let prior: Prior = null;

  async function startApp(): Promise<INestApplication> {
    const a = moduleRef.createNestApplication();
    a.setGlobalPrefix(GlobalPrefix);
    a.use(cookieParser());
    a.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await a.init();
    return a;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = await startApp();
    prisma = moduleRef.get(PrismaService);
    settings = moduleRef.get(ReconcileSettingsService);

    // État du singleton AVANT la suite : restauré à l'identique en afterAll.
    const existing = await prisma.reconcileSetting.findUnique({ where: { id: RECONCILE_SETTING_SINGLETON_ID } });
    prior = existing
      ? {
          enabled: existing.enabled,
          scanIntervalMs: existing.scanIntervalMs,
          batchSize: existing.batchSize,
          leaseMs: existing.leaseMs,
          attemptAlertThreshold: existing.attemptAlertThreshold,
          backoffInitialMs: existing.backoffInitialMs,
          maxBackoffMs: existing.maxBackoffMs,
        }
      : null;
    await prisma.reconcileSetting.deleteMany({}).catch(() => {});

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
    await prisma.user
      .deleteMany({ where: { email: { in: [adminEmail, userEmail] } } })
      .catch(() => {});
    // Restauration EXACTE du singleton (row préexistante recréée telle quelle,
    // sinon suppression des rows du test) — aucune config résiduelle.
    await prisma.reconcileSetting.deleteMany({}).catch(() => {});
    if (prior) {
      await prisma.reconcileSetting
        .create({ data: { id: RECONCILE_SETTING_SINGLETON_ID, ...prior } })
        .catch(() => {});
    }
    await app.close();
  });

  it('1. GET admin sans ligne : 401/403 pour non-admin, vue env/défauts pour l\'admin', async () => {
    await request(app.getHttpServer()).get(url).expect(401);
    await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);

    const res = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.effective).toEqual(RECONCILE_DEFAULT_SETTINGS);
    expect(res.body.overrides).toEqual({});
    expect(res.body.sources.batchSize).toBe('DEFAULT');
    // RECONCILE_ENABLED=false effectif (env .env ou défaut), aucun worker actif.
    expect(res.body.effective.enabled).toBe(false);
  });

  it('2. PATCH valide admin → 200, GET reflète immédiatement la valeur DB', async () => {
    const updated = await request(app.getHttpServer())
      .patch(url)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ batchSize: 42 })
      .expect(200);
    expect(updated.body.effective.batchSize).toBe(42);
    expect(updated.body.overrides.batchSize).toBe(42);
    expect(updated.body.sources.batchSize).toBe('DATABASE');

    const read = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(read.body.effective.batchSize).toBe(42);
    expect(read.body.sources.batchSize).toBe('DATABASE');
  });

  it('3. modification de plusieurs champs atomique → tous visibles ensemble', async () => {
    const res = await request(app.getHttpServer())
      .patch(url)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ scanIntervalMs: 60_000, leaseMs: 180_000, attemptAlertThreshold: 3, backoffInitialMs: 20_000, maxBackoffMs: 90_000 })
      .expect(200);
    expect(res.body.effective.scanIntervalMs).toBe(60_000);
    expect(res.body.effective.leaseMs).toBe(180_000);
    expect(res.body.effective.attemptAlertThreshold).toBe(3);
    expect(res.body.effective.backoffInitialMs).toBe(20_000);
    expect(res.body.effective.maxBackoffMs).toBe(90_000);
  });

  it('4. PATCH invalide → 400 et DB inchangée (aucune écriture partielle)', async () => {
    const before = (
      await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${adminToken}`).expect(200)
    ).body.effective;
    for (const bad of [
      { leaseMs: 20_000 },
      { batchSize: 5000 },
      { backoffInitialMs: 1_800_000, maxBackoffMs: 1_000_000 },
      { batchSize: 7.5 },
      { scanIntervalMs: 'abc' },
    ]) {
      const res = await request(app.getHttpServer())
        .patch(url)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(bad)
        .expect(400);
      expect(res.body).not.toHaveProperty('effective');
    }
    const after = (
      await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${adminToken}`).expect(200)
    ).body.effective;
    expect(after).toEqual(before);
  });

  it('5. enabled=false explicite persisté puis true (sources DATABASE)', async () => {
    const off = await request(app.getHttpServer())
      .patch(url)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: false })
      .expect(200);
    expect(off.body.effective.enabled).toBe(false);
    expect(off.body.sources.enabled).toBe('DATABASE');

    const on = await request(app.getHttpServer())
      .patch(url)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true })
      .expect(200);
    expect(on.body.effective.enabled).toBe(true);
    expect(on.body.sources.enabled).toBe('DATABASE');
  });

  it('6. null sur un champ supprime l\'override → retour env/défaut', async () => {
    const cleared = await request(app.getHttpServer())
      .patch(url)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ batchSize: null })
      .expect(200);
    expect(cleared.body.overrides.batchSize).toBeNull();
    expect(cleared.body.effective.batchSize).toBe(RECONCILE_DEFAULT_SETTINGS.batchSize);
    expect(cleared.body.sources.batchSize).not.toBe('DATABASE');
  });

  it('7. reset → retour env/défauts (overrides vides), idempotent', async () => {
    await request(app.getHttpServer())
      .patch(url)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ batchSize: 55, enabled: true })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`${url}/reset`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect(res.body.overrides).toEqual({});
    expect(res.body.effective).toEqual(RECONCILE_DEFAULT_SETTINGS);
    expect(res.body.sources.batchSize).toBe('DEFAULT');

    const again = await request(app.getHttpServer())
      .post(`${url}/reset`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect(again.body.effective).toEqual(RECONCILE_DEFAULT_SETTINGS);
  });

  it('8. une seule ligne singleton après de multiples PATCH', async () => {
    for (const b of [2, 3, 4]) {
      await request(app.getHttpServer())
        .patch(url)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ batchSize: b })
        .expect(200);
    }
    const rows = await prisma.reconcileSetting.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(RECONCILE_SETTING_SINGLETON_ID);
  });

  it('9. recréation d\'application → réglages persistés (pas de perte)', async () => {
    await request(app.getHttpServer())
      .patch(url)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ batchSize: 77 })
      .expect(200);
    await app.close();

    app = await startApp();
    const view = await settings.getView();
    expect(view.overrides.batchSize).toBe(77);
    expect(view.effective.batchSize).toBe(77);
  });

  it('10. AUCUN worker automatique : enabled=true en base ne déclenche pas de scan', async () => {
    const beforeScans = await prisma.auditLog.count({
      where: { action: { contains: 'reconcile' } },
    });
    const res = await request(app.getHttpServer())
      .patch(url)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true })
      .expect(200);
    expect(res.body.effective.enabled).toBe(true);
    expect(res.body.sources.enabled).toBe('DATABASE');

    // Aucun scanOnce déclenché automatiquement : attendre puis constater l'absence
    // d'activité moteur (le seul événement reconcile est l'audit du PATCH admin).
    await new Promise((r) => setTimeout(r, 600));
    const afterScans = await prisma.auditLog.count({
      where: { action: { contains: 'reconcile' } },
    });
    expect(afterScans).toBe(beforeScans + 1); // uniquement l'audit update du PATCH ci-dessus
  });

  it('11. le config public auth-config n\'expose aucun réglage de réconciliation', async () => {
    const pub = await request(app.getHttpServer())
      .get(`/${GlobalPrefix}/public/auth-config`)
      .expect(200);
    expect(pub.body).not.toHaveProperty('reconcile');
    expect(pub.body).not.toHaveProperty('reconcileSetting');
  });

  it('12. validation sur DB actuelle + patch partiel → 400, ligne inchangée (et patch valide conservé)', async () => {
    await request(app.getHttpServer())
      .patch(url)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ backoffInitialMs: 600_000, maxBackoffMs: 900_000 })
      .expect(200);

    const before = (
      await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${adminToken}`).expect(200)
    ).body.overrides;

    // Paire héritée de la base (600 000 initial) + patch ne touchant QUE
    // maxBackoffMs=300 000 → config FUSIONNÉE invalide → HTTP 400, aucune écriture.
    const bad = await request(app.getHttpServer())
      .patch(url)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ maxBackoffMs: 300_000 })
      .expect(400);
    expect(bad.body).not.toHaveProperty('effective');

    const after = (
      await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${adminToken}`).expect(200)
    ).body.overrides;
    expect(after).toEqual(before); // ancienne ligne strictement inchangée

    // Patch partiel VALIDE : la paire existante est préservée.
    const ok = await request(app.getHttpServer())
      .patch(url)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ scanIntervalMs: 120_000 })
      .expect(200);
    expect(ok.body.overrides.backoffInitialMs).toBe(600_000);
    expect(ok.body.overrides.maxBackoffMs).toBe(900_000);
    expect(ok.body.effective.scanIntervalMs).toBe(120_000);
  });

  it('13. clé « id » dans le corps ignorée (whitelist) : singleton conservé, aucune ligne étrangère', async () => {
    await request(app.getHttpServer())
      .patch(url)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: 'hack-id', batchSize: 13 })
      .expect(200);
    const rows = await prisma.reconcileSetting.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(RECONCILE_SETTING_SINGLETON_ID);
    expect(rows[0].batchSize).toBe(13);
  });
});