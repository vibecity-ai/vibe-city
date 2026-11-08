/* The NEAR AI Agent Market (brief 02, revised 2026-11-08): the company is one agent on market.near.ai.
   - register(): self-registration (`POST /v1/agents/register`); the aat_ token comes back once and stays server-side.
     useToken() is the fallback for an agent created in the market UI.
   Price, currency and going live are account-session calls, so the CEO does them on market.near.ai.
   - tick(): the poller (server.ts runs it every 45 s; the market says to poll even with a webhook, and a webhook needs
     a public HTTPS URL a local install does not have). Each new assignment becomes a quest on the Marketplace Agency
     (the floor the `market` quest unlocks; its agents get the token as MARKET_AGENT_TOKEN), a completed quest is submitted as the deliverable, request-changes opens a follow-up quest, acceptance is earnings.
   Errors from the market are free text: scrubbed before they reach a response. */
import type { DatabaseSync } from 'node:sqlite';
import {
  MARKET_CATEGORIES, MARKET_HANDLE_RE,
  type ListingDraft, type MarketJob, type MarketRegister, type MarketView, type QuestCreate, type QuestCreated, type QuestResults,
} from '@vibe-city/shared';
import type { ChatModel } from '../model/chatModel.ts';
import { ModelFailedError, ModelUnavailableError } from '../model/chatModel.ts';
import type { DepartmentService } from './departmentService.ts';
import { ConflictError, InvalidInputError, UpstreamError } from './errors.ts';
import { scrub } from './scrub.ts';
import { stableUuid } from './scheduleService.ts';
import { readSettings, secret, setSecrets, writeSettings } from '../routes/company.ts';

export interface MarketDeps {
  db: DatabaseSync;
  departments: Pick<DepartmentService, 'list'>;
  createQuest: (deptId: string, input: QuestCreate) => Promise<QuestCreated>;
  results: (deptId: string, questId: string) => Promise<QuestResults>;
  recordOrigin: (deptId: string, questId: string) => void;
  model: ChatModel;
  companyName: () => string;
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
interface Row { assignment_id: string; title: string; department_id: string; quest_id: string; state: MarketJob['state']; rounds: number; amount: string; token: string; note: string | null; updated_at: string }

export class MarketHttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const MAX_DELIVERABLE = 250_000; // bytes-ish; the market caps Markdown at 256 KiB
const FEE = 0.95; // the market keeps 5% of a completed job

export class MarketService {
  private d: MarketDeps;
  private base: string;
  private busy = false;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  constructor(d: MarketDeps) { this.d = d; this.base = (d.baseUrl ?? 'https://market.near.ai').replace(/\/$/, ''); }

  // ---- setup ------------------------------------------------------------------------------------------------------

  view(): MarketView {
    const s = readSettings(this.d.db);
    const jobs = (this.d.db.prepare('SELECT * FROM market_job ORDER BY created_at DESC LIMIT 50').all() as unknown as Row[]).map((r) => ({
      assignmentId: r.assignment_id, title: r.title, departmentId: r.department_id, questId: r.quest_id, state: r.state,
      rounds: r.rounds, amount: r.amount, token: r.token, note: r.note, updatedAt: r.updated_at,
    }));
    return {
      connected: !!this.token(), handle: s.marketAgentHandle, verifiedAt: s.marketVerifiedAt,
      lastPollAt: this.lastPollAt, lastError: this.lastError, agencyReady: this.agency() !== null, earnedCents: this.earnedCents(), jobs,
    };
  }

  /** Accepted jobs after the fee, counting USD and USDC 1:1 (the market pays either, no conversion). */
  earnedCents(): number {
    const rows = this.d.db.prepare("SELECT amount FROM market_job WHERE state = 'accepted'").all() as { amount: string }[];
    return rows.reduce((n, r) => n + Math.round((Number(r.amount) || 0) * 100 * FEE), 0);
  }

  async register(input: MarketRegister): Promise<void> {
    if (this.token()) throw new ConflictError(`The company is already on the market as @${readSettings(this.d.db).marketAgentHandle}.`);
    let r: { apiToken: string; handle: string };
    try {
      r = await this.call('POST', '/v1/agents/register', null, {
        handle: input.handle, name: input.name, category: input.category, ...(input.slaHours ? { sla_seconds: input.slaHours * 3600 } : {}),
      }) as { apiToken: string; handle: string };
    } catch (e) {
      if (e instanceof MarketHttpError && e.status === 409) throw new ConflictError(`@${input.handle} is taken on market.near.ai. Pick another handle.`);
      if (e instanceof MarketHttpError && e.status === 429) {
        throw new UpstreamError('market.near.ai is not taking self-registrations right now. Create the agent on market.near.ai and paste its token instead.');
      }
      throw this.mapped(e);
    }
    setSecrets(this.d.db, { marketAgentToken: r.apiToken });
    writeSettings(this.d.db, { marketAgentHandle: r.handle, marketVerifiedAt: null });
    await this.verify(r.apiToken);
  }

  /** A token pasted from the market UI: stored only if the market accepts it. */
  async useToken(handle: string, token: string): Promise<void> {
    try { await this.call('GET', '/v1/agents/me/assignments?limit=1', token); } catch (e) {
      if (e instanceof MarketHttpError && (e.status === 401 || e.status === 403)) throw new InvalidInputError('market.near.ai refused this token.');
      throw this.mapped(e);
    }
    setSecrets(this.d.db, { marketAgentToken: token });
    writeSettings(this.d.db, { marketAgentHandle: handle, marketVerifiedAt: new Date().toISOString() });
  }

