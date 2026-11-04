/* Quests between departments (feature spec 2.4). An agent asks another department for work through the Vibe City MCP
   tool `request_quest` (mcp/server.ts). The request becomes an ordinary quest on the target's Hermes board, assigned to
   the target's lead agent, and Vibe City records where it came from. Guardrails, checked here and nowhere else:
   - the target department's allowlist decides who may give it work;
   - no handing work back: if the target has an open request to the requester, the requester cannot ask it back;
   - a daily cap per requesting department: over the cap the request waits for the CEO's approval.
   Quests created by the CEO are recorded with origin 'user', so the board can say who assigned what. */
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  QuestPolicySchema, type QuestCreate, type QuestCreated, type QuestOrigin, type QuestPolicy, type QuestRequestView, type QuestSummary,
} from '@vibe-city/shared';
import type { DepartmentService } from './departmentService.ts';
import { ConflictError, NotFoundError } from './errors.ts';

export const DEFAULT_POLICY: QuestPolicy = { allowFrom: '*', dailyCap: 5 };
const DAY_MS = 24 * 3600_000;
const FINISHED = new Set(['completed', 'cancelled', 'failed']);

export interface QuestRequestDeps {
  db: DatabaseSync;
  departments: DepartmentService;
  createQuest: (departmentId: string, input: QuestCreate) => Promise<QuestCreated>;
  listQuests: (departmentId: string) => Promise<QuestSummary[]>;
  now?: () => Date;
}

