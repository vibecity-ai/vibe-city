/* Model usage per department (brief 04 adds the metering proxy that fills ai_usage). */
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { AiUsageSummarySchema, type AiUsageSummary } from '@vibe-city/shared';
import type { AppServices } from '../app.ts';

/** Burn read from ai_usage (empty until the proxy records rows). Budgets come from each department's inventory. */
export function usageSummary(db: DatabaseSync, departments: { id: string; budgetCents: number | null }[], now = new Date()): AiUsageSummary {
  const day = now.toISOString().slice(0, 10), week = new Date(now.getTime() - 6 * 864e5).toISOString().slice(0, 10);
  const sum = (dept: string, from: string) => Math.round(((db.prepare('SELECT COALESCE(SUM(cost_nano_usd), 0) AS n FROM ai_usage WHERE department_id = ? AND at >= ?').get(dept, from) as { n: number }).n) / 1e7);
  const byDepartment = departments.map((d) => {
    const todayCents = sum(d.id, day), sevenDayCents = sum(d.id, week);
    return { departmentId: d.id, todayCents, sevenDayCents, budgetCents: d.budgetCents, overBudget: d.budgetCents !== null && todayCents >= d.budgetCents };
  });
  return AiUsageSummarySchema.parse({
    byDepartment,
    companyTodayCents: byDepartment.reduce((a, d) => a + d.todayCents, 0),
    companySevenDayAvgCents: Math.round(byDepartment.reduce((a, d) => a + d.sevenDayCents, 0) / 7),
  });
}

export function register(app: FastifyInstance, deps: AppServices) {
  app.get('/api/ai/usage', async () => usageSummary(deps.db, deps.departments.list().map((d) => ({ id: d.id, budgetCents: deps.departments.getInventory(d.id).limits.dailyBudgetCredits }))));
}
