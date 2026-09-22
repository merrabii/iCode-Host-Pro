import { ReconcileService, RECONCILE_TERMINAL_THRESHOLD, ReconcileScanStats } from './reconcile.service';
import { reconcileBackoffDelayMs } from './reconcile-backoff';
import { RECONCILE_DEFAULT_SETTINGS, ReconcileSettings } from './reconcile-settings';
import { ProviderDeploymentObservation } from './deployment-evidence';

// 17B.4B — MOTEUR de réconciliation (scanOnce). Aucune boucle, aucun worker,
// aucun réseau : Prisma est simulé par un mini-modèle en mémoire qui reproduit
// les sémantiques ATOMIQUES des updateMany gardés (lease, increment, statuts),
// l'évidence et l'activation sont mockées. `now` est contrôlé (horloge figée).
//
// NB : ce test ne parle JAMAIS de Coolify (grep de validation séparé) — le moteur
// ne connaît que des observations agnostiques.

const NOW = new Date('2026-09-01T00:00:00.000Z');

type Obs = ProviderDeploymentObservation;

const OBS = {
  terminal: (): Obs => ({ lifecycle: 'TERMINAL', health: 'NOT_APPLICABLE', proofPolicy: 'NO_PROOF_AVAILABLE' }),
  runningHealthy: (): Obs => ({ lifecycle: 'RUNNING', health: 'HEALTHY', proofPolicy: 'PROVIDER_SUFFICIENT' }),
  runningHttp: (served: boolean): Obs => ({ lifecycle: 'RUNNING', health: 'UNKNOWN', proofPolicy: 'HTTP_REQUIRED', httpServed: served }),
  runningConnector: (satisfied: boolean): Obs => ({
    lifecycle: 'RUNNING',
    health: 'UNKNOWN',
    proofPolicy: 'CONNECTOR_REQUIRED',
    connectorProof: { label: 'santé', satisfied },
  }),
  transitional: (): Obs => ({ lifecycle: 'TRANSITIONAL', health: 'NOT_APPLICABLE', proofPolicy: 'NO_PROOF_AVAILABLE' }),
  unknown: (): Obs => ({ lifecycle: 'UNKNOWN', health: 'UNKNOWN', proofPolicy: 'NO_PROOF_AVAILABLE' }),
};

const MOTOR_SETTINGS: ReconcileSettings = { ...RECONCILE_DEFAULT_SETTINGS, enabled: true };

interface Row {
  id: string;
  status: string;
  reconcileNextAt: Date | null;
  reconcileAttempts: number;
  reconcileTerminalFailures: number;
  reconcileLastCheckedAt: Date | null;
  coolifyUuid: string | null;
  fqdn: string | null;
  orderId: string | null;
  serverId: string | null;
}

/** Projection strictement GÉNÉRIQUE renvoyée par le moteur (findMany select). */
type CandidateRow = {
  id: string;
  orderId: string | null;
  reconcileAttempts: number;
  reconcileTerminalFailures: number;
};

/** Mini-modèle Prisma : sémantiques atomiques minimales des write paths du moteur. */
class MiniDb {
  rows: Row[] = [];
  auditLogCalls: { data: Record<string, unknown> }[] = [];
  orderHistoryCalls: { data: Record<string, unknown> }[] = [];
  forceClaimZero = false;
  throwOnRescheduleWrites = false;

  atMs(t: Date | null): number {
    return t ? t.getTime() : -Infinity;
  }

