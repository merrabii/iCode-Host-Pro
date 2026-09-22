import { ReconcileSettings, resolveReconcileSettings } from '../store/reconcile-settings';

/** Trust-proxy value accepted by Express `app.set('trust proxy', …)`. */
export type TrustProxySetting = boolean | string[];

/** Presets Express explicitement autorisés (listes de sous-réseaux compilées
 *  par le paquet `proxy-addr`). Aucun autre nom symbolique n'est accepté. */
const TRUST_PROXY_PRESETS = ['loopback', 'linklocal', 'uniquelocal'] as const;

/** Validation stricte d'une entrée : IPv4 littérale (octets 0..255) ou CIDR
 *  IPv4 avec préfixe 0..32. Un `999.999.0.0/33` est REJETÉ (proxy-addr
 *  l'accepterait ou lèverait au boot) ; le filtrage final reste celui de
 *  `proxy-addr`. */
function isValidIpv4(entry: string): boolean {
  const octets = entry.split('.');
  return (
    octets.length === 4 &&
    octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255 && String(Number(o)) === o)
  );
}

function isValidIpv4OrCidr(entry: string): boolean {
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0) return false;
  if (!isValidIpv4(address!)) return false;
  if (prefix === undefined) return true;
  return /^\d{1,2}$/.test(prefix) && Number(prefix) <= 32 && String(Number(prefix)) === prefix;
}

/**
 * Parse TRUST_PROXY en une valeur sûre pour Express (défaut : ne faire
 * confiance à PERSONNE — X-Forwarded-For ignoré, req.ip = adresse socket).
 *
 * Règles (décision produit) :
 *  - vide/absent → false : API jointe directement, XFF JAMAIS honoré ;
 *  - le littéral "true" est REFUSÉ (il rendrait XFF forgeable par n'importe
 *    quel client joignant l'API directement) → false + avertissement ;
 *  - "false"/"0"/"no" → false explicite ;
 *  - sinon liste séparée par des virgules : presets autorisés, IPv4 littérales
 *    et CIDR (ex. 172.18.0.0/16) ; chaque entrée invalide est ignorée et
 *    journalisée ; liste entièrement invalide → false + avertissement.
 *  - un NOMBRE de hops n'est volontairement pas supporté : la chaîne de
 *    proxies n'est pas garantie par la topologie de déploiement.
 *
 * Effet côté Express/proxy-addr : XFF n'est honoré QUE si l'adresse socket du
 * pair est approuvée ; req.ip devient alors la première adresse non approuvée
 * en remontant la chaîne (le client réel). Un XFF forgé envoyé par un pair non
 * approuvé est ignoré.
 */
export function parseTrustProxy(
  raw: string | undefined,
  warn: (message: string) => void = () => {},
): TrustProxySetting {
  const value = (raw ?? '').trim();
  if (!value || ['false', '0', 'no'].includes(value.toLowerCase())) return false;
  if (value.toLowerCase() === 'true') {
    warn(
      'TRUST_PROXY=true refusé : cela rend X-Forwarded-For forgeable. ' +
        'Fournir des IP/CIDR de proxies approuvés (ex. 172.18.0.0/16). Valeur ignorée → false.',
    );
    return false;
  }
  const entries = value
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const accepted: string[] = [];
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    if ((TRUST_PROXY_PRESETS as readonly string[]).includes(lower)) {
      accepted.push(lower);
    } else if (isValidIpv4OrCidr(entry)) {
      accepted.push(entry);
    } else {
      warn(`TRUST_PROXY : entrée invalide ignorée : « ${entry} ».`);
    }
  }
  if (accepted.length === 0) {
    warn(`TRUST_PROXY=« ${value} » sans entrée valide → false (X-Forwarded-For ignoré).`);
    return false;
  }
  return accepted;
}

/** Minimal, fail-early startup config socle (ADR-011).
 *  Not a full configuration architecture: ADR-008 (secrets, encryption,
 *  persisted config) remains PROPOSED and is out of scope for Phase 0/1.
 *  Phase 1 adds the JWT secret to the required dev env set.
 */
