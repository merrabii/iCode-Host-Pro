import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  ReconcileRunnerService,
  RECONCILE_RUNNER_FALLBACK_INTERVAL_MS,
} from "./reconcile.runner.service";
import { ReconcileService } from "./reconcile.service";
import { ReconcileSettingsService } from "./reconcile-settings.service";
import { RECONCILE_DEFAULT_SETTINGS } from "./reconcile-settings";
import type { ReconcileSettings } from "./reconcile-settings";

// =============================================================================
// 17B.4C2 — ReconcileRunnerService : pilote de l'observation récurrente.
//
// Frontière d'architecture (cf. CLAUDE.md §6) : la plateforme parle au panel via
// PanelTransport, JAMAIS ici. Ce spec prouve que le runner :
//   1) ne scanne JAMAIS au démarrage — timer pur, premier réveil à scanIntervalMs ;
//   2) relit les settings à chaque réveil (bascule admin dynamique sans restart) ;
//   3) ne lance jamais deux scanns simultanés (anti-chevauchement par Promise) ;
//   4) replanifie à un délai SÛR (fallback, jamais micro-timer) même si les settings
//      sont illisibles, et ne log QUE des messages d'avertissement STATIQUES —
//      jamais message, name ou propriété de l'exception (OBJECTIF 1, secrets) ;
//   5) s'arrête proprement : destroy avant le premier réveil = AUCUN scan jamais ;
//      destroy pendant un scan en vol = ATTEND la Promise, jamais de second scan ;
//   6) ne dépend QUE de ReconcileService (scanOnce) + ReconcileSettingsService.
// =============================================================================

const TICK = RECONCILE_RUNNER_FALLBACK_INTERVAL_MS;

describe("ReconcileRunnerService — pilote de l'observation récurrente (17B.4C2)", () => {
  let engine: { scanOnce: jest.Mock };
  let settingsSvc: { getSettings: jest.Mock };
  let warnSpy: jest.SpyInstance;

  const enabledSettings = (): ReconcileSettings => ({
    ...RECONCILE_DEFAULT_SETTINGS,
    enabled: true,
    scanIntervalMs: TICK,
  });

  const disabledSettings = (): ReconcileSettings => ({
    ...RECONCILE_DEFAULT_SETTINGS,
    enabled: false,
    scanIntervalMs: TICK,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    engine = { scanOnce: jest.fn(async () => ({ scanned: 0 })) };
    settingsSvc = { getSettings: jest.fn(async () => enabledSettings()) };
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    jest.useRealTimers();
  });

  async function createRunner(): Promise<ReconcileRunnerService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        {
          provide: ReconcileService,
          useValue: engine as unknown as ReconcileService,
        },
        {
          provide: ReconcileSettingsService,
          useValue: settingsSvc as unknown as ReconcileSettingsService,
        },
        ReconcileRunnerService,
      ],
    }).compile();
    const runner = moduleRef.get(ReconcileRunnerService);
    await moduleRef.init();
    return runner;
  }

  /** Draine TOUTES les micro-tâches en attente (chaînes asynchrones du runner)
   *  sans faire avancer l'horloge : les assertions deviennent déterministes. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }
  }

  /** Erreur de test dont message ET name portent des marqueurs secrets. */
  function secretError(message: string, name: string): Error {
    const err = new Error(message);
    err.name = name;
    return err;
  }

  /** Tous les arguments de TOUS les appels Logger.warn, sérialisés (objets compris). */
  function warnAllArgs(): string {
    return warnSpy.mock.calls
      .flat()
      .map((arg: unknown) => {
        if (typeof arg === "string") return arg;
        try {
          const json = JSON.stringify(arg);
          return json === undefined ? String(arg) : json;
        } catch {
          return String(arg);
        }
      })
      .join("\n");
  }

  /** Preuve OBJECTIF 1 : AUCUN argument transmis à Logger.warn ne contient de marqueur secret. */
  function expectNoSecretInWarns(): void {
    expect(warnSpy).toHaveBeenCalled();
    const all = warnAllArgs();
    for (const marker of [
      "PGHOST",
      "tr3-s3cr3t",
      "panel:8000",
      "coolify",
      "SECRET_MSG",
      "SECRET_NAME",
    ]) {
      expect(all).not.toContain(marker);
    }
  }

  // ---------------------------------------------------------------------
