/* The NEAR AI Agent Market (brief 02, revised 2026-11-10): each listed floor of the company is its own agent on market.near.ai.
   - register(): self-registration (`POST /v1/agents/register`) for the floor the Chief of Staff and the CEO picked in
     chat (the list_on_market MCP tool); the aat_ token comes back once and stays server-side. That floor's agents get it
     as MARKET_AGENT_TOKEN and the marketplace-worker skill.
     Price, currency and going live are account-session calls, so the CEO does them on market.near.ai.
   - tick(): the poller (server.ts runs it every 45 s; the market says to poll even with a webhook, and a webhook needs
     a public HTTPS URL a local install does not have). Each new assignment becomes a quest on the listed floor, a
     completed quest is submitted as the deliverable, request-changes opens a follow-up quest, acceptance is earnings.
   Errors from the market are free text: scrubbed before they reach a response. */
import type { DatabaseSync } from 'node:sqlite';
import { isInternalOnly, type MarketAdoption, type MarketJob, type MarketProfile, type MarketRegister, type MarketView, type QuestCreate, type QuestCreated, type QuestResults } from '@vibe-city/shared';
import type { DepartmentService } from './departmentService.ts';
import { ConflictError, InvalidInputError, UpstreamError } from './errors.ts';
import { scrub } from './scrub.ts';
import { stableUuid } from './scheduleService.ts';

export interface MarketDeps {
  db: DatabaseSync;
  departments: Pick<DepartmentService, 'list' | 'patchInventory' | 'getInventory'>;
  createQuest: (deptId: string, input: QuestCreate) => Promise<QuestCreated>;
  results: (deptId: string, questId: string) => Promise<QuestResults>;
  recordOrigin: (deptId: string, questId: string) => void;
  fetch?: typeof fetch;
  /** Default https://market.near.ai (env MARKET_BASE_URL). */
  baseUrl?: string;
}

/** One row of `GET /v1/agents/me/assignments` (only the fields we use). */
interface Item {
  assignment: { assignmentId: string; status: string; escrowAmount: string; escrowToken: string; startedAt: string | null };
  job: { title: string; description: string; tags: string[]; attachments?: { filename?: string }[] };
  latestMessage: { senderSide: string; body: string } | null;
}
interface AgentRow { department_id: string; handle: string; agent_id: string | null; token: string; verified_at: string | null; adopted_at: string | null; token_applied_at: string | null; tagline: string | null; description: string | null; price_usdc: string | null; created_at: string }
interface Row { assignment_id: string; title: string; department_id: string; quest_id: string; state: MarketJob['state']; rounds: number; amount: string; token: string; note: string | null; updated_at: string }

export class MarketHttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const MAX_DELIVERABLE = 250_000; // bytes-ish; the market caps Markdown at 256 KiB
const FEE = 0.95; // the market keeps 5% of a completed job
/** The skill the listed floor's agents get: market.near.ai's own worker skill (docker/skills/marketplace-worker). */
export const WORKER_SKILL = 'marketplace-worker';

export class MarketService {
  private d: MarketDeps;
  private base: string;
  private busy = false;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  constructor(d: MarketDeps) { this.d = d; this.base = (d.baseUrl ?? 'https://market.near.ai').replace(/\/$/, ''); }

  // ---- setup ------------------------------------------------------------------------------------------------------