export interface AppConfig {
  port: number;
  apiPrefix: string;
  databaseUrl: string;
  nodeEnv: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  refreshExpiresInDays: number;
  cookieName: string;
  /** Phase 5 (ADR-020): invite TTL in days. Optional (default 7), so the JWT
   *  fail-early set above is untouched. */
  inviteExpiresInDays: number;
  /** Phase 6 (ADR-022): master key for app-level encryption (AES-256-GCM) of
   *  the SMTP password. Optional — only required when an admin SAVES a mail
   *  password (fail-early set untouched, same pattern as inviteExpiresInDays). */
  encryptionKey: string;
  /** Phase 6 (ADR-022): public base URL used to build absolute invitation
   *  links in the invitation emails. Optional (default localhost:3000). */
  publicBaseUrl: string;
  /** Phase 10 (ADR-027): optional security keys — all absent by default, so
   *  every security feature degrades to "disabled" when unset (non-mandatory).
   *  Turnstile, OAuth, MFA email/recovery flows read these. */
  turnstileSecretKey: string;
  turnstileSiteKey: string;
  googleClientId: string;
  googleClientSecret: string;
  githubClientId: string;
  githubClientSecret: string;
  /** Pepper for the HMAC that hashes the 6-digit support codes. */
  supportCodePepper: string;
  /** Support code TTL (minutes), default 60, clamped 5..1440 in the service. */
  supportCodeTtlMinutes: number;
  /** Email-OTP / MFA challenge TTL in seconds. */
  mfaOtpTtlSeconds: number;
  /** Impersonation access-token TTL (seconds or "Ns" JWT format). */
  impersonationExpiresIn: string;
  /** OAuth state cookie TTL in seconds. */
  oauthStateTtlSeconds: number;
  /** Trust proxy Express (parseTrustProxy) : false par défaut — X-Forwarded-For
   *  n'est honoré que depuis des pairs explicitement approuvés. */
  trustProxy: TrustProxySetting;
  /** Phase 17B — configuration du réconciliateur asynchrone des déploiements,
   *  résolue depuis l'environnement via la SOURCE UNIQUE du moteur
   *  (store/reconcile-settings.ts) : clés RECONCILE_*, défauts + bornes les
   *  MÊMES que ReconcileSettingsService. Jamais de secret dans ces valeurs. */
  reconcile: ReconcileSettings;
}

export function loadAppConfig(
  warn: (message: string) => void = () => {},
): AppConfig {
  const missing = ['DATABASE_URL', 'PORT', 'JWT_SECRET'].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        `Copy apps/api/.env.example to apps/api/.env (Phase 0/1 socle).`,
    );
  }

  return {
    port: Number(process.env.PORT!),
    apiPrefix: process.env.API_PREFIX ?? 'api',
    databaseUrl: process.env.DATABASE_URL!,
    nodeEnv: process.env.NODE_ENV ?? 'development',
    jwtSecret: process.env.JWT_SECRET!,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
    refreshExpiresInDays: Number(process.env.REFRESH_EXPIRES_IN_DAYS ?? 30),
    cookieName: process.env.COOKIE_NAME ?? 'ihp_refresh',
    inviteExpiresInDays: Number(process.env.INVITE_EXPIRES_IN_DAYS ?? 7),
    encryptionKey: process.env.ENCRYPTION_KEY ?? '',
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
    turnstileSecretKey: process.env.TURNSTILE_SECRET_KEY ?? '',
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY ?? '',
    googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    githubClientId: process.env.GITHUB_CLIENT_ID ?? '',
    githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
    supportCodePepper: process.env.SUPPORT_CODE_PEPPER ?? '',
    supportCodeTtlMinutes: Number(process.env.SUPPORT_CODE_TTL_MINUTES ?? 60),
    mfaOtpTtlSeconds: Number(process.env.MFA_OTP_TTL_SECONDS ?? 300),
    impersonationExpiresIn: process.env.IMPERSONATION_EXPIRES_IN ?? '60m',
    oauthStateTtlSeconds: Number(process.env.OAUTH_STATE_TTL_SECONDS ?? 600),
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY, warn),
    reconcile: resolveReconcileSettings(process.env, warn),
  };
}