  findMany(args: {
    where: { status: string; reconcileNextAt: { not: null; lte: Date } };
    orderBy: { reconcileNextAt: 'asc' };
    take: number;
    select: Record<string, boolean>;
  }): CandidateRow[] {
    const due = this.rows
      .filter(
        (r) =>
          r.status === args.where.status &&
          r.reconcileNextAt !== null &&
          this.atMs(r.reconcileNextAt) <= this.atMs(args.where.reconcileNextAt.lte),
      )
      .sort((a, b) => this.atMs(a.reconcileNextAt) - this.atMs(b.reconcileNextAt))
      .slice(0, args.take);
    return due.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      reconcileAttempts: r.reconcileAttempts,
      reconcileTerminalFailures: r.reconcileTerminalFailures,
    }));
  }

  async updateMany(args: {
    where: { id: string; status: string; reconcileNextAt?: { not: null; lte: Date } };
    data: Record<string, unknown>;
  }): Promise<{ count: number }> {
    if (
      this.forceClaimZero &&
      (args.data.reconcileAttempts as { increment?: number } | undefined)?.increment === 1
    ) {
      return { count: 0 };
    }
    if (
      this.throwOnRescheduleWrites &&
      'reconcileTerminalFailures' in args.data &&
      args.data.reconcileNextAt !== null
    ) {
      throw new Error('replanification boom (simulé)');
    }
    const matches = this.rows.filter(
      (r) => r.id === args.where.id && r.status === args.where.status,
    );
    for (const r of matches) {
      if (
        args.where.reconcileNextAt &&
        (r.reconcileNextAt === null ||
          this.atMs(r.reconcileNextAt) > this.atMs(args.where.reconcileNextAt.lte))
      ) {
        return { count: 0 };
      }
      if ('status' in args.data) r.status = args.data.status as string;
      if ('reconcileNextAt' in args.data) r.reconcileNextAt = args.data.reconcileNextAt as Date | null;
      const inc = (args.data.reconcileAttempts as { increment?: number } | undefined)?.increment;
      if (inc) r.reconcileAttempts += inc;
      if ('reconcileTerminalFailures' in args.data) r.reconcileTerminalFailures = args.data.reconcileTerminalFailures as number;
      if ('reconcileLastCheckedAt' in args.data) r.reconcileLastCheckedAt = args.data.reconcileLastCheckedAt as Date | null;
    }
    return { count: matches.length };
  }

  async auditLogCreate(args: { data: Record<string, unknown> }): Promise<{ id: string }> {
    this.auditLogCalls.push(args);
    return { id: 'audit-1' };
  }

  async orderHistoryCreate(args: { data: Record<string, unknown> }): Promise<{ id: string }> {
    this.orderHistoryCalls.push(args);
    return { id: 'hist-1' };
  }
}

function dueRow(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    status: 'DEPLOYING',
    reconcileNextAt: NOW,
    reconcileAttempts: 0,
    reconcileTerminalFailures: 0,
    reconcileLastCheckedAt: null,
    coolifyUuid: `app-${id}`,
    fqdn: `${id}.example.com`,
    orderId: `ord-${id}`,
    serverId: 'srv-1',
    ...over,
  };
}

function makeService(
  db: MiniDb,
  settings: ReconcileSettings = MOTOR_SETTINGS,
  obsBy: Record<string, Obs[] | Obs> = {},
) {
  const prismaMock = {
    deployment: { findMany: jest.fn((a) => db.findMany(a)), updateMany: jest.fn((a) => db.updateMany(a)) },
    auditLog: { create: jest.fn((a) => db.auditLogCreate(a)) },
    orderStatusHistory: { create: jest.fn((a) => db.orderHistoryCreate(a)) },
  };
  const evidence = {
    observe: jest.fn(async (deploymentId: string): Promise<Obs> => {
      const entry = obsBy[deploymentId];
      if (Array.isArray(entry)) return entry.shift() ?? OBS.unknown();
      if (entry) return entry;
      return OBS.unknown();
    }),
  };
  const settingsSvc = { getSettings: jest.fn(() => settings) };
  const provisioning = {
    activateOrderAfterProof: jest.fn().mockResolvedValue({
      orderIsActive: true,
      deploymentIsActive: true,
      orderActivated: true,
      deploymentActivated: true,
      noop: false,
    }),
  };
  const service = new ReconcileService(
    prismaMock as never,
    settingsSvc as never,
    evidence as never,
    provisioning as never,
  );
  return { service, evidence, settingsSvc, provisioning, prismaMock, db };
}

