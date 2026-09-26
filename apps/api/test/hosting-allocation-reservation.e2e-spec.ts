import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  INestApplication,
  NotFoundException,
  PreconditionFailedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HostingServiceAllocationStatus, HostingServiceStatus } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { GlobalPrefix } from './../src/config/constants';
import { HostingServicesService } from './../src/hosting/hosting-services.service';
import {
  installFingerprintEnv,
  newClientRequestId,
  removeFingerprintEnv,
  samplePayload,
} from './hosting-reservation.fixture';

/**
 * 17B.4F-C1 — moteur de réservation transactionnel sur PostgreSQL RÉEL.
 *
 * Prouve : verrou `FOR UPDATE` + quota + empreinte HMAC versionnée sous
 * concurrence réelle (deux passages de la matrice), rejeu idempotent sans
 * double ligne, transitions locales (preuves, interdictions, terminal),
 * refus fail-closed (404 ownership, 400 UUID, 503 configuration/empreinte).
 *
 * AUCUN appel provider/DNS/GitHub (aucun transport injecté), aucun endpoint,
 * aucune ligne live : fixtures horodatées isolées, intégralement nettoyées.
 * Exécutée UNIQUEMENT contre une base de test isolée (DATABASE_URL dédiée).
 */
describe('Hosting allocation reservation C1 (e2e, PostgreSQL réel)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hosting: HostingServicesService;
  const stamp = Date.now();
  const marker = `e2e-c1-${stamp}`;
  const ids: Record<string, string> = {};
  const CONCURRENT = 8;

  const snapshots = (maxAppsSnapshot: number | null) => ({
    maxAppsSnapshot,
    ramMbSnapshot: 1024,
    cpuCoresSnapshot: 1,
    storageLimitGbSnapshot: null,
    packNameSnapshot: null,
    productNameSnapshot: null,
  });

  const allocCount = (serviceId: string): Promise<number> =>
    prisma.hostingServiceAllocation.count({ where: { hostingServiceId: serviceId } });

  const reserve = (
    hostingServiceId: string,
    over: { clientRequestId?: string; actorUserId?: string; payload?: ReturnType<typeof samplePayload> } = {},
  ) =>
    hosting.reserveSlot({
      hostingServiceId,
      actorUserId: ids.user1!,
      clientRequestId: over.clientRequestId ?? newClientRequestId(),
      payload: over.payload ?? samplePayload(),
    });

  type Settled =
    | { ok: true; value: Awaited<ReturnType<HostingServicesService['reserveSlot']>> }
    | { ok: false; error: unknown };

  const settle = (promise: Promise<Awaited<ReturnType<HostingServicesService['reserveSlot']>>>): Promise<Settled> =>
    promise.then(
      (value): Settled => ({ ok: true, value }),
      (error): Settled => ({ ok: false, error }),
    );

  async function cleanup(): Promise<void> {
    // ordre fail-closed : allocations → déploiements → services → utilisateurs
    await prisma.hostingServiceAllocation
      .deleteMany({ where: { hostingService: { user: { email: { startsWith: `${marker}-` } } } } })
      .catch(() => {});
    await prisma.deployment
      .deleteMany({ where: { user: { email: { startsWith: `${marker}-` } } } })
      .catch(() => {});
    await prisma.hostingService
      .deleteMany({ where: { user: { email: { startsWith: `${marker}-` } } } })
      .catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: `${marker}-` } } }).catch(() => {});
  }

  beforeAll(async () => {
    installFingerprintEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(GlobalPrefix);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    hosting = new HostingServicesService(prisma);

    const user1 = await prisma.user.create({
      data: { email: `${marker}-owner@example.com`, passwordHash: 'e2e-hash' },
    });
    const user2 = await prisma.user.create({
      data: { email: `${marker}-other@example.com`, passwordHash: 'e2e-hash' },
    });
    Object.assign(ids, { user1: user1.id, user2: user2.id });

    const createService = async (
      key: string,
      maxApps: number | null,
      ownerUserId: string,
      status: HostingServiceStatus,
    ): Promise<void> => {
      const service = await hosting.create(ownerUserId, { snapshots: snapshots(maxApps) });
      await prisma.hostingService.update({ where: { id: service.id }, data: { status } });
      ids[key] = service.id;
    };

    await createService('svcSame1', 8, ids.user1!, HostingServiceStatus.ACTIVE);
    await createService('svcSame2', 8, ids.user1!, HostingServiceStatus.ACTIVE);
    await createService('svcQuota1', 1, ids.user1!, HostingServiceStatus.ACTIVE);
    await createService('svcQuota2', 1, ids.user1!, HostingServiceStatus.ACTIVE);
    await createService('svcMain', 16, ids.user1!, HostingServiceStatus.ACTIVE);
    await createService('svcSuspended', 2, ids.user1!, HostingServiceStatus.ACTIVE);
    await createService('svcCancelled', 2, ids.user1!, HostingServiceStatus.CANCELLED);
    await createService('svcUnlimited', null, ids.user1!, HostingServiceStatus.ACTIVE);
    await createService('svcZero', 0, ids.user1!, HostingServiceStatus.ACTIVE);
    await createService('svcCompensation', 2, ids.user1!, HostingServiceStatus.ACTIVE);
    await createService('svcForeign', 2, ids.user2!, HostingServiceStatus.ACTIVE);
    await createService('svcConcSame', 8, ids.user1!, HostingServiceStatus.ACTIVE);
    await createService('svcConcQuota5', 5, ids.user1!, HostingServiceStatus.ACTIVE);
    await createService('svcQuotaFull', 1, ids.user1!, HostingServiceStatus.ACTIVE);
    await createService('svcDeterminism', 4, ids.user1!, HostingServiceStatus.ACTIVE);

    const depBind = await prisma.deployment.create({
      data: { userId: ids.user1!, repoFullName: 'e2e/c1-bind', status: 'ACTIVE' },
    });
    const depOther = await prisma.deployment.create({
      data: { userId: ids.user1!, repoFullName: 'e2e/c1-other', status: 'ACTIVE' },
    });
    const depForeign = await prisma.deployment.create({
      data: { userId: ids.user2!, repoFullName: 'e2e/c1-foreign', status: 'ACTIVE' },
    });
    Object.assign(ids, { depBind: depBind.id, depOther: depOther.id, depForeign: depForeign.id });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    removeFingerprintEnv();
  });

  // ── matrice concurrente : DEUX passages ──────────────────────────────────

  async function sameKeyMatrix(serviceId: string): Promise<void> {
    const args = {
      hostingServiceId: serviceId,
      actorUserId: ids.user1!,
      clientRequestId: newClientRequestId(),
      payload: samplePayload(),
    };
    const results = await Promise.all(Array.from({ length: CONCURRENT }, () => settle(hosting.reserveSlot(args))));

    const values = results.flatMap((r) => (r.ok ? [r.value] : []));
    const failures = results.flatMap((r) => (r.ok ? [] : [r.error]));
    expect(failures).toHaveLength(0);
    expect(new Set(values.map((v) => v.allocation.id)).size).toBe(1);
    expect(values.filter((v) => !v.replayed)).toHaveLength(1);
    expect(await allocCount(serviceId)).toBe(1);
  }

  async function quotaMatrix(serviceId: string): Promise<void> {
    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, () => settle(reserve(serviceId))),
    );
    const wins = results.flatMap((r) => (r.ok ? [r.value] : []));
    const losses = results.flatMap((r) => (r.ok ? [] : [r.error]));
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(CONCURRENT - 1);
    for (const error of losses) {
      expect(error).toBeInstanceOf(ForbiddenException);
    }
    expect(await allocCount(serviceId)).toBe(1);
  }

  describe('passe 1 — matrice concurrente', () => {
    it('8 réservations identiques → UNE allocation créée, 7 rejeux idempotents', async () => {
      await sameKeyMatrix(ids.svcSame1!);
    });

    it('8 réservations distinctes sur quota 1 → 1 création, 7 refus, 1 ligne en base', async () => {
      await quotaMatrix(ids.svcQuota1!);
    });
  });

  describe('passe 2 — matrice concurrente', () => {
    it('8 réservations identiques → UNE allocation créée, 7 rejeux idempotents', async () => {
      await sameKeyMatrix(ids.svcSame2!);
    });

    it('8 réservations distinctes sur quota 1 → 1 création, 7 refus, 1 ligne en base', async () => {
      await quotaMatrix(ids.svcQuota2!);
    });
  });

  // ── empreinte : stockage, rejeu, refus explicites ────────────────────────

  it('empreinte stockée au format fp:v1, aucun payload en clair en base, rejeu divergent refusé', async () => {
    const args = {
      hostingServiceId: ids.svcMain!,
      actorUserId: ids.user1!,
      clientRequestId: newClientRequestId(),
      payload: samplePayload({ environment: { host: 'cle-publique-refusee.test' } }),
    };
    const before = await allocCount(ids.svcMain!);
    const first = await hosting.reserveSlot(args);
    expect(first.replayed).toBe(false);
    expect(first.allocation.requestFingerprint).toMatch(/^fp:v1:[0-9a-f]{64}$/);
    expect(first.allocation.requestFingerprint).not.toContain('cle-publique-refusee.test');
    expect(first.allocation.idempotencyKey).toMatch(/^direct:v1:/);

    // rejeu avec la même clé mais un payload différent → Conflict, aucune écriture
    await expect(
      hosting.reserveSlot({ ...args, payload: samplePayload({ environment: { host: 'autre.host.test' } }) }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await allocCount(ids.svcMain!)).toBe(before + 1);

    // rejeu strictement identique → idempotent
    const replay = await hosting.reserveSlot(args);
    expect(replay.replayed).toBe(true);
    expect(replay.allocation.id).toBe(first.allocation.id);
    expect(await allocCount(ids.svcMain!)).toBe(before + 1);
  });

  it('service entre-temps suspendu : le rejeu reste possible (lecture seule), une NOUVELLE clé est refusée', async () => {
    const args = {
      hostingServiceId: ids.svcSuspended!,
      actorUserId: ids.user1!,
      clientRequestId: newClientRequestId(),
      payload: samplePayload(),
    };
    const first = await hosting.reserveSlot(args);
    expect(first.replayed).toBe(false);

    await prisma.hostingService.update({
      where: { id: ids.svcSuspended! },
      data: { status: HostingServiceStatus.SUSPENDED },
    });
    const replay = await hosting.reserveSlot(args);
    expect(replay.replayed).toBe(true);
    expect(replay.allocation.id).toBe(first.allocation.id);

    await expect(reserve(ids.svcSuspended!)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await allocCount(ids.svcSuspended!)).toBe(1);
  });

  it('RELEASED est terminal : rejeu retourné tel quel, intention post-libération refusée', async () => {
    const args = {
      hostingServiceId: ids.svcMain!,
      actorUserId: ids.user1!,
      clientRequestId: newClientRequestId(),
      payload: samplePayload(),
    };
    const before = await allocCount(ids.svcMain!);
    const first = await hosting.reserveSlot(args);
    const released = await hosting.releasePreProvider({
      allocationId: first.allocation.id,
      actorUserId: ids.user1!,
    });
    expect(released).toEqual({ released: true });

    const replay = await hosting.reserveSlot(args);
    expect(replay.replayed).toBe(true);
    expect(replay.allocation.status).toBe(HostingServiceAllocationStatus.RELEASED);
    // la ligne existe toujours en un seul exemplaire (aucune recréation)
    expect(await allocCount(ids.svcMain!)).toBe(before + 1);

    const intent = await hosting.markProviderIntent({
      allocationId: first.allocation.id,
      actorUserId: ids.user1!,
    });
    expect(intent).toEqual({ applied: false, reason: 'terminal' });
    const row = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: first.allocation.id },
    });
    expect(row.status).toBe(HostingServiceAllocationStatus.RELEASED);
    expect(row.providerIntentAt).toBeNull();
  });

  // ── course réelle : intention vs compensation pré-provider ───────────────

  it('course intention/compensation → exactement un gagnant et un état cohérent', async () => {
    const allocation = await reserve(ids.svcMain!);
    expect(allocation.replayed).toBe(false);

    const [intentSettled, releaseSettled] = await Promise.allSettled([
      hosting.markProviderIntent({ allocationId: allocation.allocation.id, actorUserId: ids.user1! }),
      hosting.releasePreProvider({ allocationId: allocation.allocation.id, actorUserId: ids.user1! }),
    ]);
    expect(intentSettled.status).toBe('fulfilled');
    expect(releaseSettled.status).toBe('fulfilled');
    if (intentSettled.status !== 'fulfilled' || releaseSettled.status !== 'fulfilled') {
      throw new Error('transition non remplie');
    }

    const intent = intentSettled.value;
    const release = releaseSettled.value;
    const row = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: allocation.allocation.id },
    });

    if (intent.applied) {
      // l'intention a gagné : compensation refusée, marqueur présent, RESERVED
      expect(release).toEqual({ released: false, reason: 'intent_present' });
      expect(row.status).toBe(HostingServiceAllocationStatus.RESERVED);
      expect(row.providerIntentAt).not.toBeNull();
    } else {
      // la compensation a gagné : intention refusée (terminal), RELEASED nu
      expect(intent).toEqual({ applied: false, reason: 'terminal' });
      expect(release).toEqual({ released: true });
      expect(row.status).toBe(HostingServiceAllocationStatus.RELEASED);
      expect(row.providerIntentAt).toBeNull();
    }
  });

  // ── quotas ───────────────────────────────────────────────────────────────

  it('maxAppsSnapshot = 0 → quota immédiatement refusé (aucune ligne)', async () => {
    await expect(reserve(ids.svcZero!)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await allocCount(ids.svcZero!)).toBe(0);
  });

  it('maxAppsSnapshot = null → illimité (3 réservations distinctes acceptées)', async () => {
    const before = await allocCount(ids.svcUnlimited!);
    await reserve(ids.svcUnlimited!);
    await reserve(ids.svcUnlimited!);
    await reserve(ids.svcUnlimited!);
    expect(await allocCount(ids.svcUnlimited!)).toBe(before + 3);
  });

  it('la libération pré-provider libère réellement le slot (RELEASED ne consomme plus)', async () => {
    const a1 = await reserve(ids.svcCompensation!);
    const a2 = await reserve(ids.svcCompensation!);
    expect(a1.replayed).toBe(false);
    expect(a2.replayed).toBe(false);
    // quota 2 atteint : la 3e réservation est refusée
    await expect(reserve(ids.svcCompensation!)).rejects.toBeInstanceOf(ForbiddenException);

    // compensation pré-provider (jamais d'intention → jamais de refus)
    const released = await hosting.releasePreProvider({
      allocationId: a1.allocation.id,
      actorUserId: ids.user1!,
    });
    expect(released).toEqual({ released: true });
    await expect(
      hosting.releasePreProvider({ allocationId: a1.allocation.id, actorUserId: ids.user1! }),
    ).resolves.toEqual({ released: false, reason: 'already_released' });

    // le slot libéré est de nouveau réservable (RELEASED ne consomme plus)
    const a3 = await reserve(ids.svcCompensation!);
    expect(a3.replayed).toBe(false);
    // 3 lignes en base (a1 RELEASED + a2/a3), mais 2 SLOTS consommés
    expect(await allocCount(ids.svcCompensation!)).toBe(3);
    expect(await hosting.countConsumingAllocations(ids.svcCompensation!)).toBe(2);
  });

  // ── refus fail-closed ────────────────────────────────────────────────────

  it('clientRequestId non UUID v4 → BadRequest, aucune écriture', async () => {
    const before = await allocCount(ids.svcMain!);
    await expect(
      reserve(ids.svcMain!, { clientRequestId: 'cle-libre-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await allocCount(ids.svcMain!)).toBe(before);
  });

  it('configuration d’empreinte absente → 503, aucune écriture (l’API reste démarrée)', async () => {
    const savedKeys = process.env.HOSTING_FP_KEYS;
    const savedLegacy = process.env.ENCRYPTION_KEY;
    delete process.env.HOSTING_FP_KEYS;
    delete process.env.ENCRYPTION_KEY;
    const before = await allocCount(ids.svcMain!);
    try {
      await expect(reserve(ids.svcMain!)).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      if (savedKeys !== undefined) process.env.HOSTING_FP_KEYS = savedKeys;
      if (savedLegacy !== undefined) process.env.ENCRYPTION_KEY = savedLegacy;
    }
    expect(await allocCount(ids.svcMain!)).toBe(before);
  });

  it('empreinte stockée en version inconnue → refus explicite au rejeu (aucun repli)', async () => {
    const args = {
      hostingServiceId: ids.svcMain!,
      actorUserId: ids.user1!,
      clientRequestId: newClientRequestId(),
      payload: samplePayload(),
    };
    const before = await allocCount(ids.svcMain!);
    const first = await hosting.reserveSlot(args);
    await prisma.hostingServiceAllocation.update({
      where: { id: first.allocation.id },
      data: { requestFingerprint: `fp:v99:${'a'.repeat(64)}` },
    });
    await expect(hosting.reserveSlot(args)).rejects.toBeInstanceOf(ServiceUnavailableException);
    // la ligne reste unique (refus, jamais de seconde allocation)
    expect(await allocCount(ids.svcMain!)).toBe(before + 1);
  });

  it('service et allocation étrangers → 404 sur réservation et toutes les primitives', async () => {
    // service d'un autre client
    await expect(reserve(ids.svcForeign!)).rejects.toBeInstanceOf(NotFoundException);

    // allocation d'un autre client
    const mine = await reserve(ids.svcMain!);
    const foreign = { allocationId: mine.allocation.id, actorUserId: ids.user2! };
    await expect(
      hosting.markBound({
        ...foreign,
        deploymentId: ids.depOther!,
        proof: { providerProven: true },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(hosting.markProviderIntent(foreign)).rejects.toBeInstanceOf(NotFoundException);
    await expect(hosting.releasePreProvider(foreign)).rejects.toBeInstanceOf(NotFoundException);
    await expect(hosting.startReleasing(foreign)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      hosting.completeRelease({ ...foreign, proof: { providerCleanupProven: true } }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const row = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: mine.allocation.id },
    });
    expect(row.status).toBe(HostingServiceAllocationStatus.RESERVED);
    expect(row.deploymentId).toBeNull();
    expect(row.providerIntentAt).toBeNull();
  });

  it('déploiement d’un autre client → 404 (aucun lien inter-clients)', async () => {
    const allocation = await reserve(ids.svcMain!);
    await expect(
      hosting.markBound({
        allocationId: allocation.allocation.id,
        actorUserId: ids.user1!,
        deploymentId: ids.depForeign!,
        proof: { providerProven: true },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    const row = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: allocation.allocation.id },
    });
    expect(row.status).toBe(HostingServiceAllocationStatus.RESERVED);
    expect(row.deploymentId).toBeNull();
  });

  // ── chaîne complète de transitions locales ───────────────────────────────

  it('chaîne RESERVED → BOUND → RELEASING → RELEASED avec preuves, interdictions et détachement', async () => {
    // preuves exigées AVANT toute écriture (412)
    const allocation = await reserve(ids.svcMain!);
    const base = { allocationId: allocation.allocation.id, actorUserId: ids.user1! };
    await expect(
      hosting.markBound({ ...base, deploymentId: ids.depBind!, proof: { providerProven: false } }),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
    await expect(
      hosting.markBound({
        ...base,
        deploymentId: ids.depBind!,
        proof: { providerProven: undefined as unknown as boolean },
      }),
    ).rejects.toBeInstanceOf(PreconditionFailedException);

    // RESERVED → BOUND (preuve fournie) + idempotence sur le MÊME déploiement
    const bound = await hosting.markBound({
      ...base,
      deploymentId: ids.depBind!,
      proof: { providerProven: true },
    });
    expect(bound.status).toBe(HostingServiceAllocationStatus.BOUND);
    expect(bound.deploymentId).toBe(ids.depBind);
    const rebound = await hosting.markBound({
      ...base,
      deploymentId: ids.depBind!,
      proof: { providerProven: true },
    });
    expect(rebound.id).toBe(bound.id);
    expect(rebound.status).toBe(HostingServiceAllocationStatus.BOUND);

    // un AUTRE déploiement → Conflict (déjà lié)
    await expect(
      hosting.markBound({ ...base, deploymentId: ids.depOther!, proof: { providerProven: true } }),
    ).rejects.toBeInstanceOf(ConflictException);

    // intention provider locale, irréversible, AVANT toute libération
    const intent = await hosting.markProviderIntent(base);
    expect(intent.applied).toBe(true);

    // BOUND → RELEASING (idempotent)
    const started = await hosting.startReleasing(base);
    expect(started.status).toBe(HostingServiceAllocationStatus.RELEASING);
    const restarted = await hosting.startReleasing(base);
    expect(restarted.status).toBe(HostingServiceAllocationStatus.RELEASING);

    // idempotence sur le MÊME déploiement ENCORE LIÉ en RELEASING :
    // retour de l'état courant, AUCUN retour en arrière vers BOUND
    const reboundDuringRelease = await hosting.markBound({
      ...base,
      deploymentId: ids.depBind!,
      proof: { providerProven: true },
    });
    expect(reboundDuringRelease.status).toBe(HostingServiceAllocationStatus.RELEASING);
    expect(reboundDuringRelease.deploymentId).toBe(ids.depBind);

    // déploiement encore lié → Conflict (détachement exigé)
    await expect(
      hosting.completeRelease({ ...base, proof: { providerCleanupProven: true } }),
    ).rejects.toBeInstanceOf(ConflictException);
    // preuve de nettoyage exigée (412)
    await expect(
      hosting.completeRelease({ ...base, proof: { providerCleanupProven: false } }),
    ).rejects.toBeInstanceOf(PreconditionFailedException);

    // suppression de la ligne déploiement → SetNull sur l'allocation
    await prisma.deployment.delete({ where: { id: ids.depBind! } });
    const detached = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: allocation.allocation.id },
    });
    expect(detached.deploymentId).toBeNull();

    // RELEASING → RELEASED (preuve fournie)
    const done = await hosting.completeRelease({ ...base, proof: { providerCleanupProven: true } });
    expect(done.status).toBe(HostingServiceAllocationStatus.RELEASED);
    expect(done.releasedAt).not.toBeNull();

    // RELEASED : terminal, idempotent, jamais ressuscité, marqueur conservé
    const again = await hosting.completeRelease({ ...base, proof: { providerCleanupProven: true } });
    expect(again.status).toBe(HostingServiceAllocationStatus.RELEASED);
    const startedAfter = hosting.startReleasing(base);
    await expect(startedAfter).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      hosting.markBound({ ...base, deploymentId: ids.depOther!, proof: { providerProven: true } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const finalRow = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: allocation.allocation.id },
    });
    expect(finalRow.providerIntentAt).not.toBeNull(); // intention IRRÉVOCABLE
  });

  it('RELEASING → BOUND est interdit (réservation sans déploiement)', async () => {
    const allocation = await reserve(ids.svcMain!);
    const base = { allocationId: allocation.allocation.id, actorUserId: ids.user1! };
    const started = await hosting.startReleasing(base);
    expect(started.status).toBe(HostingServiceAllocationStatus.RELEASING);
    await expect(
      hosting.markBound({ ...base, deploymentId: ids.depOther!, proof: { providerProven: true } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const row = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: allocation.allocation.id },
    });
    expect(row.status).toBe(HostingServiceAllocationStatus.RELEASING);
    expect(row.deploymentId).toBeNull();
  });

  // ── complément de revue : matrice 50 appels + ordres déterministes ──────

  const REVIEW_CALLS = 50;

  /**
   * Attend N contendants réellement EN ATTENTE de verrou (pg_stat_activity :
   * une attente de verrou de ligne se matérialise par `wait_event_type='Lock'`
   * sur la transaction faisant le `FOR UPDATE`, pas par une ligne `relation`
   * non accordée dans pg_locks). Le jeton identifie la requête de verrou ①
   * service du moteur.
   */
  const waitLockWaiters = async (statementToken: string, expected: number): Promise<void> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const rows = await prisma.$queryRaw<Array<{ c: number }>>`
        SELECT count(*)::int AS "c"
        FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND query LIKE ${`%${statementToken}%`}`;
      if ((rows[0]?.c ?? 0) >= expected) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`contendants en attente non atteints : ${statementToken} x${expected}`);
  };

  /**
   * Course DÉTERMINISTE (sync explicite, jamais un allSettled aléatoire) :
   * ① une transaction teneur exécute le `FOR UPDATE` sur la ligne
   *    `HostingService` et ne poursuit qu'après confirmation de ce verrou ;
   * ② chaque contendant est lancé et CONFIRMÉ en attente (pg_stat_activity,
   *    `wait_event_type='Lock'`) AVANT le suivant — la file d'attente est
   *    FIFO, donc le contendant lancé en premier gagne à coup sûr ;
   * ③ le teneur relâche : les deux opérations s'exécutent réellement en
   *    concurrence (deux transactions distinctes) dans l'ordre imposé.
   */
  const deterministicRace = async (
    serviceId: string,
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
  ): Promise<[unknown, unknown]> => {
    let openHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      openHold = resolve;
    });
    let markLocked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "HostingService" WHERE "id" = ${serviceId} FOR UPDATE`;
        markLocked(); // confirmation : le verrou du teneur est DÉJÀ acquis
        await hold;
      },
      { timeout: 20000 },
    );
    const wrap = (promise: Promise<unknown>) =>
      promise.then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      );
    try {
      await lockAcquired;
      const firstSettled = wrap(first());
      await waitLockWaiters('FROM "HostingService" AS s', 1);
      const secondSettled = wrap(second());
      await waitLockWaiters('FROM "HostingService" AS s', 2);
      openHold();
      const [r1, r2] = await Promise.all([firstSettled, secondSettled]);
      if (!r1.ok) {
        throw r1.error;
      }
      if (!r2.ok) {
        throw r2.error;
      }
      return [r1.value, r2.value];
    } finally {
      openHold();
      await holder;
    }
  };

  it('A. 50 appels identiques simultanés → UNE allocation, 50 succès la référençant', async () => {
    const args = {
      hostingServiceId: ids.svcConcSame!,
      actorUserId: ids.user1!,
      clientRequestId: newClientRequestId(),
      payload: samplePayload(),
    };
    const results = await Promise.all(
      Array.from({ length: REVIEW_CALLS }, () => settle(hosting.reserveSlot(args))),
    );
    const failures = results.flatMap((r) => (r.ok ? [] : [r.error]));
    const values = results.flatMap((r) => (r.ok ? [r.value] : []));
    expect(failures).toHaveLength(0);
    expect(values).toHaveLength(REVIEW_CALLS);
    expect(new Set(values.map((v) => v.allocation.id)).size).toBe(1);
    expect(values.filter((v) => !v.replayed)).toHaveLength(1);
    expect(await allocCount(ids.svcConcSame!)).toBe(1);
  });

  it('B. 50 clés distinctes simultanées sur quota 5 → 5 créations, 45 refus quota, 0 erreur technique', async () => {
    const results = await Promise.all(
      Array.from({ length: REVIEW_CALLS }, () => settle(reserve(ids.svcConcQuota5!))),
    );
    const wins = results.flatMap((r) => (r.ok ? [r.value] : []));
    const errors = results.flatMap((r) => (r.ok ? [] : [r.error]));
    const isQuotaRefusal = (error: unknown): boolean =>
      error instanceof ForbiddenException && /Quota de slots atteint/.test((error as Error).message);
    const quotaRefusals = errors.filter(isQuotaRefusal);
    const technicalErrors = errors.filter((error) => !isQuotaRefusal(error));

    expect(technicalErrors).toHaveLength(0); // pool / verrou / timeout / 409 → strictement nul
    expect(wins).toHaveLength(5);
    expect(wins.filter((w) => !w.replayed)).toHaveLength(5);
    expect(quotaRefusals).toHaveLength(REVIEW_CALLS - 5);
    expect(await allocCount(ids.svcConcQuota5!)).toBe(5);
    expect(await hosting.countConsumingAllocations(ids.svcConcQuota5!)).toBe(5);
  });

  it('C. quota exactement plein → rejeu identique renvoyé (aucun refus quota)', async () => {
    const args = {
      hostingServiceId: ids.svcQuotaFull!,
      actorUserId: ids.user1!,
      clientRequestId: newClientRequestId(),
      payload: samplePayload(),
    };
    const first = await hosting.reserveSlot(args);
    expect(first.replayed).toBe(false);
    expect(await hosting.countConsumingAllocations(ids.svcQuotaFull!)).toBe(1); // exactement plein

    // rejeux CONCURRENTS alors que le quota est plein → tous succès, MÊME ligne
    const replays = await Promise.all(
      Array.from({ length: 10 }, () => settle(hosting.reserveSlot(args))),
    );
    const failures = replays.flatMap((r) => (r.ok ? [] : [r.error]));
    expect(failures).toHaveLength(0);
    const values = replays.flatMap((r) => (r.ok ? [r.value] : []));
    expect(values).toHaveLength(10);
    expect(values.every((v) => v.replayed && v.allocation.id === first.allocation.id)).toBe(true);

    // une NOUVELLE clé reste refusée : le quota est toujours exactement plein
    await expect(reserve(ids.svcQuotaFull!)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await allocCount(ids.svcQuotaFull!)).toBe(1);
  });

  it('D1. ordre déterministe intention D’ABORD → compensation gagnante jamais', async () => {
    const allocation = await reserve(ids.svcDeterminism!);
    const base = { allocationId: allocation.allocation.id, actorUserId: ids.user1! };
    const [intent, release] = await deterministicRace(
      ids.svcDeterminism!,
      () => hosting.markProviderIntent(base),
      () => hosting.releasePreProvider(base),
    );
    expect(intent).toEqual({ applied: true, providerIntentAt: expect.any(Date) });
    expect(release).toEqual({ released: false, reason: 'intent_present' });
    const row = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: allocation.allocation.id },
    });
    expect(row.status).toBe(HostingServiceAllocationStatus.RESERVED);
    expect(row.providerIntentAt).not.toBeNull();
  });

  it('D2. ordre déterministe compensation D’ABORD → intention refusée (terminal)', async () => {
    const allocation = await reserve(ids.svcDeterminism!);
    const base = { allocationId: allocation.allocation.id, actorUserId: ids.user1! };
    const [release, intent] = await deterministicRace(
      ids.svcDeterminism!,
      () => hosting.releasePreProvider(base),
      () => hosting.markProviderIntent(base),
    );
    expect(release).toEqual({ released: true });
    expect(intent).toEqual({ applied: false, reason: 'terminal' });
    const row = await prisma.hostingServiceAllocation.findUniqueOrThrow({
      where: { id: allocation.allocation.id },
    });
    expect(row.status).toBe(HostingServiceAllocationStatus.RELEASED);
    expect(row.providerIntentAt).toBeNull();
  });

  // ── hygiène ──────────────────────────────────────────────────────────────

  it('nettoyage des fixtures : plus aucune ligne résiduelle', async () => {
    await cleanup();
    expect(await prisma.hostingService.count()).toBe(0);
    expect(await prisma.hostingServiceAllocation.count()).toBe(0);
    expect(await prisma.deployment.count({ where: { user: { email: { startsWith: `${marker}-` } } } })).toBe(0);
    expect(await prisma.user.count({ where: { email: { startsWith: `${marker}-` } } })).toBe(0);
  });
});
