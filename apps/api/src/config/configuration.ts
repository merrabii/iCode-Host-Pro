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
  };
}