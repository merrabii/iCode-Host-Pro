/**
 * 17B.4B — contrat de configuration du moteur de réconciliation.
 *
 * Source de vérité des DÉFAUTS et des BORNES du moteur. Deux usages :
 *  - `ReconcileSettingsService` résout env (via ConfigService, JAMAIS process.env
 *    côté moteur) → défauts, avec fallback sûr + warn sur valeur invalide ;
 *  - `loadAppConfig` (config/configuration.ts) s'appuie sur les MÊMES constantes
 *    pour exposer les clés typées (source unique).
 *
 * Module PUR (aucune import Nest) : testable sans Nest. La priorité
 * « base PostgreSQL → env → défauts » sera ajoutée en 17B.4C UNIQUEMENT dans
 * ReconcileSettingsService, sans modifier ReconcileService.
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