// =========================================================================
// Backoff pure (module PUR, non-Nest) — garanties d'overflow et de borne.
// =========================================================================
describe('reconcileBackoffDelayMs — backoff exponentiel BORNÉ', () => {
  const s = { backoffInitialMs: 30_000, maxBackoffMs: 3_600_000 };

  it('n=1 ⇒ délai initial exact', () => {
    expect(reconcileBackoffDelayMs(1, s)).toBe(30_000);
  });

  it('n intermédiaire ⇒ initial * 2^(n-1) tant que < max', () => {
    expect(reconcileBackoffDelayMs(2, s)).toBe(60_000);
    expect(reconcileBackoffDelayMs(3, s)).toBe(120_000);
    expect(reconcileBackoffDelayMs(4, s)).toBe(240_000);
  });

  it('palier atteint ⇒ plafonné à maxBackoffMs (pas de famine)', () => {
    expect(reconcileBackoffDelayMs(8, s)).toBe(3_600_000); // 30_000*128 > max
    expect(reconcileBackoffDelayMs(100, s)).toBe(3_600_000);
  });

  it('overflow (facteur démesuré) ⇒ retourne max SANS évaluer un produit débordant', () => {
    expect(reconcileBackoffDelayMs(1200, s)).toBe(3_600_000);
  });

  it('attempt < 1 ramené à 1 (jamais moins que l’initial)', () => {
    expect(reconcileBackoffDelayMs(0, s)).toBe(30_000);
    expect(reconcileBackoffDelayMs(-5, s)).toBe(30_000);
  });

  it('maxBackoffMs peut valoir backoffInitialMs (bornes validées par ailleurs)', () => {
    expect(reconcileBackoffDelayMs(1, { backoffInitialMs: 60_000, maxBackoffMs: 60_000 })).toBe(60_000);
    expect(reconcileBackoffDelayMs(9, { backoffInitialMs: 60_000, maxBackoffMs: 60_000 })).toBe(60_000);
  });
});

