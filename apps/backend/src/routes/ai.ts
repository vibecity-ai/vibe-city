/* Model usage per department, and the metering proxy that records it (docs/briefs/04-metering-proxy.md): agents call
   NEAR AI Cloud through /ai/v1 with their floor's pseudo key; the backend checks the floor's daily budget, forwards
   with the company key and writes one ai_usage row per answer. Costs are estimates: tokens times the listed price. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { AiUsageSummarySchema, type AiUsageSummary } from '@vibe-city/shared';
import type { AppServices } from '../app.ts';
import { nearAiKey, secret, setSecrets } from './company.ts';

/** Burn read from ai_usage (empty until the proxy records rows). Budgets come from each department's inventory. */
export function usageSummary(db: DatabaseSync, departments: { id: string; budgetCents: number | null }[], now = new Date()): AiUsageSummary {
  const day = now.toISOString().slice(0, 10), week = new Date(now.getTime() - 6 * 864e5).toISOString().slice(0, 10);
  // fractions of a cent are kept: a cheap model burns far less than a cent a day, and the runway divides by it
  const sum = (dept: string, from: string) => (db.prepare('SELECT COALESCE(SUM(cost_nano_usd), 0) AS n FROM ai_usage WHERE department_id = ? AND at >= ?').get(dept, from) as { n: number }).n / 1e7;
  const byDepartment = departments.map((d) => {
    const todayCents = sum(d.id, day), sevenDayCents = sum(d.id, week);
    return { departmentId: d.id, todayCents, sevenDayCents, budgetCents: d.budgetCents, overBudget: d.budgetCents !== null && todayCents >= d.budgetCents };
  });
  return AiUsageSummarySchema.parse({
    byDepartment,
    companyTodayCents: byDepartment.reduce((a, d) => a + d.todayCents, 0),
    companySevenDayAvgCents: byDepartment.reduce((a, d) => a + d.sevenDayCents, 0) / 7,
  });
}

const sign = (db: DatabaseSync, deptId: string) => {
  let s = secret(db, 'aiProxySecret');
  if (!s) setSecrets(db, { aiProxySecret: (s = randomBytes(32).toString('hex')) });
  return createHmac('sha256', s).update(deptId).digest('hex');
};
/** The key a floor's agents send to the proxy: names the floor, signed by the server. Not a NEAR AI key. */
export const aiKeyFor = (db: DatabaseSync, deptId: string) => `vc_ai_${deptId}_${sign(db, deptId)}`;
function deptOfKey(db: DatabaseSync, auth: string | undefined): string | null {
  const m = /^Bearer vc_ai_(.+)_([0-9a-f]{64})$/.exec(auth ?? '');
  return m && timingSafeEqual(Buffer.from(sign(db, m[1]!)), Buffer.from(m[2]!)) ? m[1]! : null;
}

interface Usage { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null }
interface Answer { id?: string; model?: string; usage?: Usage | null }

export function register(app: FastifyInstance, deps: AppServices) {
  const fail = (reply: { code(n: number): { send(b: unknown): unknown } }, code: number, message: string, type: string) => reply.code(code).send({ error: { message: `Vibe City: ${message}`, type } });
  // agent contexts are far larger than Fastify's 1 MiB default
  app.all('/ai/v1/*', { bodyLimit: 64 * 1024 * 1024 }, async (req, reply) => {
    const px = deps.aiProxy, deptId = deptOfKey(deps.db, req.headers.authorization);
    if (!px || !deptId || !deps.departments.list({ includeHidden: true }).some((d) => d.id === deptId)) return fail(reply, 401, 'unknown key', 'invalid_api_key');
    const key = nearAiKey(deps.db);
    if (!key) return fail(reply, 401, 'no NEAR AI API key yet', 'invalid_api_key');
    const post = req.method === 'POST', body = post ? (req.body as Record<string, unknown> | undefined) : undefined;
    const budget = deps.departments.getInventory(deptId).limits.dailyBudgetCredits;
    if (post && budget !== null && usageSummary(deps.db, [{ id: deptId, budgetCents: budget }]).byDepartment[0]!.overBudget) return fail(reply, 429, 'daily budget reached', 'budget');
    // a stream only reports tokens when asked to
    if (body?.stream === true) body.stream_options = { ...(body.stream_options as object | undefined), include_usage: true };
    let res: Response;
    try {
      res = await (px.fetch ?? fetch)(px.upstreamUrl.replace(/\/+$/, '') + req.url.slice('/ai/v1'.length), {
        method: req.method, headers: { authorization: `Bearer ${key}`, accept: req.headers.accept ?? '*/*', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { return fail(reply, 502, 'NEAR AI Cloud did not answer', 'upstream'); }
    const prices = post && res.ok ? await deps.modelPrices?.list().catch(() => null) : null;
    const record = (a: Answer) => {
      if (!a.usage) return;
      const model = String(body?.model ?? a.model ?? ''), p = prices?.get(model), i = a.usage.prompt_tokens ?? 0, o = a.usage.completion_tokens ?? 0;
      // agent loops resend their context, so most prompt tokens are cache hits, billed at the cache price
      const c = Math.min(i, a.usage.prompt_tokens_details?.cached_tokens ?? 0);
      // USD per 1M tokens -> nano USD per token is x1000. ponytail: a model without a listed price costs 0 here (tokens are
      // still kept); POST /v1/billing/costs with the stored request ids gives exact costs if the estimate drifts.
      deps.db.prepare('INSERT INTO ai_usage (department_id, model, input_tokens, output_tokens, cost_nano_usd, request_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(deptId, model, i, o, p ? Math.round(((i - c) * p.inPerM + c * (p.cachedPerM ?? p.inPerM) + o * p.outPerM) * 1000) : 0, a.id ?? null, new Date().toISOString());
    };
    const type = res.headers.get('content-type') ?? 'application/json';
    reply.code(res.status).header('content-type', type);
    if (res.ok && res.body && type.includes('text/event-stream')) {
      // passed through untouched; the usage rides on one of the last `data:` lines
      let buf = '', last: Answer | null = null;
      const dec = new TextDecoder();
      const tap = new Transform({
        transform(chunk: Buffer, _enc, done) {
          const lines = (buf + dec.decode(chunk, { stream: true })).split('\n');
          buf = lines.pop()!;
          for (const l of lines) if (l.startsWith('data:') && l.includes('"usage"')) try { const j = JSON.parse(l.slice(5)) as Answer; if (j.usage) last = j; } catch { /* not ours to judge */ }
          done(null, chunk);
        },
        flush(done) { if (last) record(last); done(); },
      });
      return reply.send(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]).pipe(tap));
    }
    const text = await res.text();
    if (post && res.ok) try { record(JSON.parse(text) as Answer); } catch { /* not JSON: nothing to meter */ }
    return reply.send(text);
  });
  app.get('/api/ai/usage', async () => usageSummary(deps.db, deps.departments.list().map((d) => ({ id: d.id, budgetCents: deps.departments.getInventory(d.id).limits.dailyBudgetCredits }))));
}
