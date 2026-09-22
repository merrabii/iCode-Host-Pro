/**
 * 17B.4B/4C1 — contrat de configuration du moteur de réconciliation.
 *
 * Source de vérité des DÉFAUTS et des BORNES du moteur. Usages :
 *  - `ReconcileSettingsService` résout base (overrides DB) → env (via
 *    ConfigService, JAMAIS process.env côté moteur) → défauts, avec fallback sûr
 *    + warn sur valeur invalide, à CHAQUE appel (aucun cache persistant) ;
 *  - `loadAppConfig` (config/configuration.ts) s'appuie sur les MÊMES constantes
 *    pour exposer les clés typées (source unique).
 *
 * Module PUR (aucune import Nest) : testable sans Nest.
 */

export interface ReconcileSettings {
  /** false par défaut — le moteur est inactif jusqu'au GO live (17B.4C+). */
  enabled: boolean;
  /** Intervalle de scan (un futur timer dynamique 17B.4C relira les settings). */
  scanIntervalMs: number;
  /** Taille maximale du batch de candidats par cycle. */
  batchSize: number;
  /** Durée du lease/claim (borne >= 30 s > durée normale max d'une observation). */
  leaseMs: number;
  /** Seuil d'ALERTE des tentatives (mode lent/monitoring) — jamais un arrêt, jamais FAILED. */
  attemptAlertThreshold: number;
  /** Délai de backoff initial (n=1). */
  backoffInitialMs: number;
  /** Délai de backoff maximal (palier lent). */
  maxBackoffMs: number;
}

export const RECONCILE_DEFAULT_SETTINGS: ReconcileSettings = {
  enabled: false,
  scanIntervalMs: 30_000,
  batchSize: 10,
  leaseMs: 120_000,
  attemptAlertThreshold: 12,
  backoffInitialMs: 30_000,
  maxBackoffMs: 3_600_000,
};

/** Bornes obligatoires (rapports 17B.4A/B). leaseMs min 30_000 supere la duree
 *  normale d'une observation (panel <= 8 s + HTTP <= 8 s + marges) — la garantie
 *  « leaseMs > durée max normale de vérification » est satisfaite par la borne. */
export const RECONCILE_SETTINGS_BOUNDS = {
  scanIntervalMs: { min: 10_000, max: 900_000 },
  batchSize: { min: 1, max: 100 },
  leaseMs: { min: 30_000, max: 1_800_000 },
  attemptAlertThreshold: { min: 1, max: 100 },
  backoffInitialMs: { min: 10_000, max: 1_800_000 },
  maxBackoffMs: { min: 60_000, max: 86_400_000 },
} as const;

const NUMERIC_KEYS: ReadonlyArray<
  'scanIntervalMs' | 'batchSize' | 'leaseMs' | 'attemptAlertThreshold' | 'backoffInitialMs' | 'maxBackoffMs'
> = [
  'scanIntervalMs',
  'batchSize',
  'leaseMs',
  'attemptAlertThreshold',
  'backoffInitialMs',
  'maxBackoffMs',
];

/** Noms des variables d'environnement (lues via ConfigService, pas process.env). */
export const RECONCILE_ENV_KEYS: Record<keyof ReconcileSettings, string> = {
  enabled: 'RECONCILE_ENABLED',
  scanIntervalMs: 'RECONCILE_SCAN_INTERVAL_MS',
  batchSize: 'RECONCILE_BATCH_SIZE',
  leaseMs: 'RECONCILE_LEASE_MS',
  attemptAlertThreshold: 'RECONCILE_ATTEMPT_ALERT_THRESHOLD',
  backoffInitialMs: 'RECONCILE_BACKOFF_INITIAL_MS',
  maxBackoffMs: 'RECONCILE_MAX_BACKOFF_MS',
};

/** Résolution déterministe : env → défauts. Chaque valeur env invalide (absente,
 *  non entière, hors bornes, booléen inconnu) bascule sur le défaut et produit un
 *  avertissement (sans secret) passé au callback `warn` (Logger du service).
 *  Police retenue et testée : fallback sûr + warn, JAMAIS de crash sur une env. */