// =========================================================================
// Sélection / claim / compteurs
// =========================================================================
describe('ReconcileService — sélection & claim', () => {
  it('moteur DÉSACTIVÉ ⇒ statistiques explicites, AUCUNE lecture, aucun appel panel', async () => {
    const db = new MiniDb();
    const { service, evidence, prismaMock } = makeService(db, { ...RECONCILE_DEFAULT_SETTINGS, enabled: false });

    const stats = await service.scanOnce(NOW);

    expect(stats).toEqual(expect.objectContaining({ enabled: false, scanned: 0 }));
    expect(prismaMock.deployment.findMany).not.toHaveBeenCalled();
    expect(evidence.observe).not.toHaveBeenCalled();
  });

  it('sélection : uniquement DEPLOYING avec échéance présente et DUE (null/futur/FAILED exclus)', async () => {
    const db = new MiniDb();
    db.rows = [
      dueRow('due', { reconcileNextAt: NOW }),
      dueRow('future', { reconcileNextAt: new Date(NOW.getTime() + 60_000) }),
      dueRow('legacy', { reconcileNextAt: null }),
      dueRow('failed', { reconcileNextAt: NOW, status: 'FAILED' }),
    ];
    const { service, prismaMock } = makeService(db);

    const stats = await service.scanOnce(NOW);

    expect(stats).toEqual(
      expect.objectContaining({
        claimed: 1,
        scanned: 1,
        lostRace: 0,
        rescheduled: 1,
      }),
    );
    expect(prismaMock.deployment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'DEPLOYING', reconcileNextAt: { not: null, lte: NOW } },
        orderBy: { reconcileNextAt: 'asc' },
        take: MOTOR_SETTINGS.batchSize,
        // Projection GÉNÉRIQUE seule : aucune donnée provider ne traverse le moteur.
        select: { id: true, orderId: true, reconcileAttempts: true, reconcileTerminalFailures: true },
      }),
    );
    expect(db.rows.find((r) => r.id === 'due')!.reconcileAttempts).toBe(1);
    expect(db.rows.find((r) => r.id === 'future')!.reconcileAttempts).toBe(0);
    expect(db.rows.find((r) => r.id === 'legacy')!.reconcileAttempts).toBe(0);
  });

  it('batch par échéance asc et borné par batchSize', async () => {
    const db = new MiniDb();
    db.rows = [
      dueRow('late', { reconcileNextAt: NOW }),
      dueRow('soon', { reconcileNextAt: new Date(NOW.getTime() - 10_000) }),
      dueRow('mid', { reconcileNextAt: new Date(NOW.getTime() - 5_000) }),
    ];
    const { service, prismaMock } = makeService(db, { ...MOTOR_SETTINGS, batchSize: 2 });

    const stats = await service.scanOnce(NOW);

    expect(stats.scanned).toBe(2);
    expect(prismaMock.deployment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2, orderBy: { reconcileNextAt: 'asc' } }),
    );
    // Seuls les 2 plus anciens ont été touchés (soon, mid) ; late intact.
    expect(db.rows.find((r) => r.id === 'soon')!.reconcileAttempts).toBe(1);
    expect(db.rows.find((r) => r.id === 'mid')!.reconcileAttempts).toBe(1);
    expect(db.rows.find((r) => r.id === 'late')!.reconcileAttempts).toBe(0);
  });

  it('claim gagné ⇒ lease posé + attempts incrémenté + dernier check posé (garde atomique exacte)', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1')];
    const { service, prismaMock } = makeService(db);

    await service.scanOnce(NOW);

    const claimCall = prismaMock.deployment.updateMany.mock.calls[0][0];
    expect(claimCall).toEqual({
      where: { id: 'd1', status: 'DEPLOYING', reconcileNextAt: { not: null, lte: NOW } },
      data: {
        reconcileNextAt: new Date(NOW.getTime() + MOTOR_SETTINGS.leaseMs),
        reconcileAttempts: { increment: 1 },
        reconcileLastCheckedAt: NOW,
      },
    });
    expect(db.rows[0]!.reconcileAttempts).toBe(1);
    expect(db.rows[0]!.reconcileLastCheckedAt).toEqual(NOW);
  });

  it('claim perdu (count 0) ⇒ lostRace, AUCUN appel panel ni activation', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1')];
    db.forceClaimZero = true;
    const { service, evidence, provisioning } = makeService(db);

    const stats = await service.scanOnce(NOW);

    expect(stats).toEqual(expect.objectContaining({ claimed: 0, lostRace: 1 }));
    expect(evidence.observe).not.toHaveBeenCalled();
    expect(provisioning.activateOrderAfterProof).not.toHaveBeenCalled();
    expect(db.rows[0]!.reconcileAttempts).toBe(0);
  });

  it('deux workers partageant la base ⇒ un SEUL propriétaire (le lease exclut l’autre)', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1')];
    const a = makeService(db);
    const b = makeService(db);

    const statsA = await a.service.scanOnce(NOW);
    const statsB = await b.service.scanOnce(NOW);

    expect(statsA.claimed).toBe(1);
    expect(statsA.lostRace).toBe(0);
    // L'échéance est déjà future pour B → aucun candidat.
    expect(statsB).toEqual(expect.objectContaining({ scanned: 0, claimed: 0, lostRace: 0 }));
    expect(a.evidence.observe).toHaveBeenCalledTimes(1);
    expect(b.evidence.observe).not.toHaveBeenCalled();
  });

  it('couplage provider absent : le moteur n’émet QUE des deploymentId (aucune donnée provider, un futur renommage interne ne le touchera pas)', async () => {
    const db = new MiniDb();
    // La row contient bien l'id provider (mimique de la base réelle)…
    db.rows = [dueRow('d1')];
    const { service, evidence, prismaMock } = makeService(db);

    await service.scanOnce(NOW);

    // … mais le moteur en sélectionne ZÉRO champ : projection strictement générique.
    expect(prismaMock.deployment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { id: true, orderId: true, reconcileAttempts: true, reconcileTerminalFailures: true },
      }),
    );
    // Et ne transmet à la couche évidence QUE l'identifiant opaque.
    expect(evidence.observe).toHaveBeenCalledTimes(1);
    expect(evidence.observe).toHaveBeenCalledWith('d1');
  });
});

