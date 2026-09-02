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
}

export function loadAppConfig(): AppConfig {
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
  };
}