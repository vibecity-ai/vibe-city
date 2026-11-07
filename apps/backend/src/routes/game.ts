/* The game loop (docs/briefs/05-game-loop.md): GET /api/game assembles the input from the services and returns
   deriveGame(...), cached 5 s. The only write is confirm-policy. */
import type { FastifyInstance } from 'fastify';
import { GameStateSchema, TEMPLATES, type QuestSummary } from '@vibe-city/shared';
import type { AppServices } from '../app.ts';
import { deriveGame, type GameInput, type ResultLine } from '../domain/game.ts';
import { readSettings, writeSettings } from './company.ts';
import { usageSummary } from './ai.ts';
import { EMPTY_WALLET } from './wallet.ts';

const CACHE_MS = 5_000;
const RESULT_DAYS = 7;
let cache: { at: number; deps: AppServices; value: ReturnType<typeof deriveGame> } | null = null;
/** Results of finished quests never change: kept per quest so each is read from Hermes once. */
const finished = new Map<string, ResultLine[]>();

async function input(deps: AppServices): Promise<GameInput> {
  const { db, departments, quests } = deps;
  const depts = departments.list();
  const templateOf = Object.fromEntries((db.prepare('SELECT id, template_id FROM department').all() as { id: string; template_id: string | null }[]).map((r) => [r.id, r.template_id]));
  const questsByDept: Record<string, QuestSummary[]> = {};
  const results: ResultLine[] = [];
  const since = Date.now() - RESULT_DAYS * 864e5;
  await Promise.all(depts.filter((d) => d.state === 'ready').map(async (d) => {
    let list: QuestSummary[];
    try { list = await quests.list(d.id); } catch { return; }
    questsByDept[d.id] = list;
    for (const q of list) {
      if (q.status !== 'completed' || (q.completedAt && Date.parse(q.completedAt) < since)) continue;
      const key = `${d.id}:${q.id}`;
      let lines = finished.get(key);
      if (!lines) {
        try {
          const r = await quests.results(d.id, q.id);
          lines = [r.leadSummary, ...r.tasks.map((t) => t.summary)].filter((t): t is string => !!t).map((text) => ({ departmentId: d.id, questId: q.id, text }));
          finished.set(key, lines);
        } catch { continue; }
      }
      results.push(...lines);
    }
  }));
  const usage = usageSummary(db, depts.map((d) => ({ id: d.id, budgetCents: departments.getInventory(d.id).limits.dailyBudgetCredits })));
  const total = Math.round((db.prepare('SELECT COALESCE(SUM(cost_nano_usd), 0) AS n FROM ai_usage').get() as { n: number }).n / 1e7);
  return {
    settings: readSettings(db), wallet: EMPTY_WALLET, departments: depts, templateOf, templates: TEMPLATES,
    usage, totalMeteredCents: total, questsByDept, results, pendingApprovals: [],
  };
}

/** The game state, shared with the templates route (it reads `locked`). */
export async function gameState(deps: AppServices, fresh = false) {
  if (!fresh && cache && cache.deps === deps && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = deriveGame(await input(deps));
  cache = { at: Date.now(), deps, value };
  return value;
}

export function register(app: FastifyInstance, deps: AppServices) {
  app.get('/api/game', async () => {
    const { locked: _locked, ...state } = await gameState(deps);
    return GameStateSchema.parse(state);
  });
  app.post('/api/game/confirm-policy', async () => {
    writeSettings(deps.db, { policyConfirmedAt: new Date().toISOString() });
    const { locked: _locked, ...state } = await gameState(deps, true);
    return GameStateSchema.parse(state);
  });
}
