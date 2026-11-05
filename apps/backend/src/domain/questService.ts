import {
  HERMES_TASK_ID_RE, type ActivityEvent, type AttachmentView, type CancellationStatus, type QuestCreate, type QuestCreated,
  type QuestDetail, type QuestResults, type QuestSummary, type TaskNode,
} from '@vibe-city/shared';
import { HermesNotFoundError, HermesRejectedError } from '../hermes/ports.ts';
import type { KanbanApi, RawRun, TaskDetail } from '../hermes/kanbanApi.ts';
import { describeEvent } from './activity.ts';
import { ConflictError, NotFoundError } from './errors.ts';
import type { DepartmentService } from './departmentService.ts';
import { aggregateQuest, type AggNode } from './questAggregation.ts';
import { runState } from './runTracker.ts';
import { scrub } from './scrub.ts';

export const MAX_TREE_TASKS = 200;
export const MAX_TREE_DEPTH = 8;
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const CANCEL_MARKER = '[vibe-city] cancel-requested';
const MARKER_AUTHOR = 'vibe-city';
/** Comment author of the boss's answers to blocked tasks, as the agent sees them on the board. */
const ANSWER_AUTHOR = 'the boss (CEO)';
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const iso = (t: number | null | undefined) => (t == null ? null : new Date(t * 1000).toISOString());
const isTerminal = (s: string) => s === 'done' || s === 'archived';

interface Ctx {
  departmentId: string; board: string; deptName: string; maxRuntime: number | null;
  /** The lead's profile: quests are assigned to it. */
  lead: string;
  /** Every agent's profile -> agent key (lead included). */
  agents: Map<string, string>;
}
interface Tree {
  rootId: string;
  details: Map<string, TaskDetail>;
  depth: Map<string, number>;
  order: string[];
  truncated: boolean;
}

/** `teammates` are the other agents' profiles (empty: the lead does the work itself). */
export function buildQuestBody(q: { title: string; objective: string; instructions?: string }, teammates: string[]): string {
  return [
    `# Quest: ${q.title}`,
    '',
    '## Objective',
    q.objective,
    ...(q.instructions ? ['', '## Additional instructions', q.instructions] : []),
    '',
    '## How to execute (department workflow)',
    ...(teammates.length === 0
      ? [
        'You have no teammates: do the work yourself.',
        'Do not create Kanban tasks for any other profile. When the work is done, complete this task with a summary of the result and attach any output files.',
      ]
      : [
        'You own this quest. Do the work yourself, or, when parts of it can run independently, create one child Kanban task per part,',
        `assigned to one of your teammates (${teammates.map((t) => `"${t}"`).join(', ')}), with parents set to this task's id. Spread the parts across teammates: each one works in parallel.`,
        'Each child task must be self-contained: the teammate cannot see this quest, so put every instruction and input it needs in the child task.',
        'Do not assign tasks to any other profile. Complete this task with a summary of what you did and each child task id with what it covers.',
      ]),
  ].join('\n');
}

function extractObjective(body: string | null): string {
  if (!body) return '';
  const m = /## Objective\n([\s\S]*?)(?:\n## |\s*$)/.exec(body);
  return scrub((m ? m[1]! : body).trim(), 8000) ?? '';
}

export class QuestService {
  private depts: DepartmentService;
  private kanban: KanbanApi;
  private cancelling = new Map<string, Promise<CancellationStatus>>();

  constructor(depts: DepartmentService, kanban: KanbanApi) {
    this.depts = depts;
    this.kanban = kanban;
  }

  // ---- authorization / context -------------------------------------------------

  /** Board and profiles always come from the stored, verified department record, never from the request. */
  private ctx(departmentId: string, opts: { requireReady?: boolean } = {}): Ctx {
    const r = this.depts.getRow(departmentId); // 404 for unknown
    const agents = this.depts.agents(departmentId);
    const lead = agents[0]?.profile_ref;
    if (!r.hermes_board_ref || !lead || r.board_sync_state !== 'synced') throw new ConflictError('department is not synced with Hermes yet');
    if (opts.requireReady && agents.some((a) => !a.profile_ref)) throw new ConflictError('department is not synced with Hermes yet');
    if (opts.requireReady) {
      if (r.archived_at) throw new ConflictError('department is archived');
      if (r.provisioning_state !== 'ready') throw new ConflictError(`department is not ready (state: ${r.provisioning_state})`);
    }
    return {
      departmentId, board: r.hermes_board_ref, deptName: r.name, lead,
      agents: new Map(agents.filter((a) => a.profile_ref).map((a) => [a.profile_ref!, a.agent_key])),
      maxRuntime: this.depts.getInventory(departmentId).limits.maxTaskRuntimeSeconds,
    };
  }

