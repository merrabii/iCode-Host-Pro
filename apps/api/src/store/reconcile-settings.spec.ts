import {
  RECONCILE_DEFAULT_SETTINGS,
  RECONCILE_ENV_KEYS,
  RECONCILE_SETTINGS_BOUNDS,
  resolveReconcileSettings,
  validateReconcileSettings,
} from './reconcile-settings';

// 17B.4B — contrat de configuration du moteur (module PUR, aucune Nest).
// Invariants : défauts figés ; env absente → défaut SILENCIEUX ; env invalide →
// défaut + warn (jamais de crash) ; bornes strictes ; paire max>=initial.
describe('ReconcileSettings — résolution (env → défauts)', () => {
  const warns: string[] = [];
  const warn = (m: string) => warns.push(m);

  function env(over: Record<string, string>): Record<string, string | undefined> {
    return { ...over };
  }

  beforeEach(() => warns.splice(0));

  it('défauts — aucune variable ⇒ RECONCILE_DEFAULT_SETTINGS, aucun warn, moteur désactivé', () => {
    const out = resolveReconcileSettings({}, warn);
    expect(out).toEqual(RECONCILE_DEFAULT_SETTINGS);
    expect(out.enabled).toBe(false);
    expect(warns).toHaveLength(0);
  });

  it('enabled — true/1 active, false/0 désactive (booléens normalisés, insensible à la casse)', () => {
    expect(resolveReconcileSettings(env({ [RECONCILE_ENV_KEYS.enabled]: 'true' })).enabled).toBe(true);
    expect(resolveReconcileSettings(env({ [RECONCILE_ENV_KEYS.enabled]: 'TRUE' })).enabled).toBe(true);
    expect(resolveReconcileSettings(env({ [RECONCILE_ENV_KEYS.enabled]: '1' })).enabled).toBe(true);
    expect(resolveReconcileSettings(env({ [RECONCILE_ENV_KEYS.enabled]: 'false' })).enabled).toBe(false);
    expect(resolveReconcileSettings(env({ [RECONCILE_ENV_KEYS.enabled]: '0' })).enabled).toBe(false);
    expect(warns).toHaveLength(0);
  });

  it('enabled invalide ⇒ défaut false + warn (jamais activé par accident)', () => {
    const out = resolveReconcileSettings(env({ [RECONCILE_ENV_KEYS.enabled]: 'oui' }), warn);
    expect(out.enabled).toBe(false);
    expect(warns.some((m) => m.includes('RECONCILE_ENABLED'))).toBe(true);
  });

  it('valeurs numériques valides dans les bornes ⇒ utilisées', () => {
    const out = resolveReconcileSettings(
      env({
        [RECONCILE_ENV_KEYS.scanIntervalMs]: '45000',
        [RECONCILE_ENV_KEYS.batchSize]: '25',
        [RECONCILE_ENV_KEYS.leaseMs]: '300000',
        [RECONCILE_ENV_KEYS.attemptAlertThreshold]: '4',
        [RECONCILE_ENV_KEYS.backoffInitialMs]: '60000',
        [RECONCILE_ENV_KEYS.maxBackoffMs]: '7200000',
      }),
    );
    expect(out).toEqual({
      ...RECONCILE_DEFAULT_SETTINGS,
      scanIntervalMs: 45000,
      batchSize: 25,
      leaseMs: 300000,
      attemptAlertThreshold: 4,
      backoffInitialMs: 60000,
      maxBackoffMs: 7200000,
    });
    expect(warns).toHaveLength(0);
  });

  it('entrée non entière ⇒ défaut + warn (fallback sûr, jamais de valeur forgeable)', () => {
    const out = resolveReconcileSettings(env({ [RECONCILE_ENV_KEYS.batchSize]: 'abc' }), warn);
    expect(out.batchSize).toBe(RECONCILE_DEFAULT_SETTINGS.batchSize);
    expect(warns.some((m) => m.includes('RECONCILE_BATCH_SIZE'))).toBe(true);
  });

  it('hors bornes ⇒ défaut + warn (min/max strictes du contrat 17B.4B)', () => {
    const below = resolveReconcileSettings(env({ [RECONCILE_ENV_KEYS.leaseMs]: '1000' }), warn);
    const above = resolveReconcileSettings(env({ [RECONCILE_ENV_KEYS.batchSize]: '999' }), warn);
    expect(below.leaseMs).toBe(RECONCILE_DEFAULT_SETTINGS.leaseMs);
    expect(above.batchSize).toBe(RECONCILE_DEFAULT_SETTINGS.batchSize);
    expect(warns.some((m) => m.includes('hors bornes'))).toBe(true);
  });

  it('paire invalide maxBackoff<backoffInitial ⇒ les deux réappliqués aux défauts + warn', () => {
    const out = resolveReconcileSettings(
      env({
        [RECONCILE_ENV_KEYS.backoffInitialMs]: '300000',
        [RECONCILE_ENV_KEYS.maxBackoffMs]: '60000',
      }),
      warn,
    );
    expect(out.backoffInitialMs).toBe(RECONCILE_DEFAULT_SETTINGS.backoffInitialMs);
    expect(out.maxBackoffMs).toBe(RECONCILE_DEFAULT_SETTINGS.maxBackoffMs);
    expect(warns.some((m) => m.includes('maxBackoffMs'))).toBe(true);
  });

  it('borne minimale leaseMs ≥ 30 s > durée normale max d’une observation (garantie anti-encombrement)', () => {
    expect(RECONCILE_SETTINGS_BOUNDS.leaseMs.min).toBe(30_000);
    expect(RECONCILE_SETTINGS_BOUNDS.leaseMs.min).toBeGreaterThan(16_000);
  });
});

describe('ReconcileSettings — validateReconcileSettings', () => {
  it('jeu propre ⇒ aucun problème', () => {
    expect(validateReconcileSettings(RECONCILE_DEFAULT_SETTINGS)).toHaveLength(0);
  });

  it('valeur hors bornes ⇒ problème listé', () => {
    const issues = validateReconcileSettings({ ...RECONCILE_DEFAULT_SETTINGS, leaseMs: 5 });
    expect(issues.some((i) => i.includes('leaseMs'))).toBe(true);
  });

  it('paire max<initial ⇒ problème listé', () => {
    const issues = validateReconcileSettings({
      ...RECONCILE_DEFAULT_SETTINGS,
      backoffInitialMs: 1_000_000,
      maxBackoffMs: 500_000,
    });
    expect(issues.some((i) => i.includes('maxBackoffMs') && i.includes('backoffInitialMs'))).toBe(true);
  });

  it('non-entier/non-nombre ⇒ problème listé', () => {
    const issues = validateReconcileSettings({ ...RECONCILE_DEFAULT_SETTINGS, batchSize: 2.5 as never });
    expect(issues.some((i) => i.includes('batchSize'))).toBe(true);
  });
});