// =========================================================================
// Seuil d'alerte (mode lent) — exactement une fois, jamais bloquant
// =========================================================================
describe('ReconcileService — seuil de tentatives (alerte best-effort)', () => {
  it('11→12 franchit le seuil 12 ⇒ UNE alerte ; 12→13 n’en émet PAS de nouvelle', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1', { reconcileAttempts: 11 })];
    const settings = { ...MOTOR_SETTINGS, attemptAlertThreshold: 12 };
    const { service } = makeService(db, settings);

    const s1 = await service.scanOnce(NOW);
    // Le 2e scan doit être DUE : l'échéance est repoussée à backoff(12) par s1.
    // (horloge réelle, backoff pure importée — les 2 scans sont bien rejoués)
    const s2 = await service.scanOnce(
      new Date(NOW.getTime() + reconcileBackoffDelayMs(12, settings)),
    );

    expect(s1.alerts).toBe(1);
    expect(s2.alerts).toBe(0);
    expect(db.auditLogCalls).toHaveLength(1);
    expect(db.auditLogCalls[0]!.data).toEqual(
      expect.objectContaining({
        action: 'reconcile.attempt_alert',
        resourceType: 'deployment',
        resourceId: 'd1',
        details: { attempts: 12 },
      }),
    );
    expect(db.rows[0]!.reconcileAttempts).toBe(13);
  });

  it('9→10 reste SOUS le seuil ⇒ aucune alerte', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1', { reconcileAttempts: 9 })];
    const { service } = makeService(db, { ...MOTOR_SETTINGS, attemptAlertThreshold: 12 });

    const stats = await service.scanOnce(NOW);

    expect(stats.alerts).toBe(0);
    expect(db.auditLogCalls).toHaveLength(0);
  });

  it('échec de journalisation de l’alerte ⇒ jamais bloquant, le cycle continue', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1', { reconcileAttempts: 11 })];
    const { service, prismaMock } = makeService(db, { ...MOTOR_SETTINGS, attemptAlertThreshold: 12 });
    prismaMock.auditLog.create.mockRejectedValueOnce(new Error('audit down'));

    const stats = await service.scanOnce(NOW);

    expect(stats.alerts).toBe(0);
    expect(stats.errors).toBe(0); // l'alerte n'est PAS une erreur moteur
    expect(db.rows[0]!.reconcileAttempts).toBe(12); // le claim a bien eu lieu
    expect(db.rows[0]!.reconcileNextAt).not.toBeNull(); // replanifié
  });
});

