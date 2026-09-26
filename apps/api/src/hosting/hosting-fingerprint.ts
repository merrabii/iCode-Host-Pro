import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * 17B.4F-C1 — empreinte de réservation et clé d'idempotence directe.
 *
 * Une réservation est IDENTIFIÉE par :
 *  - une clé d'idempotence DÉRIVÉE CÔTÉ SERVEUR (jamais reçue du client) :
 *    `direct:v1:<jwtUserId>:<hostingServiceId>:<clientRequestId>` — la
 *    corrélation vient du `clientRequestId` (UUID v4) généré par l'appelant ;
 *  - une empreinte HMAC-SHA256 VERSIONNÉE du payload exact de la demande
 *    (champs métier + valeurs d'environnement) : `fp:<version>:<hex>` ;
 *    un rejeu avec la même clé mais un payload différent est REFUSÉ.
 *
 * Sécurité :
 *  - HMAC (pas de SHA-256 brut) : empêche la devinette hors-ligne du payload
 *    depuis la valeur stockée ;
 *  - comparaison constante (`timingSafeEqual`) côté vérification ;
 *  - version + domaine séparés inclus dans le message MAC : aucune confusion
 *    inter-versions ni inter-usages ;
 *  - version/clé inconnue → refus EXPLICITE (`FingerprintConfigError`),
 *    JAMAIS de repli silencieux (pas de SHA-256 brut, pas de « best effort ») ;
 *  - le canonical JS, la clé, le HMAC et les valeurs du payload ne sont
 *    JAMAIS journalisés (seul l'échec/succès est retourné au service).
 *
 * Configuration (lue à l'appel, jamais au démarrage — l'API démarre sans) :
 *  - `HOSTING_FP_KEYS` : JSON `{"v1":"<base64 ≥ 32 octets>"}` (keyring de
 *    rotation : les anciennes versions restent vérifiables) ;
 *  - `HOSTING_FP_ACTIVE` : version active (défaut `v1`) ;
 *  - à défaut de keyring : dérivation `v1` depuis `ENCRYPTION_KEY`
 *    (sha256, même contrat que `CryptoService`) ;
 *  - ni l'un ni l'autre → `FingerprintConfigError` → la réservation est
 *    REFUSÉE (fail-closed), sans jamais planter le boot.
 */

/** Env : keyring JSON versionné (clés base64 ≥ 32 octets). */
export const FINGERPRINT_KEYS_ENV = 'HOSTING_FP_KEYS';
/** Env : version active du keyring (défaut `v1`). */
export const FINGERPRINT_ACTIVE_ENV = 'HOSTING_FP_ACTIVE';
/** Env : fallback de dérivation v1 (contrat CryptoService existant). */
export const ENCRYPTION_KEY_ENV = 'ENCRYPTION_KEY';

/** Format stocké : `fp:<version>:<hex>` (version = `v<entier>`). */
export const FINGERPRINT_PREFIX = 'fp';
export const FINGERPRINT_VERSION = 'v1';

/** Domaine séparé du MAC (jamais réutilisable pour un autre usage). */
const FINGERPRINT_DOMAIN = 'icode-hosting-allocation-fp';

/** Format de la clé directe : `direct:v<entier>:<userId>:<serviceId>:<uuid>`. */
const DIRECT_KEY_VERSION = 'v1';

const VERSION_PATTERN = /^v\d+$/;
const STORED_PATTERN = /^fp:(v\d+):([0-9a-f]{64})$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Configuration d'empreinte absente/illégale → refus de réservation. */
export class FingerprintConfigError extends Error {}

/** Payload non canonisable (type interdit, nombre non fini…) → refus. */
export class FingerprintPayloadError extends Error {}

/** Valeur canonisable : primitives strictes (pas d'objet imbriqué libre). */
export type FingerprintValue = string | number | boolean | null;
export type FingerprintNode =
  | FingerprintValue
  | FingerprintNode[]
  | { [key: string]: FingerprintNode };

/**
 * Payload de réservation : valeurs EXACTES de la demande. `business` porte les
 * champs métier, `environment` les valeurs d'environnement/configuration du
 * déploiement visé (host, image, variables…) — toute divergence entre deux
 * « mêmes » rejeux change l'empreinte et fait refuser le rejeu.
 */
export interface ReservationPayload {
  business: { [key: string]: FingerprintNode };
  environment: { [key: string]: FingerprintNode };
}

export interface FingerprintKeyring {
  /** Version utilisée pour les NOUVELLES empreintes. */
  active: string;
  /** Clés par version : les anciennes restent vérifiables (rotation). */
  keys: Readonly<Record<string, Buffer>>;
}

/**
 * Canonicalisation récursée et déterministe (clés TRIÉES, tableaux ordonnés,
 * mêmes types) : deux payloads équivalents ont le MÊME canonique, deux
 * payloads qui diffèrent (y compris UNE valeur d'environnement) n'ont jamais
 * le même canonique.
 */
export function canonicalizePayload(payload: ReservationPayload): string {
  return canonicalNode(payload as unknown as FingerprintNode);
}

function canonicalNode(value: FingerprintNode): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new FingerprintPayloadError('Valeur numérique non finie refusée.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalNode(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as { [key: string]: FingerprintNode };
    const keys = Object.keys(record).sort();
    const body = keys.map((key) => `${JSON.stringify(key)}:${canonicalNode(record[key]!)}`).join(',');
    return `{${body}}`;
  }
  throw new FingerprintPayloadError('Valeur de payload non canonisable refusée.');
}

function macInput(version: string, payload: ReservationPayload): string {
  return `${FINGERPRINT_DOMAIN}\n${version}\n${canonicalizePayload(payload)}`;
}

/**
 * Chargement du keyring À L'APPEL (jamais au démarrage) :
 * 1. `HOSTING_FP_KEYS` (keyring versionné) ; 2. sinon dérivation v1 depuis
 * `ENCRYPTION_KEY` (sha256, même contrat que CryptoService) ; 3. sinon
 * erreur → le service refuse la réservation (l'API démarre quand même).
 */
export function loadKeyring(env: NodeJS.ProcessEnv = process.env): FingerprintKeyring {
  const active = (env[FINGERPRINT_ACTIVE_ENV] ?? '').trim() || FINGERPRINT_VERSION;
  if (!VERSION_PATTERN.test(active)) {
    throw new FingerprintConfigError(`Version active d'empreinte invalide : ${active}.`);
  }

  const keys: Record<string, Buffer> = {};
  const raw = (env[FINGERPRINT_KEYS_ENV] ?? '').trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new FingerprintConfigError('HOSTING_FP_KEYS illisible (JSON attendu).');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new FingerprintConfigError('HOSTING_FP_KEYS invalide (objet JSON attendu).');
    }
    for (const [version, encoded] of Object.entries(parsed as Record<string, unknown>)) {
      if (!VERSION_PATTERN.test(version)) {
        throw new FingerprintConfigError(`Version de clé invalide : ${version}.`);
      }
      if (typeof encoded !== 'string' || !encoded.trim()) {
        throw new FingerprintConfigError(`Clé vide pour la version ${version}.`);
      }
      const key = Buffer.from(encoded, 'base64');
      if (key.length < 32) {
        throw new FingerprintConfigError(`Clé trop courte pour la version ${version} (≥ 32 octets exigés).`);
      }
      keys[version] = key;
    }
  } else {
    // Fallback v1 : même contrat que CryptoService (sha256 de ENCRYPTION_KEY).
    const legacy = (env[ENCRYPTION_KEY_ENV] ?? '').trim();
    if (legacy) {
      keys[FINGERPRINT_VERSION] = createHash('sha256').update(legacy).digest();
    }
  }

  if (Object.keys(keys).length === 0) {
    throw new FingerprintConfigError("Aucune clé d'empreinte de réservation configurée.");
  }
  if (!keys[active]) {
    throw new FingerprintConfigError(`Clé active absente pour la version ${active}.`);
  }
  return { active, keys };
}