export function resolveReconcileSettings(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = () => {},
): ReconcileSettings {
  const base: ReconcileSettings = { ...RECONCILE_DEFAULT_SETTINGS };

  const rawEnabled = env[RECONCILE_ENV_KEYS.enabled];
  if (rawEnabled !== undefined && rawEnabled.trim() !== '') {
    const lower = rawEnabled.trim().toLowerCase();
    if (lower === 'true' || lower === '1') {
      base.enabled = true;
    } else if (lower === 'false' || lower === '0') {
      base.enabled = false;
    } else {
      warn(`RECONCILE_ENABLED=« ${rawEnabled.trim()} » invalide -> défaut false`);
    }
  }

  for (const key of NUMERIC_KEYS) {
    const raw = env[RECONCILE_ENV_KEYS[key]];
    if (raw === undefined || raw.trim() === '') continue;
    const num = Number(raw.trim());
    if (!Number.isInteger(num)) {
      warn(`${RECONCILE_ENV_KEYS[key]}=« ${raw.trim()} » non entier -> défaut ${RECONCILE_DEFAULT_SETTINGS[key]}`);
      continue;
    }
    const bounds = RECONCILE_SETTINGS_BOUNDS[key];
    if (num < bounds.min || num > bounds.max) {
      warn(`${RECONCILE_ENV_KEYS[key]}=${num} hors bornes [${bounds.min},${bounds.max}] -> défaut ${RECONCILE_DEFAULT_SETTINGS[key]}`);
      continue;
    }
    base[key] = num;
  }

  if (base.maxBackoffMs < base.backoffInitialMs) {
    warn(`RECONCILE_* : maxBackoffMs(${base.maxBackoffMs}) < backoffInitialMs(${base.backoffInitialMs}) -> défauts réappliqués`);
    base.maxBackoffMs = RECONCILE_DEFAULT_SETTINGS.maxBackoffMs;
    base.backoffInitialMs = RECONCILE_DEFAULT_SETTINGS.backoffInitialMs;
  }

  return base;
}

/** Validation pure d'un jeu de settings : renvoie les problèmes (bornes + paire),
 *  vide si tout est conforme. Utilisée par les tests et par les futurs validations
 *  admin (17B.4D). */
export function validateReconcileSettings(settings: ReconcileSettings): string[] {
  const issues: string[] = [];
  for (const key of NUMERIC_KEYS) {
    const value = settings[key];
    const bounds = RECONCILE_SETTINGS_BOUNDS[key];
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < bounds.min ||
      value > bounds.max
    ) {
      issues.push(`${key}=${String(value)} hors bornes [${bounds.min},${bounds.max}]`);
    }
  }
  if (settings.maxBackoffMs < settings.backoffInitialMs) {
    issues.push(`maxBackoffMs(${settings.maxBackoffMs}) < backoffInitialMs(${settings.backoffInitialMs})`);
  }
  return issues;
}

// ── 17B.4C1 — overrides admin persistés (singleton ReconcileSetting) ──────────

/** Id fixe déterministe de la ligne singleton (convention BrandConfig
 *  « id: 'brand' ») : jamais plusieurs lignes actives, upsert sécurisé en
 *  concurrence. */
export const RECONCILE_SETTING_SINGLETON_ID = 'reconcile';

/** Colonnes nullables de ReconcileSetting = overrides admin. null/absent =
 *  retour au fallback env/défaut. */
export interface ReconcileSettingOverrides {
  enabled?: boolean | null;
  scanIntervalMs?: number | null;
  batchSize?: number | null;
  leaseMs?: number | null;
  attemptAlertThreshold?: number | null;
  backoffInitialMs?: number | null;
  maxBackoffMs?: number | null;
}

/** Clés d'override dans l'ordre du contrat (stable pour les rapports d'audit). */
export const RECONCILE_OVERRIDE_KEYS: ReadonlyArray<keyof ReconcileSettingOverrides> = [
  'enabled',
  'scanIntervalMs',
  'batchSize',
  'leaseMs',
  'attemptAlertThreshold',
  'backoffInitialMs',
  'maxBackoffMs',
];

export type ReconcileSource = 'DATABASE' | 'ENV' | 'DEFAULT';

export const RECONCILE_SOURCES: Record<keyof ReconcileSettings, ReconcileSource> = {
  enabled: 'DEFAULT',
  scanIntervalMs: 'DEFAULT',
  batchSize: 'DEFAULT',
  leaseMs: 'DEFAULT',
  attemptAlertThreshold: 'DEFAULT',
  backoffInitialMs: 'DEFAULT',
  maxBackoffMs: 'DEFAULT',
};