// =========================================================================
// Matrice générique du moteur (lifecycle × preuves) — jamais ACTIVE sans preuve
// =========================================================================
describe('ReconcileService — matrice de décision', () => {
  it('RUNNING + PROVIDER_SUFFICIENT ⇒ activation via activateOrderAfterProof + lease libéré', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1')];
    const { service, evidence, provisioning } = makeService(db, MOTOR_SETTINGS, { d1: OBS.runningHealthy() });

    const stats = await service.scanOnce(NOW);

    expect(stats.activated).toBe(1);
    // Le moteur n'envoie QUE le deploymentId — aucune donnée provider.
    expect(evidence.observe).toHaveBeenCalledWith('d1');
    expect(provisioning.activateOrderAfterProof).toHaveBeenCalledWith('ord-d1');
    expect(db.rows[0]!.reconcileNextAt).toBeNull();
  });

  it('RUNNING + HTTP_REQUIRED + httpServed=true ⇒ activation', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1')];
    const { service, provisioning } = makeService(db, MOTOR_SETTINGS, { d1: OBS.runningHttp(true) });

    const stats = await service.scanOnce(NOW);

    expect(stats.activated).toBe(1);
    expect(provisioning.activateOrderAfterProof).toHaveBeenCalledWith('ord-d1');
  });

  it('RUNNING + HTTP_REQUIRED + httpServed=false ⇒ JAMAIS ACTIVE, replanification', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1', { reconcileTerminalFailures: 4 })];
    const { service, provisioning } = makeService(db, MOTOR_SETTINGS, { d1: OBS.runningHttp(false) });

    const stats = await service.scanOnce(NOW);

    expect(stats.activated).toBe(0);
    expect(provisioning.activateOrderAfterProof).not.toHaveBeenCalled();
    expect(db.rows[0]!.status).toBe('DEPLOYING');
    expect(db.rows[0]!.reconcileNextAt).toEqual(new Date(NOW.getTime() + 30_000));
    // RUNNING ⇒ compteur terminal remis à 0 même sans preuve.
    expect(db.rows[0]!.reconcileTerminalFailures).toBe(0);
  });

  it('RUNNING + CONNECTOR_REQUIRED satisfait ⇒ activation ; non satisfait ⇒ replanification', async () => {
    const ok = new MiniDb();
    ok.rows = [dueRow('o1')];
    const okRun = makeService(ok, MOTOR_SETTINGS, { o1: OBS.runningConnector(true) });
    expect((await okRun.service.scanOnce(NOW)).activated).toBe(1);
    expect(okRun.provisioning.activateOrderAfterProof).toHaveBeenCalledWith('ord-o1');

    const ko = new MiniDb();
    ko.rows = [dueRow('k1')];
    const koRun = makeService(ko, MOTOR_SETTINGS, { k1: OBS.runningConnector(false) });
    expect((await koRun.service.scanOnce(NOW)).activated).toBe(0);
    expect(koRun.provisioning.activateOrderAfterProof).not.toHaveBeenCalled();
    expect(ko.rows[0]!.status).toBe('DEPLOYING');
  });

  it('RUNNING prouvé mais SANS orderId ⇒ aucune activation, replanification sûre', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1', { orderId: null })];
    const { service, provisioning } = makeService(db, MOTOR_SETTINGS, { d1: OBS.runningHealthy() });

    const stats = await service.scanOnce(NOW);

    expect(stats.activated).toBe(0);
    expect(provisioning.activateOrderAfterProof).not.toHaveBeenCalled();
    expect(db.rows[0]!.status).toBe('DEPLOYING');
    expect(db.rows[0]!.reconcileNextAt).not.toBeNull();
  });

  it('TRANSITIONAL ⇒ compteur terminal remis à 0 + replanification (jamais ACTIVE)', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1', { reconcileTerminalFailures: 3 })];
    const { service, provisioning } = makeService(db, MOTOR_SETTINGS, { d1: OBS.transitional() });

    const stats = await service.scanOnce(NOW);

    expect(stats.rescheduled).toBe(1);
    expect(db.rows[0]!.reconcileTerminalFailures).toBe(0);
    expect(provisioning.activateOrderAfterProof).not.toHaveBeenCalled();
  });

  it('UNKNOWN (NO_PROOF_AVAILABLE) ⇒ compteur terminal CONSERVÉ + replanification', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1', { reconcileTerminalFailures: 2 })];
    const { service, provisioning } = makeService(db, MOTOR_SETTINGS, { d1: OBS.unknown() });

    const stats = await service.scanOnce(NOW);

    expect(db.rows[0]!.reconcileTerminalFailures).toBe(2);
    expect(db.rows[0]!.status).toBe('DEPLOYING');
    expect(provisioning.activateOrderAfterProof).not.toHaveBeenCalled();
    expect(stats.failedTerminal).toBe(0);
  });

  it('NO_PROOF_AVAILABLE sans starvation : tentatives continues à backoff borné, jamais FAILED/ACTIVE', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1')];
    const { service, provisioning, evidence } = makeService(db, MOTOR_SETTINGS, { d1: OBS.unknown() });

    let now = NOW;
    let lastDelay = 0;
    for (let i = 0; i < 10; i += 1) {
      const stats = await service.scanOnce(now);
      const delay = db.rows[0]!.reconcileNextAt!.getTime() - now.getTime();
      lastDelay = delay;
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(MOTOR_SETTINGS.maxBackoffMs);
      now = new Date(now.getTime() + delay);
      expect(stats.failedTerminal).toBe(0);
      expect(stats.activated).toBe(0);
    }
    // Le palier lent est atteint : les dernières échéances tombent à maxBackoffMs.
    expect(lastDelay).toBe(MOTOR_SETTINGS.maxBackoffMs);
    expect(db.rows[0]!.status).toBe('DEPLOYING');
    expect(evidence.observe).toHaveBeenCalledTimes(10);
    expect(provisioning.activateOrderAfterProof).not.toHaveBeenCalled();
  });
});

