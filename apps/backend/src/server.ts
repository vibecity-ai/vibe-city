import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDb } from './db/db.ts';
import { buildServices } from './app.ts';
import { loadConfig } from './config.ts';
import { RealHermesRuntime } from './hermes/realRuntime.ts';
import { KanbanClient } from './hermes/kanbanClient.ts';

const cfg = loadConfig();
const dbPath = resolve(cfg.dbPath);
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

if (!cfg.hermesToken) console.warn('HERMES_DASHBOARD_SESSION_TOKEN is not set: Hermes calls will be rejected (see ARCHITECTURE.md).');
const hermes = new RealHermesRuntime({
  baseUrl: cfg.hermesUrl, sessionToken: cfg.hermesToken ?? '', hermesBin: cfg.hermesBin, log: (m) => console.warn(m),
});
const kanban = new KanbanClient({ baseUrl: cfg.hermesUrl, sessionToken: cfg.hermesToken ?? '' });
const { app, provisioning } = buildServices(db, hermes, {
  kanban,
  // Live events: the Hermes WebSocket (and token) stay on the server; browsers only talk to /api/live.
  live: { wsBaseUrl: cfg.hermesUrl.replace(/^http/, 'ws'), sessionToken: cfg.hermesToken ?? '' },
  ...(cfg.allowedOrigins ? { allowedOrigins: cfg.allowedOrigins } : {}),
  ...(cfg.webDist ? { webDist: cfg.webDist } : {}),
});

await app.listen({ host: cfg.host, port: cfg.port }); // loopback by default
console.log(`Vibe City backend listening on http://${cfg.host}:${cfg.port}`);

// Background reconciliation: detects Hermes going away/returning and heals missing resources.
const timer = setInterval(() => { provisioning.reconcileAll().catch((e) => console.warn('reconcile failed', e)); }, cfg.reconcileIntervalMs);
timer.unref();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    await app.close();
    db.close();
    process.exit(0);
  });
}