export interface ReconcileResolved {
  settings: ReconcileSettings;
  sources: Record<keyof ReconcileSettings, ReconcileSource>;
}

/** Résout un champ comme le ferait `resolveReconcileSettings` (env → défauts) :
 *  null si absent/non applicable pour la source ENV. */
function envParsedValue(
  key: keyof ReconcileSettings,
  env: Record<string, string | undefined>,
): boolean | number | null {
  const raw = env[RECONCILE_ENV_KEYS[key]];
  if (raw === undefined || raw.trim() === '') return null;
  if (key === 'enabled') {
    const lower = raw.trim().toLowerCase();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0') return false;
    return null;
  }
  const num = Number(raw.trim());
  if (!Number.isInteger(num)) return null;
  const bounds = RECONCILE_SETTINGS_BOUNDS[key as keyof typeof RECONCILE_SETTINGS_BOUNDS];
  if (num < bounds.min || num > bounds.max) return null;
  return num;
}

/**
 * Résolution complète DB → env → défauts avec la SOURCE EXACTE de chaque valeur
 * (DATABASE | ENV | DEFAULT). Pure et déterministe : réutilise
 * `resolveReconcileSettings` puis `applyReconcileOverrides`, et déduit la source
 * champ par champ à partir des mêmes entrées. Une paire invalide (DB ou env)
 * retombe sur les défauts → source DEFAULT pour la paire.
 */
export function resolveReconcileSettingsFull(
  env: Record<string, string | undefined>,
  overrides: ReconcileSettingOverrides,
  warn: (message: string) => void = () => {},
): ReconcileResolved {
  const settings = applyReconcileOverrides(resolveReconcileSettings(env, warn), overrides, warn);
  const sources: Record<keyof ReconcileSettings, ReconcileSource> = { ...RECONCILE_SOURCES };
  for (const key of Object.keys(sources) as Array<keyof ReconcileSettings>) {
    const ov = overrides[key];
    if (ov !== undefined && ov !== null && settings[key] === ov) {
      sources[key] = 'DATABASE';
      continue;
    }
    const parsed = envParsedValue(key, env);
    if (parsed !== null && settings[key] === parsed) {
      sources[key] = 'ENV';
    }
  }
  return { settings, sources };
}

/**
 * Applique des overrides DB validés sur des settings déjà résolus env → défauts
 * (sortie de `resolveReconcileSettings`). Champ par champ :
 *  - override non null VALIDE → priorité ;
 *  - override null/absent → env/défaut conservé ;
 *  - override INVALIDE (non entier, hors bornes) → warn (sans secret) + fallback ;
 *  - paire invalide (maxBackoff < initial, après application) → warn + défauts
 *    de la paire réappliqués.
 * Aucune valeur hors bornes n'est jamais acceptée silencieusement. Pur : aucune
 * lecture d'env/DB ici (l'appelant fournit `base` et `overrides`).
 */
export function applyReconcileOverrides(
  base: ReconcileSettings,
  overrides: ReconcileSettingOverrides,
  warn: (message: string) => void = () => {},
): ReconcileSettings {
  const out: ReconcileSettings = { ...base };
  for (const key of RECONCILE_OVERRIDE_KEYS) {
    const value = overrides[key];
    if (value === undefined || value === null) continue;
    if (key === 'enabled') {
      out.enabled = value as boolean;
      continue;
    }
    const num = value as number;
    const bounds = RECONCILE_SETTINGS_BOUNDS[key as keyof typeof RECONCILE_SETTINGS_BOUNDS];
    if (!Number.isInteger(num) || num < bounds.min || num > bounds.max) {
      warn(`override db ${key}=${String(num)} invalide -> conservation env/défaut`);
      continue;
    }
    out[key as keyof ReconcileSettings] = num as never;
  }
  if (out.maxBackoffMs < out.backoffInitialMs) {
    warn('overrides db : maxBackoffMs < backoffInitialMs -> défauts de la paire réappliqués');
    out.maxBackoffMs = RECONCILE_DEFAULT_SETTINGS.maxBackoffMs;
    out.backoffInitialMs = RECONCILE_DEFAULT_SETTINGS.backoffInitialMs;
  }
  return out;
}