// =========================================================================
// Séquences TERMINALES obligatoires (2 échecs consécutifs exploitables)
// =========================================================================
describe('ReconcileService — échecs terminaux et séquences (seuil 2)', () => {
  it(`seuil terminal == ${RECONCILE_TERMINAL_THRESHOLD}`, () => {
    expect(RECONCILE_TERMINAL_THRESHOLD).toBe(2);
  });

  it('TERMINAL→TERMINAL ⇒ FAILED au 2ᵉ, Order reste PROVISIONING (historique informatif UNIQUE)', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1')];
    const { service, provisioning } = makeService(db, MOTOR_SETTINGS, { d1: OBS.terminal() });

    const s1 = await service.scanOnce(NOW); // 1er TERMINAL → failures=1, replanifie
    expect(s1.failedTerminal).toBe(0);
    expect(s1.rescheduled).toBe(1);
    expect(db.rows[0]!.reconcileTerminalFailures).toBe(1);

    const s2 = await service.scanOnce(new Date(NOW.getTime() + 30_000)); // 2e → FAILED
    expect(s2.failedTerminal).toBe(1);
    expect(db.rows[0]!.status).toBe('FAILED');
    expect(db.rows[0]!.reconcileNextAt).toBeNull();
    expect(db.rows[0]!.reconcileTerminalFailures).toBe(2);
    expect(provisioning.activateOrderAfterProof).not.toHaveBeenCalled();

    // Historique informatif : l'Order reste PROVISIONING (jamais modifié).
    expect(db.orderHistoryCalls).toHaveLength(1);
    expect(db.orderHistoryCalls[0]!.data).toEqual(
      expect.objectContaining({ orderId: 'ord-d1', status: 'PROVISIONING' }),
    );
    // Un scan suivant ne re-sélectionne plus la row FAILED (aucun doublon d'historique).
    await service.scanOnce(new Date(NOW.getTime() + 120_000));
    expect(db.orderHistoryCalls).toHaveLength(1);
  });

  it('TERMINAL→TRANSITIONAL→TERMINAL ⇒ reset au milieu, JAMAIS FAILED sur le seul dernier', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1')];
    const { service, provisioning } = makeService(db, MOTOR_SETTINGS, {
      d1: [OBS.terminal(), OBS.transitional(), OBS.terminal()],
    });

    await service.scanOnce(NOW);
    await service.scanOnce(new Date(NOW.getTime() + 30_000));
    const s3 = await service.scanOnce(new Date(NOW.getTime() + 90_000));

    expect(s3.failedTerminal).toBe(0);
    expect(db.rows[0]!.status).toBe('DEPLOYING');
    expect(db.rows[0]!.reconcileTerminalFailures).toBe(1); // re-compté après le reset
    expect(db.orderHistoryCalls).toHaveLength(0);
    expect(provisioning.activateOrderAfterProof).not.toHaveBeenCalled();
  });

  it('TERMINAL→RUNNING non prouvé→TERMINAL ⇒ reset, JAMAIS FAILED au seul dernier', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1')];
    const { service } = makeService(db, MOTOR_SETTINGS, {
      d1: [OBS.terminal(), OBS.runningHttp(false), OBS.terminal()],
    });

    await service.scanOnce(NOW);
    await service.scanOnce(new Date(NOW.getTime() + 30_000));
    const s3 = await service.scanOnce(new Date(NOW.getTime() + 90_000));

    expect(s3.failedTerminal).toBe(0);
    expect(db.rows[0]!.status).toBe('DEPLOYING');
  });

  it('TERMINAL→UNKNOWN→TERMINAL ⇒ compteur CONSERVÉ, FAILED au 2ᵉ seulement', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1')];
    const { service } = makeService(db, MOTOR_SETTINGS, {
      d1: [OBS.terminal(), OBS.unknown(), OBS.terminal()],
    });

    await service.scanOnce(NOW);
    await service.scanOnce(new Date(NOW.getTime() + 30_000));
    const s3 = await service.scanOnce(new Date(NOW.getTime() + 90_000));

    expect(s3.failedTerminal).toBe(1);
    expect(db.rows[0]!.status).toBe('FAILED');
    expect(db.rows[0]!.reconcileTerminalFailures).toBe(2);
  });

  it('TERMINAL→NO_PROOF+UNKNOWN→TERMINAL ⇒ conservé, FAILED au 2ᵉ', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1')];
    const { service } = makeService(db, MOTOR_SETTINGS, {
      d1: [OBS.terminal(), OBS.unknown(), OBS.terminal()],
    });

    await service.scanOnce(NOW);
    await service.scanOnce(new Date(NOW.getTime() + 30_000));
    const s3 = await service.scanOnce(new Date(NOW.getTime() + 90_000));

    expect(s3.failedTerminal).toBe(1);
    expect(db.rows[0]!.status).toBe('FAILED');
  });
});