  /** Every listed floor (newest last); the token stays in this class. */
  private agents(): AgentRow[] {
    return this.d.db.prepare('SELECT * FROM market_agent ORDER BY created_at').all() as unknown as AgentRow[];
  }
  private agentOf(deptId: string): AgentRow {
    const a = this.d.db.prepare('SELECT * FROM market_agent WHERE department_id = ?').get(deptId) as unknown as AgentRow | undefined;
    if (!a) throw new ConflictError('That floor is not on the market.');
    return a;
  }
  private stamp(deptId: string, col: 'verified_at' | 'adopted_at' | 'token_applied_at', at = new Date().toISOString()) {
    this.d.db.prepare(`UPDATE market_agent SET ${col} = ? WHERE department_id = ?`).run(at, deptId);
  }
  /** The floor's agent token, for its profiles' .env (MARKET_AGENT_TOKEN); null when the floor is not listed. */
  tokenFor(deptId: string): string | null {
    return (this.d.db.prepare('SELECT token FROM market_agent WHERE department_id = ?').get(deptId) as { token: string } | undefined)?.token ?? null;
  }
  isListed(deptId: string): boolean { return this.tokenFor(deptId) !== null; }
  /** The floor's agents hold its token now (the `market` quest is done once any floor's do). */
  markTokenApplied(deptId: string, at: string) { this.stamp(deptId, 'token_applied_at', at); }
  anyTokenApplied(): boolean {
    return !!this.d.db.prepare('SELECT 1 FROM market_agent WHERE token_applied_at IS NOT NULL LIMIT 1').get();
  }

  view(): MarketView {
    const ready = new Set(this.d.departments.list().filter((d) => d.state === 'ready').map((d) => d.id));
    const jobs = (this.d.db.prepare('SELECT * FROM market_job ORDER BY created_at DESC LIMIT 50').all() as unknown as Row[]).map((r) => ({
      assignmentId: r.assignment_id, title: r.title, departmentId: r.department_id, questId: r.quest_id, state: r.state,
      rounds: r.rounds, amount: r.amount, token: r.token, note: r.note, updatedAt: r.updated_at,
    }));
    const agents = this.agents().map((a) => ({
      departmentId: a.department_id, handle: a.handle, verifiedAt: a.verified_at, adoptedAt: a.adopted_at, tokenAppliedAt: a.token_applied_at,
      ready: ready.has(a.department_id), tagline: a.tagline, description: a.description, priceUsdc: a.price_usdc,
    }));
    return { connected: agents.length > 0, agents, lastPollAt: this.lastPollAt, lastError: this.lastError, earnedCents: this.earnedCents(), jobs };
  }

  /** Jobs the buyer accepted (a 0 USD test hire counts: the first-job quest is about being paid, not the amount). */
  paidJobs(): number {
    return (this.d.db.prepare("SELECT COUNT(*) AS n FROM market_job WHERE state = 'accepted'").get() as { n: number }).n;
  }

  /** Accepted jobs after the fee, counting USD and USDC 1:1 (the market pays either, no conversion). */
  earnedCents(): number {
    const rows = this.d.db.prepare("SELECT amount FROM market_job WHERE state = 'accepted'").all() as { amount: string }[];
    return rows.reduce((n, r) => n + Math.round((Number(r.amount) || 0) * 100 * FEE), 0);
  }