/** Nouvelle empreinte versionnée : `fp:<active>:<hex>` (jamais journalisée). */
export function computeFingerprint(
  payload: ReservationPayload,
  keyring: FingerprintKeyring,
): string {
  const key = keyring.keys[keyring.active];
  if (!key) {
    throw new FingerprintConfigError(`Clé active absente pour la version ${keyring.active}.`);
  }
  const mac = createHmac('sha256', key).update(macInput(keyring.active, payload)).digest('hex');
  return `${FINGERPRINT_PREFIX}:${keyring.active}:${mac}`;
}

/**
 * Vérification d'une empreinte stockée (rejeu).
 * - absente/format non C1 → `false` (refus) ;
 * - version ou clé inconnue → `FingerprintConfigError` (refus EXPLICITE,
 *   aucun repli) ;
 * - comparaison constante de deux MAC de longueur identique.
 */
export function verifyFingerprint(
  stored: string | null | undefined,
  payload: ReservationPayload,
  keyring: FingerprintKeyring,
): boolean {
  if (!stored) {
    return false;
  }
  const match = STORED_PATTERN.exec(stored);
  if (!match) {
    return false;
  }
  const version = match[1]!;
  const expectedMac = match[2]!;
  const key = keyring.keys[version];
  if (!key) {
    throw new FingerprintConfigError(`Clé indisponible pour la version d'empreinte ${version}.`);
  }
  const expected = createHmac('sha256', key)
    .update(macInput(version, payload))
    .digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const storedBuffer = Buffer.from(expectedMac, 'hex');
  if (expectedBuffer.length !== storedBuffer.length) {
    return false;
  }
  return timingSafeEqual(storedBuffer, expectedBuffer);
}

/** Validation stricte du `clientRequestId` (UUID v4 — corrélation seule). */
export function normalizeClientRequestId(clientRequestId: string): string {
  const value = (clientRequestId ?? '').trim().toLowerCase();
  if (!UUID_V4_PATTERN.test(value)) {
    throw new TypeError('clientRequestId invalide : un UUID v4 est exigé.');
  }
  return value;
}

/**
 * Clé d'idempotence directe DÉRIVÉE SERVEUR : jamais reçue du client,
 * unique par (utilisateur du jeton, service, demande).
 */
export function directIdempotencyKey(
  actorUserId: string,
  hostingServiceId: string,
  clientRequestId: string,
): string {
  return `direct:${DIRECT_KEY_VERSION}:${actorUserId}:${hostingServiceId}:${clientRequestId}`;
}