// =========================================================================
// Gestion des exceptions — jamais d'état fabriqué, lease = protection
// =========================================================================
describe('ReconcileService — exceptions et échecs', () => {
  it('exception d’observation ⇒ conservé DEPLOYING, compteur terminal PRÉSERVÉ, replanifié, jamais ACTIVE', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1', { reconcileTerminalFailures: 2 })];
    const { service, evidence, provisioning } = makeService(db, MOTOR_SETTINGS, {});
    evidence.observe.mockRejectedValue(new Error('panel down'));

    const stats = await service.scanOnce(NOW);

    expect(stats.errors).toBe(1);
    expect(db.rows[0]!.status).toBe('DEPLOYING');
    expect(db.rows[0]!.reconcileTerminalFailures).toBe(2); // préservé
    expect(db.rows[0]!.reconcileNextAt).toEqual(new Date(NOW.getTime() + 30_000));
    expect(provisioning.activateOrderAfterProof).not.toHaveBeenCalled();
  });

  it('échec d’activation ⇒ errors++, conservé, replanifié (le lease reste la protection)', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1')];
    const { service, provisioning } = makeService(db, MOTOR_SETTINGS, { d1: OBS.runningHealthy() });
    provisioning.activateOrderAfterProof.mockRejectedValue(new Error('tx rollback'));

    const stats = await service.scanOnce(NOW);

    expect(stats.errors).toBe(1);
    expect(stats.activated).toBe(0);
    expect(db.rows[0]!.status).toBe('DEPLOYING');
    expect(db.rows[0]!.reconcileNextAt).not.toBeNull();
  });

  it('échec du write de replanification ⇒ errors++, lease du claim conservé (aucun ACTIVE/FAILED fabriqué)', async () => {
    const db = new MiniDb();
    db.rows = [dueRow('d1')];
    db.throwOnRescheduleWrites = true;
    const { service, provisioning } = makeService(db, MOTOR_SETTINGS, { d1: OBS.unknown() });

    const stats = await service.scanOnce(NOW);

    expect(stats.errors).toBe(1);
    expect(stats.rescheduled).toBe(0);
    // Le lease posé par le claim (now + leaseMs) protège l'échéance jusqu'au scan suivant.
    expect(db.rows[0]!.reconcileNextAt).toEqual(new Date(NOW.getTime() + MOTOR_SETTINGS.leaseMs));
    expect(db.rows[0]!.status).toBe('DEPLOYING');
    expect(provisioning.activateOrderAfterProof).not.toHaveBeenCalled();
  });

  it('structure : AUCUNE boucle automatique au boot (pas de onModuleInit/onApplicationBootstrap)', async () => {
    const db = new MiniDb();
    const { service } = makeService(db);
    expect((service as unknown as { onModuleInit?: unknown }).onModuleInit).toBeUndefined();
    expect((service as unknown as { onApplicationBootstrap?: unknown }).onApplicationBootstrap).toBeUndefined();
  });

  it('structure : le moteur n’expose AUCUNE dépendance panel (transports/Coolify) — uniquement les 4 contrats', async () => {
    const db = new MiniDb();
    const { service } = makeService(db);
    const anyService = service as unknown as Record<string, unknown>;
    expect(anyService).not.toHaveProperty('panelFactory');
    expect(anyService).not.toHaveProperty('transport');
    expect(anyService).not.toHaveProperty('httpAvailability');
    // Les quatre dépendances contractuelles sont bien présentes.
    expect(anyService.prisma).toBeDefined();
    expect(anyService.settings).toBeDefined();
    expect(anyService.evidence).toBeDefined();
    expect(anyService.provisioning).toBeDefined();
  });
});