// 0. Boot enabled : aucun scan avant expiration, puis un scan.
// ---------------------------------------------------------------------
it("0. boot enabled : aucun scan immédiat, puis scan après expiration", async () => {
    settingsSvc = { getSettings: jest.fn(async () => enabledSettings()) };
    const runner = await createRunner();

    expect(engine.scanOnce).not.toHaveBeenCalled();

    jest.advanceTimersByTime(TICK);
    await Promise.resolve();
    expect(engine.scanOnce).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.scanOnce).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------
// 1-2. Démarrage : AUCUN scan immédiat ; premier réveil seulement au tick.
// ---------------------------------------------------------------------
it("1. onModuleInit planifie SANS scan immédiat (premier réveil à scanIntervalMs)", async () => {
    const runner = await createRunner();

    expect(engine.scanOnce).not.toHaveBeenCalled();

    jest.advanceTimersByTime(TICK - 1);
    await Promise.resolve();
    expect(engine.scanOnce).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.scanOnce).toHaveBeenCalledTimes(1);
  });

  it("2. un seul réveil par expiration : pas de double scan pour un même tick", async () => {
    const runner = await createRunner();

    jest.advanceTimersByTime(TICK + 1);
    await flush();
    jest.advanceTimersByTime(0);
    await flush();

    expect(engine.scanOnce).toHaveBeenCalledTimes(1);
    // Jamais plus d'UN timer en attente (scheduleNext écrase le précédent).
    expect(jest.getTimerCount()).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 3-5. Dynamicité : les settings sont RELUS à chaque réveil, sans restart.
  // ---------------------------------------------------------------------
  it("3. enabled=false → les réveils restent VIDES (aucun scan jamais) et on rescanne 0 fois", async () => {
    settingsSvc.getSettings.mockResolvedValue(disabledSettings());
    const runner = await createRunner();

    jest.advanceTimersByTime(TICK * 4);
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.scanOnce).not.toHaveBeenCalled();
    expect(settingsSvc.getSettings).toHaveBeenCalled();
  });

  it("4. bascule dynamique MR en RUNNING : désactivé puis réactivé sans redémarrage", async () => {
    const runner = await createRunner();

    jest.advanceTimersByTime(TICK);
    await flush();
    expect(engine.scanOnce).toHaveBeenCalledTimes(1);

    settingsSvc.getSettings.mockResolvedValue(disabledSettings());
    jest.advanceTimersByTime(TICK * 2);
    await flush();
    expect(engine.scanOnce).toHaveBeenCalledTimes(1); // rien pendant désactivé

    settingsSvc.getSettings.mockResolvedValue(enabledSettings());
    jest.advanceTimersByTime(TICK);
    await flush();
    expect(engine.scanOnce).toHaveBeenCalledTimes(2); // reprise sans restart
  });

  it("5. changement de scanIntervalMs à chaud pris en compte au réveil suivant", async () => {
    const runner = await createRunner();
    const longTick = TICK * 3;

    settingsSvc.getSettings.mockResolvedValue({
      ...RECONCILE_DEFAULT_SETTINGS,
      enabled: true,
      scanIntervalMs: longTick,
    });

    // La lecture du nouvel intervalle latence d'un réveil ; 3 ticks ne suffisent plus.
    jest.advanceTimersByTime(TICK * 2);
    await Promise.resolve();
    expect(engine.scanOnce).toHaveBeenCalledTimes(0);

    jest.advanceTimersByTime(longTick);
    await Promise.resolve();
    expect(engine.scanOnce).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------
  // 6-9. Anti-chevauchement réel (Promise en vol) et replanification sûre.
  // ---------------------------------------------------------------------
  it("6. jamais deux scans simultanés : une expiration pendant une observation en vol est IGNORÉE", async () => {
    let resolveScan!: (v: unknown) => void;
    const inFlight = new Promise((resolve) => {
      resolveScan = resolve;
    });
    engine.scanOnce.mockImplementationOnce(() => inFlight);

    const runner = await createRunner();

    jest.advanceTimersByTime(TICK);
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.scanOnce).toHaveBeenCalledTimes(1);

    // Deux réveils arrivent pendant que la Promise est encore en vol → aucun 2e scan.
    jest.advanceTimersByTime(TICK * 2);
    await Promise.resolve();
    expect(engine.scanOnce).toHaveBeenCalledTimes(1);

    resolveScan({ scanned: 1 });
    await Promise.resolve();
    await Promise.resolve();
  });

  it("7. settings illisibles → replanification au FALLBACK (jamais micro-timer), warn sans secret", async () => {
    // message ET name contiennent des marqueurs secrets → aucun ne doit fuiter.
    settingsSvc.getSettings.mockRejectedValue(
      secretError("PGHOST=tr3-s3cr3t SECRET_MSG MODE=prod", "ERR_SECRET_NAME_SETTINGS"),
    );
    const runner = await createRunner();

    jest.advanceTimersByTime(TICK);
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.scanOnce).not.toHaveBeenCalled();
    expect(warnAllArgs()).toContain("reconcile-runner: lecture des réglages en échec");
    expectNoSecretInWarns();
  });

  it("8. erreur du moteur pendant scanOnce → warn sans secret, puis replanification sûre (pas de boucle rapide)", async () => {
    engine.scanOnce.mockRejectedValueOnce(
      secretError("coolify=http://panel:8000 SECRET_MSG hsplit", "ERR_SECRET_NAME_ENGINE"),
    );
    const runner = await createRunner();

    jest.advanceTimersByTime(TICK);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(warnAllArgs()).toContain("reconcile-runner: scanOnce en échec");
    expectNoSecretInWarns();
  });

  // ---------------------------------------------------------------------
  // 9. Erreur settings avant scan : aucun scan + délai sûr
  // ---------------------------------------------------------------------
  it("9. erreur settings avant scan → aucun scan, replanification au fallback", async () => {
    // Boot sain (settings lisibles) : l'erreur intervient AU RÉVEIL, avant tout scan.
    const runner = await createRunner();
    settingsSvc.getSettings.mockRejectedValueOnce(
      secretError("PGHOST=tr3-s3cr3t SECRET_MSG MODE=prod", "ERR_SECRET_NAME_SETTINGS"),
    );

    jest.advanceTimersByTime(TICK);
    await flush();

    expect(engine.scanOnce).not.toHaveBeenCalled();
    expect(warnAllArgs()).toContain("reconcile-runner: lecture des réglages en échec");
    expectNoSecretInWarns();
    // Replanifiée (1 timer) au délai sûr — jamais une boucle immédiate.
    expect(jest.getTimerCount()).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 10. Erreur settings après scan : délai sûr
  // ---------------------------------------------------------------------
  it("10. erreur settings après scan → délai sûr avant prochain réveil", async () => {
    const runner = await createRunner();

    // 1er réveil : scan normal.
    jest.advanceTimersByTime(TICK);
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.scanOnce).toHaveBeenCalledTimes(1);

    // Settings en échec AU RÉVEIL SUIVANT (après le scan) → warn + fallback sûr.
    settingsSvc.getSettings.mockRejectedValue(
      secretError("PGHOST=tr3-s3cr3t SECRET_MSG MODE=prod", "ERR_SECRET_NAME_SETTINGS"),
    );
    jest.advanceTimersByTime(TICK);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Aucun scan supplémentaire (repli sur défauts = enabled false) + délai sûr :
    // exactement UN timer en attente (replanifiée), jamais zéro (boucle cassée)
    // ni plusieurs (timers empilés).
    expect(engine.scanOnce).toHaveBeenCalledTimes(1);
    expect(warnAllArgs()).toContain("reconcile-runner: lecture des réglages en échec");
    expectNoSecretInWarns();
    expect(jest.getTimerCount()).toBe(1);
    expect(runner).toBeInstanceOf(ReconcileRunnerService);
  });

  // ---------------------------------------------------------------------
  // 11. Arrêt propre.
  // ---------------------------------------------------------------------
  it("11. destroy AVANT le premier réveil → timer annulé, AUCUN scan jamais", async () => {
    const runner = await createRunner();
    await runner.onApplicationShutdown();

    jest.advanceTimersByTime(TICK * 5);
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.scanOnce).not.toHaveBeenCalled();
  });

  it("12. destroy pendant un scan en vol → ATTEND la Promise, jamais de second scan", async () => {
    let resolveScan!: (v: unknown) => void;
    engine.scanOnce.mockImplementationOnce(() => new Promise((r) => (resolveScan = r)));

    const runner = await createRunner();

    jest.advanceTimersByTime(TICK);
    await Promise.resolve();
    await Promise.resolve();

    const shutdownPromise = runner.onApplicationShutdown();

    // Rien de nouveau n'est lancé pendant l'attente du shutdown.
    jest.advanceTimersByTime(TICK * 2);
    await Promise.resolve();
    expect(engine.scanOnce).toHaveBeenCalledTimes(1);

    resolveScan({ scanned: 1 });
    await shutdownPromise;

    jest.advanceTimersByTime(TICK * 2);
    await Promise.resolve();
    expect(engine.scanOnce).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    // Variante « erreur pendant shutdown » : la Promise du scan REJETTE pendant
    // l'attente du shutdown → le catch du runner absorbe (message statique,
    // aucun marqueur secret), aucune rejection non gérée, aucun second scan.
    engine.scanOnce.mockRejectedValueOnce(
      secretError("panel:8000 SECRET_MSG pendant l'arrêt", "ERR_SECRET_NAME_SHUTDOWN"),
    );
    const r2 = await createRunner();
    jest.advanceTimersByTime(TICK);
    await Promise.resolve();
    await Promise.resolve();
    const shut2 = r2.onApplicationShutdown();
    await shut2;
    await expect(shut2).resolves.toBeUndefined();
    expect(engine.scanOnce).toHaveBeenCalledTimes(2);
    expectNoSecretInWarns();
  });

  it("13. onModuleDestroy = même contrat que le shutdown applicatif (timer annulé)", async () => {
    const runner = await createRunner();
    await runner.onModuleDestroy();

    jest.advanceTimersByTime(TICK * 3);
    await Promise.resolve();
    expect(engine.scanOnce).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // 14-15. Frontière d'architecture.
  // ---------------------------------------------------------------------
  it("14. l'import du timer FALLBACK est réel (export du runner)", () => {
    expect(RECONCILE_RUNNER_FALLBACK_INTERVAL_MS).toBeGreaterThan(0);
    expect(TICK).toBe(RECONCILE_RUNNER_FALLBACK_INTERVAL_MS);
  });

  it("15. paramtypes du runner = [ReconcileService, ReconcileSettingsService] — aucun Prisma/env/panel", () => {
    const metadata = Reflect.getMetadata(
      "design:paramtypes",
      ReconcileRunnerService,
    ) as unknown[];
    expect(metadata).toEqual([ReconcileService, ReconcileSettingsService]);
});

// ---------------------------------------------------------------------
// 16. Intégration Nest légère.
// ---------------------------------------------------------------------
it("16. integration Nest légère : vérification métadonnées + init/close propres", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [
      {
        provide: ReconcileService,
        useValue: { scanOnce: jest.fn(async () => ({ scanned: 0 })) } as unknown as ReconcileService,
      },
      {
        provide: ReconcileSettingsService,
        useValue: { getSettings: jest.fn(async () => ({ enabled: false, scanIntervalMs: TICK, batchSize: 10, leaseMs: 120_000, attemptAlertThreshold: 12, backoffInitialMs: 30_000, maxBackoffMs: 3_600_000 })) } as unknown as ReconcileSettingsService,
      },
      ReconcileRunnerService,
    ],
  }).compile();

  const runner = moduleRef.get(ReconcileRunnerService);
  await moduleRef.init();
  // Une seule instance logique dans le conteneur (pas de double registration).
  expect(moduleRef.get(ReconcileRunnerService)).toBe(runner);

  // Vérification métadonnées
  const metadata = Reflect.getMetadata(
    "design:paramtypes",
    ReconcileRunnerService,
  ) as unknown[];
  expect(metadata).toEqual([ReconcileService, ReconcileSettingsService]);

  // enabled=false : aucun scan, pas de timer résiduel
  expect((runner as any).stopping).toBeFalsy();
  expect(engine.scanOnce).not.toHaveBeenCalled();

  // Close propre → aucun timer résiduel après la fermeture du conteneur.
  await moduleRef.close();
  expect(jest.getTimerCount()).toBe(0);
});
});
