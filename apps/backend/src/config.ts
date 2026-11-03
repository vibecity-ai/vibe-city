export interface AppConfig {
  dbPath: string;
  host: string;
  port: number;
  hermesUrl: string;
  /** Server-side only. Never serialized into any API response. */
  hermesToken: string | null;
  hermesBin: string;
  reconcileIntervalMs: number;
  /** Browser origins allowed to open the live WebSocket. Undefined = built-in localhost defaults. */
  allowedOrigins?: string[];
  /** Directory with the built web app to serve (WEB_DIST). Unset = API only. */
  webDist?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    dbPath: env.VIBE_CITY_DB ?? 'data/vibe-city.sqlite',
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 4100),
    hermesUrl: env.HERMES_URL ?? 'http://127.0.0.1:9119',
    hermesToken: env.HERMES_DASHBOARD_SESSION_TOKEN || null,
    hermesBin: env.HERMES_BIN ?? 'hermes',
    reconcileIntervalMs: Number(env.RECONCILE_INTERVAL_MS ?? 30_000),
    ...(env.WEB_DIST ? { webDist: env.WEB_DIST } : {}),
    ...(env.ALLOWED_ORIGINS ? { allowedOrigins: env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean) } : {}),
  };
}
