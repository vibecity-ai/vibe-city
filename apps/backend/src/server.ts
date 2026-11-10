import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDb } from './db/db.ts';
import { buildServices } from './app.ts';
import { loadConfig } from './config.ts';
import { RealHermesRuntime } from './hermes/realRuntime.ts';
import { KanbanClient } from './hermes/kanbanClient.ts';
import { OpenAiCompatModel } from './model/chatModel.ts';
import { nearAiKey, readSettings } from './routes/company.ts';
import { NearModelPrices } from './model/nearPrices.ts';
import { HermesAgentChat } from './hermes/agentChat.ts';
import { NearAiCredits } from './domain/moneyService.ts';

const cfg = loadConfig();
const dbPath = resolve(cfg.dbPath);
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

if (!cfg.hermesToken) console.warn('HERMES_DASHBOARD_SESSION_TOKEN is not set: Hermes calls will be rejected (see ARCHITECTURE.md).');
const hermes = new RealHermesRuntime({
  baseUrl: cfg.hermesUrl, sessionToken: cfg.hermesToken ?? '', hermesBin: cfg.hermesBin, log: (m) => console.warn(m),
});
const kanban = new KanbanClient({ baseUrl: cfg.hermesUrl, sessionToken: cfg.hermesToken ?? '' });
const { app, provisioning, schedules, market, departments, chiefOfStaffId } = buildServices(db, hermes, {
  kanban, ...(process.env.MARKET_BASE_URL ? { marketBaseUrl: process.env.MARKET_BASE_URL } : {}),
  // Live events: the Hermes WebSocket (and token) stay on the server; browsers only talk to /api/live.
  live: { wsBaseUrl: cfg.hermesUrl.replace(/^http/, 'ws'), sessionToken: cfg.hermesToken ?? '' },
  ...(cfg.allowedOrigins ? { allowedOrigins: cfg.allowedOrigins } : {}),
  ...(cfg.webDist ? { webDist: cfg.webDist } : {}),
  // The Chief of Staff reads the key and model live: both can be set in the first quest without a restart.
  chatModel: new OpenAiCompatModel({ ...cfg.chat, apiKey: () => nearAiKey(db, cfg.chat.apiKey), model: () => readSettings(db).chiefOfStaffModel ?? cfg.chat.model }),
  chatModelDefault: cfg.chat.model, modelPrices: new NearModelPrices({ baseUrl: cfg.chat.baseUrl }), agentChat: new HermesAgentChat({ baseUrl: cfg.hermesApiUrl }),
  money: { credits: new NearAiCredits({ baseUrl: cfg.chat.baseUrl, orgId: cfg.near.billingOrgId, token: cfg.near.billingToken }), rpcUrl: cfg.near.rpc },
  // Profiles served by the multiplexed gateway read credentials only from their own .env, not this container's env.
  ...(process.env.NEAR_AI_API_KEY ? { agentEnv: { NEAR_AI_API_KEY: process.env.NEAR_AI_API_KEY } } : {}), ...(cfg.mcpUrl ? { mcpUrl: cfg.mcpUrl } : {}),
});
if (!nearAiKey(db, cfg.chat.apiKey)) console.warn('No NEAR AI API key yet: the Chief of Staff talks once the CEO adds one in the first quest.');

// Schedules (feature spec 8): the backend fires due schedules by creating ordinary quests.
setInterval(() => { void schedules.tick().catch((e) => console.warn('schedule tick failed:', (e as Error).message)); }, 30_000).unref();
// The Agent Market (brief 02): poll the agent's assignments (the market's guidance is every 30-60 s).
setInterval(() => { void market.tick(); }, 45_000).unref();

await app.listen({ host: cfg.host, port: cfg.port }); // loopback by default
console.log(`Vibe City backend listening on http://${cfg.host}:${cfg.port}`);

// The Chief of Staff's profile: nobody presses Sync for a floor the tower does not show, so the backend does, now and
// whenever Hermes was away (reconcile only follows floors that were synced once).
const syncChiefOfStaff = async () => {
  const state = departments.get(chiefOfStaffId).state;
  if (state === 'unconfigured') await provisioning.provision(chiefOfStaffId);
  else if (state === 'error') await provisioning.retry(chiefOfStaffId);
};
void syncChiefOfStaff().catch((e) => console.warn('Chief of Staff not synced yet:', (e as Error).message));
// Background reconciliation: detects Hermes going away/returning and heals missing resources.
const timer = setInterval(() => {
  provisioning.reconcileAll().catch((e) => console.warn('reconcile failed', e));
  syncChiefOfStaff().catch(() => undefined);
}, cfg.reconcileIntervalMs);
timer.unref();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    await app.close();
    db.close();
    process.exit(0);
  });
}
