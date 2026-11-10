export interface AppConfig {
  dbPath: string;
  host: string;
  port: number;
  hermesUrl: string;
  /** Server-side only. Never serialized into any API response. */
  hermesToken: string | null;
  hermesBin: string;
  /** The Hermes gateway API server (same container: loopback). The dialogue window talks to agents' profiles through it. */
  hermesApiUrl: string;
  reconcileIntervalMs: number;
  /** Browser origins allowed to open the live WebSocket. Undefined = built-in localhost defaults. */
  allowedOrigins?: string[];
  /** Directory with the built web app to serve (WEB_DIST). Unset = API only. */
  webDist?: string;
  /** OpenAI-compatible chat endpoint for the dialogue window (NEAR AI Cloud by default). Key is server-side only. */
  chat: { baseUrl: string; apiKey: string | null; model: string };
  /** Where Hermes reaches the Vibe City MCP server (same container: loopback). Empty string disables registering it. */
  mcpUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    dbPath: env.VIBE_CITY_DB ?? 'data/vibe-city.sqlite',
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 4100),
    hermesUrl: env.HERMES_URL ?? 'http://127.0.0.1:9119',
    hermesToken: env.HERMES_DASHBOARD_SESSION_TOKEN || null,
    hermesBin: env.HERMES_BIN ?? 'hermes',
    hermesApiUrl: env.HERMES_API_URL ?? 'http://127.0.0.1:8642',
    reconcileIntervalMs: Number(env.RECONCILE_INTERVAL_MS ?? 30_000),
    chat: {
      baseUrl: env.CHAT_BASE_URL ?? env.NEAR_AI_BASE_URL ?? 'https://cloud-api.near.ai/v1',
      apiKey: env.CHAT_API_KEY || env.NEAR_AI_API_KEY || null,
      model: env.CHAT_MODEL ?? env.NEAR_AI_MODEL ?? 'deepseek/deepseek-v4.1-flash',
    },
    mcpUrl: env.VIBE_CITY_MCP_URL ?? `http://127.0.0.1:${Number(env.PORT ?? 4100)}/mcp`,
    ...(env.WEB_DIST ? { webDist: env.WEB_DIST } : {}),
    ...(env.ALLOWED_ORIGINS ? { allowedOrigins: env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean) } : {}),
  };
}
