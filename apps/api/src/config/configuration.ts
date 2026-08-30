/** Minimal, fail-early startup config socle (ADR-011).
 *  Not a full configuration architecture: ADR-008 (secrets, encryption,
 *  persisted config) remains PROPOSED and is out of scope for Phase 0.
 */
export interface AppConfig {
  port: number;
  apiPrefix: string;
  databaseUrl: string;
  nodeEnv: string;
}

export function loadAppConfig(): AppConfig {
  const missing = ['DATABASE_URL', 'PORT'].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        `Copy apps/api/.env.example to apps/api/.env (Phase 0 / ADR-011 socle).`,
    );
  }

  return {
    port: Number(process.env.PORT!),
    apiPrefix: process.env.API_PREFIX ?? 'api',
    databaseUrl: process.env.DATABASE_URL!,
    nodeEnv: process.env.NODE_ENV ?? 'development',
  };
}