  /** Lists a floor as its own agent: registers it, then gives the floor the marketplace-worker skill (its profiles are
      re-synced by the caller, which also writes this floor's token into them). */
  async register(input: MarketRegister): Promise<void> {
    const floor = this.d.departments.list().find((d) => d.id === input.departmentId);
    if (!floor) throw new InvalidInputError('That floor does not exist.');
    if (isInternalOnly(floor.templateId)) throw new InvalidInputError(`${floor.name} spends from the company wallet, so it is internal: it can never take outside jobs.`);
    const had = this.d.db.prepare('SELECT handle FROM market_agent WHERE department_id = ?').get(floor.id) as { handle: string } | undefined;
    if (had) throw new ConflictError(`${floor.name} is already on the market as @${had.handle}.`);
    let r: { apiToken: string; handle: string; agentId?: string };
    try {
      r = await this.call('POST', '/v1/agents/register', null, {
        handle: input.handle, name: input.name, category: input.category, ...(input.slaHours ? { sla_seconds: input.slaHours * 3600 } : {}),
      }) as typeof r;
    } catch (e) {
      if (e instanceof MarketHttpError && e.status === 409) throw new ConflictError(`@${input.handle} is taken on market.near.ai. Pick another handle.`);
      if (e instanceof MarketHttpError && e.status === 429) throw new UpstreamError('market.near.ai is not taking self-registrations right now. Try again later.');
      throw this.mapped(e);
    }
    this.d.db.prepare(`INSERT INTO market_agent (department_id, handle, agent_id, token, tagline, description, price_usdc, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(floor.id, r.handle, r.agentId ?? null, r.apiToken, input.tagline ?? null, input.description ?? null, input.priceUsdc ?? null, new Date().toISOString());
    const skills = this.d.departments.getInventory(input.departmentId).allowedSkillIds;
    if (!skills.includes(WORKER_SKILL)) this.d.departments.patchInventory(input.departmentId, { allowedSkillIds: [...skills, WORKER_SKILL] });
    await this.verify(floor.id, r.apiToken);
  }

  /** Self-registration puts the agent under a fresh market account, invisible in the boss's own: a one-time code moves
      it (and its balance) into the account that redeems it. The token keeps working after. */
  async adoption(deptId: string): Promise<MarketAdoption> {
    const a = this.agentOf(deptId);
    if (a.adopted_at) return { adopted: true, url: null, code: null, expiresAt: null };
    let r: { code?: string; adoptionUrl?: string; expiresAt?: string };
    try {
      r = await this.call('POST', '/v1/agents/me/adoption-code', a.token) as typeof r;
    } catch (e) {
      // 409 agent_already_adopted; 403 once a person owns it ("may run work, not give the agent away"): claimed either way
      if (e instanceof MarketHttpError && (e.status === 409 || e.status === 403)) {
        this.stamp(deptId, 'adopted_at');
        return { adopted: true, url: null, code: null, expiresAt: null };
      }
      throw this.mapped(e);
    }
    const url = r.adoptionUrl ? (/^https?:\/\//.test(r.adoptionUrl) ? r.adoptionUrl : `${this.base}${r.adoptionUrl.startsWith('/') ? '' : '/'}${r.adoptionUrl}`) : null;
    return { adopted: false, url, code: r.code ?? null, expiresAt: r.expiresAt ?? null };
  }

  /** The listed agent's market page data; read with its token (the market only shows a Draft to its owner). */
  async profile(deptId: string): Promise<MarketProfile> {
    const { handle, token } = this.agentOf(deptId);
    const none = { handle, url: `${this.base}/a/${handle}`, found: false, name: null, description: null, bio: null, priceUsdc: null, category: null, listingStatus: null, deliveredJobs: null, successRate: null, responseTimeSeconds: null, slaSeconds: null };
    let a: Record<string, unknown>;
    try { a = await this.call('GET', `/v1/agents/${encodeURIComponent(handle)}`, token) as Record<string, unknown>; }
    catch (e) { if (e instanceof MarketHttpError && (e.status === 404 || e.status === 403)) return none; throw this.mapped(e); }
    const str = (...k: string[]) => { for (const x of k) if (typeof a[x] === 'string') return a[x] as string; return null; };
    const num = (...k: string[]) => { for (const x of k) if (typeof a[x] === 'number') return a[x] as number; return null; };
    // the price is on the agent's pricing plans, not on the agent; a plan that cannot be read leaves it unknown
    const id = str('agent_id', 'agentId');
    const plans = id ? await this.call('GET', `/v1/agents/${encodeURIComponent(id)}/pricing-plans`, token).catch(() => null) as { price_amount?: unknown; is_default?: boolean }[] | null : null;
    const plan = Array.isArray(plans) ? plans.find((x) => x.is_default) ?? plans[0] : undefined;
    return { ...none, found: true, name: str('name'), description: str('description'), bio: str('bio_markdown', 'bioMarkdown'), category: str('category'),
      priceUsdc: typeof plan?.price_amount === 'string' ? plan.price_amount : null,
      listingStatus: str('listing_status', 'listingStatus'), deliveredJobs: num('delivered_jobs', 'deliveredJobs'), successRate: num('success_rate', 'successRate'),
      responseTimeSeconds: num('response_time_seconds_median', 'responseTimeSecondsMedian'), slaSeconds: num('sla_seconds', 'slaSeconds') };
  }

  // ---- the poller: one loop over every listed floor, each with its own token ------------------------------------------

  async tick(): Promise<void> {
    if (this.busy) return;
    const agents = this.agents();
    if (!agents.length) return;
    this.busy = true;
    let error: string | null = null;
    try {
      for (const ag of agents) {
        try {
          const { assignments } = await this.call('GET', '/v1/agents/me/assignments?status=all&limit=100', ag.token) as { assignments: Item[] };
          if (!ag.verified_at) this.stamp(ag.department_id, 'verified_at');
          for (const it of assignments) {
            try { await this.step(it, ag.token, ag.department_id); } catch (e) { error = this.message(e); this.note(it.assignment.assignmentId, error); }
          }
        } catch (e) { error = `@${ag.handle}: ${this.message(e)}`; }
      }
      this.lastPollAt = new Date().toISOString();
      this.lastError = error;
    } catch (e) {
      this.lastError = this.message(e);
    } finally {
      this.busy = false;
    }
  }

  private async step(it: Item, token: string, deptId: string): Promise<void> {
    const a = it.assignment, id = a.assignmentId;
    const row = this.d.db.prepare('SELECT * FROM market_job WHERE assignment_id = ?').get(id) as Row | undefined;
    const path = `/v1/assignments/${encodeURIComponent(id)}`;
    if (!row) {
      if (a.status !== 'in_progress') return; // only new work; a finished or cancelled one was never ours to do
      const dept = this.d.departments.list().find((d) => d.id === deptId && d.state === 'ready')?.id;
      if (!dept) throw new Error('The listed floor is not synced with Hermes, so it cannot take market jobs yet.');
      const questId = await this.quest(dept, id, 1, it.job.title, brief(it));
      const now = new Date().toISOString();
      this.d.db.prepare(`INSERT INTO market_job (assignment_id, title, department_id, quest_id, state, rounds, amount, token, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'working', 1, ?, ?, ?, ?)`).run(id, it.job.title.slice(0, 200), dept, questId, a.escrowAmount, a.escrowToken, now, now);
      await this.call('POST', `${path}/start`, token); // idempotent; protects us until the SLA deadline
      return;
    }
    if (a.status === 'accepted') return this.set(id, 'accepted', null);
    if (a.status === 'cancelled' || a.status === 'dispute_resolved') return this.set(id, 'closed', `The market closed it (${a.status}).`);
    if (row.state === 'working') {
      if (!a.startedAt) await this.call('POST', `${path}/start`, token);
      const r = await this.d.results(row.department_id, row.quest_id);
      if (r.status === 'failed' || r.status === 'cancelled') return this.set(id, 'failed', `The quest ${r.status}; nothing was submitted.`);
      if (r.status !== 'completed') return;
      const md = deliverable(r);
      if (!md) return this.set(id, 'failed', 'The job finished without a written result; nothing was submitted.');
      await this.call('POST', `${path}/submit`, token, { deliverableMarkdown: md });
      return this.set(id, 'submitted', null);
    }
    if (row.state === 'submitted' && a.status === 'in_progress') {
      // request-changes: the buyer's feedback is the latest message; the same department redoes it
      const feedback = it.latestMessage?.senderSide === 'buyer' ? it.latestMessage.body : 'The buyer asked for changes.';
      const round = row.rounds + 1;
      const prev = deliverable(await this.d.results(row.department_id, row.quest_id)) ?? '';
      const questId = await this.quest(row.department_id, id, round, it.job.title,
        `${brief(it)}\n\nYou delivered this before:\n\n${prev.slice(0, 3000)}\n\nThe buyer asked for changes:\n\n${feedback}\n\nDeliver the complete revised work, not only the changes.`);
      this.d.db.prepare("UPDATE market_job SET quest_id = ?, rounds = ?, state = 'working', note = NULL, updated_at = ? WHERE assignment_id = ?")
        .run(questId, round, new Date().toISOString(), id);
      return;
    }
    if (a.status === 'disputed' && row.note === null) this.note(id, 'The buyer opened a dispute. The market resolves it.');
  }

  /** A quest per assignment and round; the id is stable, so a retry after a crash returns the same quest. */
  private async quest(deptId: string, assignmentId: string, round: number, title: string, objective: string): Promise<string> {
    const { questId } = await this.d.createQuest(deptId, {
      clientRequestId: stableUuid(`market|${assignmentId}|${round}`),
      title: `Market job${round > 1 ? ` (revision ${round - 1})` : ''}: ${title}`.slice(0, 200),
      objective: objective.slice(0, 8000),
      instructions: 'A buyer on the NEAR AI Agent Market hired the company for this. Your final result is sent to the buyer as the deliverable, in Markdown: write the complete work there, not a note about it. The agent token is MARKET_AGENT_TOKEN in your environment, for the marketplace-worker skill against https://market.near.ai: use it to read the job thread and attachments and to message the buyer. Vibe City starts and submits the assignment itself: never start, submit or decline it, and never bid.',
    });
    this.d.recordOrigin(deptId, questId);
    return questId;
  }

  private async verify(deptId: string, token: string) {
    try {
      await this.call('GET', '/v1/agents/me/assignments?limit=1', token);
      this.stamp(deptId, 'verified_at');
    } catch { /* the next poll verifies it */ }
  }

  // ---- internals --------------------------------------------------------------------------------------------------

  private set(id: string, state: MarketJob['state'], note: string | null) {
    this.d.db.prepare('UPDATE market_job SET state = ?, note = ?, updated_at = ? WHERE assignment_id = ? AND state != ?').run(state, note, new Date().toISOString(), id, state);
  }
  private note(id: string, note: string) {
    this.d.db.prepare('UPDATE market_job SET note = ?, updated_at = ? WHERE assignment_id = ?').run(note.slice(0, 500), new Date().toISOString(), id);
  }
  private message(e: unknown) { return scrub((e as Error).message, 300) ?? 'unknown error'; }
  private mapped(e: unknown): Error {
    if (e instanceof MarketHttpError && e.status === 400) return new InvalidInputError(`market.near.ai: ${this.message(e)}`);
    return new UpstreamError(`market.near.ai: ${this.message(e)}`);
  }

  private async call(method: string, path: string, token: string | null, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await (this.d.fetch ?? fetch)(`${this.base}${path}`, {
        method,
        headers: { accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new MarketHttpError(0, `could not reach the market (${(e as Error).message})`);
    }
    const json = await res.json().catch(() => ({})) as { error?: string; message?: string };
    if (!res.ok) throw new MarketHttpError(res.status, json.message ?? json.error ?? `HTTP ${res.status}`);
    return json;
  }
}

/** The job as the department reads it. Attachments need the market token, which agents never get: named only. */
function brief(it: Item): string {
  const files = it.job.attachments?.map((f) => f.filename).filter(Boolean) ?? [];
  return [it.job.title, it.job.description, it.job.tags.length ? `Tags: ${it.job.tags.join(', ')}` : '',
    files.length ? `The buyer attached files you cannot open: ${files.join(', ')}. Work from the description.` : ''].filter(Boolean).join('\n\n');
}

/** A completed quest as Markdown: the lead's summary, then each task's. Host paths are scrubbed: this leaves Vibe City. */
export function deliverable(r: QuestResults): string | null {
  const parts = [r.leadSummary, ...r.tasks.filter((t) => t.summary).map((t) => `## ${t.title}\n\n${t.summary}`)].filter((s): s is string => !!s?.trim());
  return parts.length ? scrub(parts.join('\n\n'), MAX_DELIVERABLE) : null;
}