  private agentKeyOf(ctx: Ctx, assignee: string | null): string | null {
    return assignee ? ctx.agents.get(assignee) ?? null : null;
  }

  /** The id must be a Hermes task id on THIS department's board, top-level and assigned to the department's lead. */
  private async resolveRoot(ctx: Ctx, questId: string): Promise<TaskDetail> {
    if (!HERMES_TASK_ID_RE.test(questId)) throw new NotFoundError('quest not found');
    let d: TaskDetail;
    try {
      d = await this.kanban.getTask(ctx.board, questId);
    } catch (e) {
      if (e instanceof HermesNotFoundError) throw new NotFoundError('quest not found');
      throw e;
    }
    if (d.links.parents.length > 0 || d.task.assignee !== ctx.lead) throw new NotFoundError('quest not found');
    return d;
  }

  // ---- tree ----------------------------------------------------------------------

  private async loadTree(ctx: Ctx, root: TaskDetail): Promise<Tree> {
    const details = new Map<string, TaskDetail>([[root.task.id, root]]);
    const depth = new Map<string, number>([[root.task.id, 0]]);
    const order = [root.task.id];
    let truncated = false;
    let frontier = [root.task.id];
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const c of details.get(id)!.links.children) if (!depth.has(c)) { depth.set(c, depth.get(id)! + 1); next.push(c); }
      }
      const fresh = next.filter((id) => !details.has(id));
      if (details.size + fresh.length > MAX_TREE_TASKS || (fresh.length && depth.get(fresh[0]!)! > MAX_TREE_DEPTH)) {
        truncated = true;
        break;
      }
      // bounded parallelism: a quest tree is small, but never fan out unboundedly against Hermes
      for (let i = 0; i < fresh.length; i += 6) {
        const batch = await Promise.all(fresh.slice(i, i + 6).map((id) => this.kanban.getTask(ctx.board, id)));
        for (const d of batch) { details.set(d.task.id, d); order.push(d.task.id); }
      }
      frontier = fresh;
    }
    return { rootId: root.task.id, details, depth, order, truncated };
  }

  private nodes(ctx: Ctx, tree: Tree): TaskNode[] {
    return tree.order.map((id) => {
      const d = tree.details.get(id)!;
      const t = d.task;
      const failed = t.status === 'blocked' && (!!t.last_failure_error || (t.consecutive_failures ?? 0) > 0);
      const lastRun: RawRun | undefined = d.runs.at(-1);
      return {
        id, title: t.title, agentKey: this.agentKeyOf(ctx, t.assignee), assignee: t.assignee, status: t.status,
        parentIds: d.links.parents, childIds: d.links.children, depth: tree.depth.get(id) ?? 0, failed,
        createdAt: iso(t.created_at), startedAt: iso(t.started_at), completedAt: iso(t.completed_at),
        summary: scrub(t.latest_summary ?? t.result ?? [...d.runs].reverse().find((r) => r.summary)?.summary ?? null),
        error: failed || t.status === 'blocked' ? scrub(t.last_failure_error ?? lastRun?.error ?? null) : null,
        blockReason: t.status === 'blocked' ? scrub(str([...d.events].reverse().find((e) => e.kind === 'blocked')?.payload?.reason), 2000) : null,
        attachmentCount: d.attachments.length,
        runs: d.runs.map((r) => ({ id: r.id, profile: r.profile, state: runState(r), startedAt: iso(r.started_at), endedAt: iso(r.ended_at) })),
      };
    });
  }

  private violations(nodes: TaskNode[], rootId: string): string[] {
    const out: string[] = [];
    for (const n of nodes) {
      if (n.id === rootId) continue;
      if (!n.assignee) out.push(`Task "${n.title}" (${n.id}) has no assignee and will not run.`);
      else if (n.agentKey === null) out.push(`Task "${n.title}" (${n.id}) is assigned to "${n.assignee}", which is not one of this department's agents.`);
    }
    return out;
  }

  private cancellation(tree: Tree): CancellationStatus {
    const root = tree.details.get(tree.rootId)!;
    const marker = root.comments.find((c) => c.author === MARKER_AUTHOR && c.body.startsWith(CANCEL_MARKER));
    const all = [...tree.details.values()];
    const remaining = all
      .filter((d) => !isTerminal(d.task.status) || d.runs.some((r) => r.ended_at === null))
      .map((d) => ({ taskId: d.task.id, status: d.task.status }));
    const requestedAtSec = marker?.created_at ?? null;
    const state = !marker ? 'none' : remaining.length === 0 ? 'confirmed' : 'requested';
    // Hermes' archive has no compare-and-set, so a task can finish in the instant before it is archived. A task with a
    // `completed` event counts as finished-before-cancel even if its status is now `archived`; its result is kept.
    const finishedBefore = (d: TaskDetail) => d.task.status === 'done' || d.events.some((e) => e.kind === 'completed');
    const archivedTaskIds = marker
      ? all.filter((d) => d.task.status === 'archived' && !finishedBefore(d) && d.events.some((e) => e.kind === 'archived' && e.created_at >= (requestedAtSec ?? 0))).map((d) => d.task.id)
      : [];
    const lastArchive = Math.max(0, ...all.flatMap((d) => d.events.filter((e) => e.kind === 'archived').map((e) => e.created_at)));
    return {
      state, requestedAt: iso(requestedAtSec), confirmedAt: state === 'confirmed' ? iso(lastArchive || requestedAtSec) : null,
      remaining: state === 'confirmed' ? [] : remaining,
      archivedTaskIds,
      alreadyFinishedTaskIds: marker ? all.filter(finishedBefore).map((d) => d.task.id) : [],
    };
  }

  private summarize(tree: Tree, nodes: TaskNode[], cancel: CancellationStatus): QuestSummary & { _truncated: boolean } {
    const agg: AggNode[] = nodes.map((n) => {
      const d = tree.details.get(n.id)!;
      return {
        id: n.id, status: n.status, failed: n.failed,
        everStarted: d.task.started_at != null || d.runs.length > 0,
        activeRun: d.runs.some((r) => r.ended_at === null),
        authorized: n.id === tree.rootId || n.agentKey !== null,
        hasChildren: n.childIds.length > 0,
      };
    });
    const a = aggregateQuest(tree.rootId, agg, cancel.state !== 'none');
    const rootTask = tree.details.get(tree.rootId)!.task;
    return {
      id: tree.rootId, title: rootTask.title, status: a.status, flags: a.flags, counts: a.counts,
      createdAt: iso(rootTask.created_at),
      completedAt: a.status === 'completed' ? iso(Math.max(...[...tree.details.values()].map((d) => d.task.completed_at ?? 0))) : null,
      _truncated: tree.truncated,
    };
  }

  // ---- queries -----------------------------------------------------------------------

  async list(departmentId: string): Promise<QuestSummary[]> {
    const ctx = this.ctx(departmentId);
    const tasks = await this.kanban.listBoardTasks(ctx.board, { includeArchived: true });
    const roots = tasks
      .filter((t) => t.assignee === ctx.lead && (t.link_counts?.parents ?? 0) === 0)
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
      .slice(0, 50);
    const out: QuestSummary[] = [];
    for (let i = 0; i < roots.length; i += 4) {
      const batch = await Promise.all(roots.slice(i, i + 4).map(async (r) => {
        const tree = await this.loadTree(ctx, await this.kanban.getTask(ctx.board, r.id));
        const { _truncated: _t, ...s } = this.summarize(tree, this.nodes(ctx, tree), this.cancellation(tree));
        return s;
      }));
      out.push(...batch);
    }
    return out;
  }

  async detail(departmentId: string, questId: string): Promise<QuestDetail> {
    const ctx = this.ctx(departmentId);
    const tree = await this.loadTree(ctx, await this.resolveRoot(ctx, questId));
    const nodes = this.nodes(ctx, tree);
    const cancellation = this.cancellation(tree);
    const { _truncated, ...summary } = this.summarize(tree, nodes, cancellation);
    const warnings: string[] = [];
    if (tree.truncated) warnings.push(`The task tree is larger than ${MAX_TREE_TASKS} tasks or ${MAX_TREE_DEPTH} levels; only part of it is shown.`);
    return {
      ...summary, departmentId, objective: extractObjective(tree.details.get(questId)!.task.body),
      tasks: nodes, violations: this.violations(nodes, questId), cancellation, warnings, truncated: _truncated,
    };
  }

  /**
   * The boss answers a blocked task of this quest: the answer goes on the task as a comment (the agent reads its
   * comments when it runs again), then the task is unblocked.
   */
  async answer(departmentId: string, questId: string, taskId: string, message: string): Promise<void> {
    const ctx = this.ctx(departmentId);
    const tree = await this.loadTree(ctx, await this.resolveRoot(ctx, questId));
    const t = tree.details.get(taskId);
    if (!t) throw new NotFoundError('task not found in this quest');
    if (t.task.status !== 'blocked') throw new ConflictError('this task is not waiting for input any more');
    await this.kanban.addComment(ctx.board, taskId, ANSWER_AUTHOR, message);
    await this.kanban.unblockTask(ctx.board, taskId);
  }

  async activity(departmentId: string, questId: string, limit = 200): Promise<ActivityEvent[]> {
    const ctx = this.ctx(departmentId);
    const tree = await this.loadTree(ctx, await this.resolveRoot(ctx, questId));
    const out: ActivityEvent[] = [];
    for (const d of tree.details.values()) {
      for (const e of d.events) {
        const desc = describeEvent(e);
        if (!desc) continue;
        out.push({ id: e.id, at: new Date(e.created_at * 1000).toISOString(), taskId: d.task.id, taskTitle: d.task.title, kind: e.kind, label: desc.label, detail: desc.detail });
      }
    }
    out.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
    return out.slice(-Math.min(Math.max(limit, 1), 1000));
  }

  private attachmentView(ctx: Ctx, questId: string, a: TaskDetail['attachments'][number]): AttachmentView {
    return {
      id: a.id, taskId: a.task_id, filename: scrub(a.filename, 200) ?? 'file', contentType: a.content_type, size: a.size,
      createdAt: iso(a.created_at), downloadUrl: `/api/departments/${ctx.departmentId}/quests/${questId}/attachments/${a.id}`,
    };
  }

  async results(departmentId: string, questId: string): Promise<QuestResults> {
    const ctx = this.ctx(departmentId);
    const tree = await this.loadTree(ctx, await this.resolveRoot(ctx, questId));
    const nodes = this.nodes(ctx, tree);
    const cancellation = this.cancellation(tree);
    const summary = this.summarize(tree, nodes, cancellation);
    return {
      questId, status: summary.status,
      leadSummary: nodes.find((n) => n.id === questId)?.summary ?? null,
      tasks: nodes.map((n) => ({
        taskId: n.id, title: n.title, agentKey: n.agentKey, status: n.status, summary: n.summary, error: n.error,
        attachments: tree.details.get(n.id)!.attachments.map((a) => this.attachmentView(ctx, questId, a)),
      })),
    };
  }

  /** Authorizes (department -> quest -> attachment) and returns the byte stream. Hermes paths never leave this layer. */
  async openAttachment(departmentId: string, questId: string, attachmentId: number): Promise<{ response: Response; filename: string; size: number; contentType: string | null }> {
    const ctx = this.ctx(departmentId);
    if (!Number.isSafeInteger(attachmentId) || attachmentId < 1) throw new NotFoundError('attachment not found');
    const tree = await this.loadTree(ctx, await this.resolveRoot(ctx, questId));
    const att = [...tree.details.values()].flatMap((d) => d.attachments).find((a) => a.id === attachmentId);
    if (!att) throw new NotFoundError('attachment not found');
    if (att.size > MAX_ATTACHMENT_BYTES) throw new ConflictError('attachment is too large to download through Vibe City');
    let response: Response;
    try {
      response = await this.kanban.downloadAttachment(ctx.board, attachmentId);
    } catch (e) {
      if (e instanceof HermesNotFoundError) throw new NotFoundError('attachment file is no longer available');
      throw e;
    }
    return { response, filename: att.filename, size: att.size, contentType: att.content_type };
  }

  // ---- creation ----------------------------------------------------------------------

  async create(departmentId: string, input: QuestCreate): Promise<QuestCreated> {
    const ctx = this.ctx(departmentId, { requireReady: true });
    const { task, warning } = await this.kanban.createTask(ctx.board, {
      title: input.title,
      body: buildQuestBody(input, [...ctx.agents.keys()].filter((p) => p !== ctx.lead)),
      assignee: ctx.lead,
      // Same clientRequestId -> Hermes returns the existing task instead of creating a duplicate.
      idempotency_key: `vibe-city:${departmentId}:${input.clientRequestId}`,
      ...(ctx.maxRuntime ? { max_runtime_seconds: ctx.maxRuntime } : {}),
    });
    return { questId: task.id, hermesBoardSlug: ctx.board, warnings: warning ? [scrub(warning, 500)!] : [] };
  }

  // ---- cancellation --------------------------------------------------------------------

  async cancellationStatus(departmentId: string, questId: string): Promise<CancellationStatus> {
    const ctx = this.ctx(departmentId);
    return this.cancellation(await this.loadTree(ctx, await this.resolveRoot(ctx, questId)));
  }

  /**
   * Safe cancellation. Hermes' terminate/reclaim only re-queues a task, so it is never used. Instead:
   *  1. record the intent durably in Hermes (a comment on the quest root);
   *  2. archive every unfinished task - running ones first, then deepest first. Archive is atomic: the task becomes
   *     terminal (so it can never be dispatched again) and only then does Hermes terminate its worker;
   *  3. re-read the whole tree and report `confirmed` only when no task is unfinished and no run is still open.
   * Finished (`done`) tasks are left untouched so their results survive. The loop re-reads the tree because the
   * lead can create tasks while we cancel; it ends when a pass finds nothing left (max 5 passes).
   */
  requestCancel(departmentId: string, questId: string): Promise<CancellationStatus> {
    const key = `${departmentId}:${questId}`;
    const running = this.cancelling.get(key);
    if (running) return running;
    const p = this.doCancel(departmentId, questId).finally(() => this.cancelling.delete(key));
    this.cancelling.set(key, p);
    return p;
  }

  private async doCancel(departmentId: string, questId: string): Promise<CancellationStatus> {
    const ctx = this.ctx(departmentId);
    const root = await this.resolveRoot(ctx, questId);
    let tree = await this.loadTree(ctx, root);
    const hasMarker = root.comments.some((c) => c.author === MARKER_AUTHOR && c.body.startsWith(CANCEL_MARKER));
    const unfinished = (t: Tree) => [...t.details.values()].filter((d) => !isTerminal(d.task.status) || d.runs.some((r) => r.ended_at === null));
    if (!hasMarker && unfinished(tree).length === 0) throw new ConflictError('quest has already finished; nothing to cancel');

    if (!hasMarker) await this.kanban.addComment(ctx.board, questId, MARKER_AUTHOR, `${CANCEL_MARKER} (department ${ctx.deptName})`);

    for (let pass = 0; pass < 5; pass++) {
      const targets = [...tree.details.values()]
        .filter((d) => !isTerminal(d.task.status))
        .sort((a, b) => Number(b.task.status === 'running') - Number(a.task.status === 'running') || (tree.depth.get(b.task.id) ?? 0) - (tree.depth.get(a.task.id) ?? 0));
      if (targets.length === 0) break;
      for (const t of targets) {
        try {
          // Re-check right before acting: a task that finished in the meantime keeps its result.
          const fresh = (await this.kanban.getTask(ctx.board, t.task.id)).task.status;
          if (isTerminal(fresh)) continue;
          await this.kanban.archiveTask(ctx.board, t.task.id);
        } catch (e) {
          if (e instanceof HermesNotFoundError || e instanceof HermesRejectedError) continue; // raced with another actor; the re-read decides
          throw e;
        }
      }
      tree = await this.loadTree(ctx, await this.resolveRoot(ctx, questId).catch(() => root));
    }
    // Final read: the marker comment and the post-archive states must come from Hermes, not from a stale snapshot.
    tree = await this.loadTree(ctx, await this.resolveRoot(ctx, questId));
    return this.cancellation(tree);
  }
}