  /** The Chief of Staff's listing copy, from the company's floors. Nothing is stored. */
  async draftListing(): Promise<ListingDraft> {
    if (!this.d.model.ready) throw new ModelUnavailableError('No chat model is configured. Set NEAR_AI_API_KEY and restart.');
    const floors = this.d.departments.list().map((d) => `- ${d.name}: ${d.purpose || 'no purpose written'}`);
    const raw = await this.d.model.complete([
      { role: 'system', content: [
        `Write a listing for "${this.d.companyName()}" on market.near.ai, a marketplace where buyers hire AI agents for jobs paid in USDC.`,
        'The company is one agent; each job goes to the department that fits. Departments:', floors.join('\n') || '- none yet',
        'Promise only what these departments can deliver. Reply with JSON only:',
        `{"handle": "<3-30 chars, lowercase letters, digits, dashes, starts with a letter>", "name": "<max 80 chars>", "category": one of ${MARKET_CATEGORIES.map((c) => `"${c}"`).join(', ')}, "tagline": "<one sentence>", "description": "<max 200 chars>", "priceUsdc": <number per job>, "slaHours": <integer>, "deliverables": ["<what a buyer gets>"]}`,
      ].join('\n') },
    ], { maxTokens: 4000 }); // reasoning models spend this on thinking before the JSON
    return clampListing(raw, this.d.companyName());
  }

  // ---- the poller -------------------------------------------------------------------------------------------------

  async tick(): Promise<void> {
    const token = this.token();
    if (!token || this.busy) return;
    this.busy = true;
    try {
      const { assignments } = await this.call('GET', '/v1/agents/me/assignments?status=all&limit=100', token) as { assignments: Item[] };
      const now = new Date().toISOString();
      if (!readSettings(this.d.db).marketVerifiedAt) writeSettings(this.d.db, { marketVerifiedAt: now });
      let error: string | null = null;
      for (const it of assignments) {
        try { await this.step(it, token); } catch (e) { error = this.message(e); this.note(it.assignment.assignmentId, error); }
      }
      this.lastPollAt = now;
      this.lastError = error;
    } catch (e) {
      this.lastError = this.message(e);
    } finally {
      this.busy = false;
    }
  }

  private async step(it: Item, token: string): Promise<void> {
    const a = it.assignment, id = a.assignmentId;
    const row = this.d.db.prepare('SELECT * FROM market_job WHERE assignment_id = ?').get(id) as Row | undefined;
    const path = `/v1/assignments/${encodeURIComponent(id)}`;
    if (!row) {
      if (a.status !== 'in_progress') return; // only new work; a finished or cancelled one was never ours to do
      const dept = this.agency();
      if (!dept) throw new Error('Hire the Marketplace Agency to take market jobs.');
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
      if (!md) return this.set(id, 'failed', 'The quest finished without a written result; nothing was submitted.');
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
      instructions: 'A buyer on the NEAR AI Agent Market hired the company for this. Your final result is sent to the buyer as the deliverable, in Markdown: write the complete work there, not a note about it.',
    });
    this.d.recordOrigin(deptId, questId);
    return questId;
  }

  /** The ready Marketplace Agency floor, if the CEO hired one. */
  private agency(): string | null {
    const ids = new Set((this.d.db.prepare("SELECT id FROM department WHERE template_id = 'marketplace-agency'").all() as { id: string }[]).map((r) => r.id));
    return this.d.departments.list().find((d) => ids.has(d.id) && d.state === 'ready')?.id ?? null;
  }

  private async verify(token: string) {
    try {
      await this.call('GET', '/v1/agents/me/assignments?limit=1', token);
      writeSettings(this.d.db, { marketVerifiedAt: new Date().toISOString() });
    } catch { /* the next poll verifies it */ }
  }

  // ---- internals --------------------------------------------------------------------------------------------------

  private token() { return secret(this.d.db, 'marketAgentToken'); }
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

/** The model's listing, made valid for the register form (it edits every field before anything is sent). */
export function clampListing(raw: string, company: string): ListingDraft {
  let o: Record<string, unknown> | null = null;
  const m = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').match(/\{[\s\S]*\}/);
  try { if (m) o = JSON.parse(m[0]) as Record<string, unknown>; } catch { /* below */ }
  // a draft of defaults is worse than none: say it failed so the CEO can ask again
  if (!o || typeof o.tagline !== 'string' || !o.tagline.trim()) throw new ModelFailedError('The Chief of Staff could not write the listing. Try again.');
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+/g, '-').slice(0, 30).replace(/-+$/, '');
  let handle = slug(str(o.handle, 60));
  if (!MARKET_HANDLE_RE.test(handle)) handle = slug(company) || 'vibe-city-agent';
  if (!MARKET_HANDLE_RE.test(handle)) handle = 'vibe-city-agent';
  const category = (MARKET_CATEGORIES as readonly string[]).includes(o.category as string) ? (o.category as ListingDraft['category']) : 'other';
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return {
    handle, name: str(o.name, 80) || company.slice(0, 80), category,
    tagline: str(o.tagline, 200), description: str(o.description, 200),
    priceUsdc: Math.round(num(o.priceUsdc, 10) * 100) / 100, slaHours: Math.min(720, Math.max(1, Math.round(num(o.slaHours, 24)))),
    deliverables: Array.isArray(o.deliverables) ? o.deliverables.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, 200)).filter(Boolean).slice(0, 8) : [],
  };
}