interface Row {
  id: string; from_department_id: string; to_department_id: string | null; to_label: string; title: string; objective: string;
  reason: string; state: QuestRequestView['state']; note: string | null; quest_id: string | null; created_at: string; decided_at: string | null;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class QuestRequestService {
  private d: QuestRequestDeps;
  private now: () => Date;
  constructor(d: QuestRequestDeps) { this.d = d; this.now = d.now ?? (() => new Date()); }

  // ---- MCP identity: one bearer token per department, stored hashed ---------------------------------------------

  /** A fresh token for the department's agents (rotates the old one). Only ever handed to Hermes' profile config. */
  issueToken(departmentId: string): string {
    this.d.departments.get(departmentId);
    const token = `vc_${randomBytes(24).toString('hex')}`;
    this.d.db.prepare('INSERT INTO agent_token (department_id, token_hash, created_at) VALUES (?, ?, ?) ON CONFLICT (department_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at')
      .run(departmentId, sha(token), this.iso());
    return token;
  }

  departmentForToken(token: string): string | null {
    const r = this.d.db.prepare('SELECT department_id FROM agent_token WHERE token_hash = ?').get(sha(token)) as { department_id: string } | undefined;
    if (!r) return null;
    try { const dept = this.d.departments.get(r.department_id); return dept.archivedAt ? null : dept.id; } catch { return null; }
  }

  // ---- policy -----------------------------------------------------------------------------------------------------

  policy(departmentId: string): QuestPolicy {
    this.d.departments.get(departmentId);
    const r = this.d.db.prepare('SELECT policy_json FROM quest_policy WHERE department_id = ?').get(departmentId) as { policy_json: string } | undefined;
    return r ? QuestPolicySchema.parse(JSON.parse(r.policy_json)) : DEFAULT_POLICY;
  }

  setPolicy(departmentId: string, patch: Partial<QuestPolicy>): QuestPolicy {
    const next = QuestPolicySchema.parse({ ...this.policy(departmentId), ...patch });
    if (Array.isArray(next.allowFrom)) for (const id of next.allowFrom) this.d.departments.get(id);
    this.d.db.prepare('INSERT INTO quest_policy (department_id, policy_json) VALUES (?, ?) ON CONFLICT (department_id) DO UPDATE SET policy_json = excluded.policy_json')
      .run(departmentId, JSON.stringify(next));
    return next;
  }

  // ---- requests ---------------------------------------------------------------------------------------------------

  /** Departments an agent can ask, with whether it is allowed (for the MCP list tool). */
  targets(fromDepartmentId: string) {
    return this.d.departments.list().filter((d) => d.id !== fromDepartmentId).map((d) => {
      const p = this.policy(d.id);
      return { name: d.name, purpose: d.purpose, ready: d.state === 'ready', accepts: p.allowFrom === '*' || p.allowFrom.includes(fromDepartmentId) };
    });
  }

  async request(input: { fromDepartmentId: string; department: string; title: string; objective: string; reason: string }): Promise<QuestRequestView> {
    const from = this.d.departments.get(input.fromDepartmentId);
    const key = input.department.trim().toLowerCase();
    const all = this.d.departments.list();
    const to = all.find((d) => d.id === input.department || d.name.toLowerCase() === key) ?? all.find((d) => d.name.toLowerCase().includes(key)) ?? null;
    const id = randomUUID();
    const base = { id, from: from.id, to: to?.id ?? null, label: to?.name ?? input.department, title: input.title, objective: input.objective, reason: input.reason };
    if (!to) return this.insert(base, 'rejected', `There is no department called "${input.department}".`);
    if (to.id === from.id) return this.insert(base, 'rejected', 'A department cannot request a quest from itself. Plan the work on your own board.');
    if (to.state !== 'ready') return this.insert(base, 'rejected', `${to.name} is not ready to take quests (${to.state}).`);
    const p = this.policy(to.id);
    if (p.allowFrom !== '*' && !p.allowFrom.includes(from.id)) return this.insert(base, 'rejected', `${to.name} does not accept work from ${from.name}. The CEO can change that in ${to.name}'s settings.`);
    if (await this.openRequestBack(to.id, from.id)) {
      return this.insert(base, 'rejected', `${to.name} is waiting on work from ${from.name}. Handing work back along the same chain is not allowed; finish yours first.`);
    }
    const since = new Date(this.now().getTime() - DAY_MS).toISOString();
    const used = (this.d.db.prepare("SELECT COUNT(*) AS n FROM quest_request WHERE from_department_id = ? AND created_at > ? AND state IN ('created', 'pending_approval')").get(from.id, since) as { n: number }).n;
    const cap = this.policy(from.id).dailyCap;
    if (used >= cap) return this.insert(base, 'pending_approval', `${from.name} has used its ${cap} agent-made quests for today. The CEO decides on this one.`);
    const row = this.insert(base, 'created', null);
    return this.create(row.id);
  }

  async approve(id: string): Promise<QuestRequestView> {
    const r = this.row(id);
    if (r.state !== 'pending_approval') throw new ConflictError(`request is ${r.state}`);
    return this.create(id);
  }

  reject(id: string): QuestRequestView {
    const r = this.row(id);
    if (r.state !== 'pending_approval') throw new ConflictError(`request is ${r.state}`);
    this.d.db.prepare("UPDATE quest_request SET state = 'rejected', note = 'Declined by the CEO.', decided_at = ? WHERE id = ?").run(this.iso(), id);
    return this.view(this.row(id));
  }

  get(id: string, fromDepartmentId?: string): QuestRequestView {
    const r = this.row(id);
    if (fromDepartmentId && r.from_department_id !== fromDepartmentId) throw new NotFoundError('request not found');
    return this.view(r);
  }

  list(limit = 50): QuestRequestView[] {
    return (this.d.db.prepare('SELECT * FROM quest_request ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as Row[]).map((r) => this.view(r));
  }

  /** Records who created a quest (the CEO, an agent, a schedule…). First writer wins. */
  recordOrigin(departmentId: string, questId: string, origin: QuestOrigin['origin'], from: { departmentId: string; requestId: string } | null = null) {
    this.d.db.prepare('INSERT OR IGNORE INTO quest_origin (quest_id, department_id, origin, from_department_id, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(questId, departmentId, origin, from?.departmentId ?? null, from?.requestId ?? null, this.iso());
  }

  origins(): QuestOrigin[] {
    const names = new Map(this.d.departments.list({ includeArchived: true }).map((d) => [d.id, d.name]));
    return (this.d.db.prepare('SELECT * FROM quest_origin ORDER BY created_at DESC LIMIT 2000').all() as { quest_id: string; department_id: string; origin: QuestOrigin['origin']; from_department_id: string | null; request_id: string | null }[])
      .map((r) => ({ questId: r.quest_id, departmentId: r.department_id, origin: r.origin, fromDepartmentId: r.from_department_id, fromName: r.from_department_id ? names.get(r.from_department_id) ?? null : null, requestId: r.request_id }));
  }

  // ---- internals --------------------------------------------------------------------------------------------------

  /** True when `a` has a request to `b` whose quest is still open (so `b` asking `a` would hand work back). */
  private async openRequestBack(a: string, b: string): Promise<boolean> {
    const rows = this.d.db.prepare("SELECT quest_id, state FROM quest_request WHERE from_department_id = ? AND to_department_id = ? AND state IN ('created', 'pending_approval')").all(a, b) as { quest_id: string | null; state: string }[];
    if (!rows.length) return false;
    if (rows.some((r) => r.state === 'pending_approval' || !r.quest_id)) return true;
    let quests: QuestSummary[] = [];
    try { quests = await this.d.listQuests(b); } catch { return true; } // unknown: be safe
    return rows.some((r) => { const q = quests.find((x) => x.id === r.quest_id); return !q || !FINISHED.has(q.status); });
  }

  private async create(id: string): Promise<QuestRequestView> {
    const r = this.row(id);
    const from = this.d.departments.get(r.from_department_id);
    try {
      const created = await this.d.createQuest(r.to_department_id!, {
        clientRequestId: r.id, title: r.title, objective: r.objective,
        instructions: `Requested by ${from.name}.${r.reason ? ` Reason: ${r.reason}` : ''} When you finish, write a short summary of the result on the quest so ${from.name} can read it.`,
      });
      this.recordOrigin(r.to_department_id!, created.questId, 'agent', { departmentId: from.id, requestId: r.id });
      this.d.db.prepare("UPDATE quest_request SET state = 'created', quest_id = ?, note = NULL, decided_at = ? WHERE id = ?").run(created.questId, this.iso(), id);
    } catch (e) {
      this.d.db.prepare("UPDATE quest_request SET state = 'failed', note = ?, decided_at = ? WHERE id = ?").run(`Could not create the quest: ${(e as Error).message}`.slice(0, 500), this.iso(), id);
    }
    return this.view(this.row(id));
  }

  private insert(b: { id: string; from: string; to: string | null; label: string; title: string; objective: string; reason: string }, state: Row['state'], note: string | null): QuestRequestView {
    const now = this.iso();
    this.d.db.prepare('INSERT INTO quest_request (id, from_department_id, to_department_id, to_label, title, objective, reason, state, note, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(b.id, b.from, b.to, b.label, b.title, b.objective, b.reason, state, note, now, state === 'rejected' ? now : null);
    return this.view(this.row(b.id));
  }

  private row(id: string): Row {
    const r = this.d.db.prepare('SELECT * FROM quest_request WHERE id = ?').get(id) as unknown as Row | undefined;
    if (!r) throw new NotFoundError('request not found');
    return r;
  }

  private view(r: Row): QuestRequestView {
    const name = (id: string | null) => { if (!id) return null; try { return this.d.departments.get(id).name; } catch { return null; } };
    return {
      id: r.id, fromDepartmentId: r.from_department_id, fromName: name(r.from_department_id) ?? 'unknown',
      toDepartmentId: r.to_department_id, toName: name(r.to_department_id) ?? r.to_label,
      title: r.title, objective: r.objective, reason: r.reason, state: r.state, note: r.note, questId: r.quest_id,
      createdAt: r.created_at, decidedAt: r.decided_at,
    };
  }

  private iso() { return this.now().toISOString(); }
}
