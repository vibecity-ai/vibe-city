import { HermesAuthError, HermesNotFoundError, HermesRejectedError, HermesUnavailableError } from '../hermes/ports.ts';
import type { CreateTaskInput, KanbanApi, RawAttachment, UploadFile, RawComment, RawEvent, RawRun, RawTask, TaskDetail } from '../hermes/kanbanApi.ts';

type Status = RawTask['status'];
interface FTask extends RawTask { parents: string[] }
interface FAttach extends RawAttachment { bytes: Uint8Array; stored_path: string }
interface FBoard {
  tasks: Map<string, FTask>;
  runs: RawRun[];
  events: RawEvent[];
  comments: RawComment[];
  attachments: FAttach[];
  idem: Map<string, string>;
}

let seq = 0;

/** In-memory Hermes Kanban with the semantics Vibe City relies on (links, archive, idempotency, board isolation). */
export class FakeKanban implements KanbanApi {
  online = true;
  authOk = true;
  gatewayWarning: string | null = null;
  boards = new Map<string, FBoard>();
  calls: string[] = [];
  /** Runs before each archive call: lets a test simulate a task finishing/spawning mid-cancellation. */
  beforeArchive: ((board: string, id: string) => void) | null = null;
  /** Simulates a worker that outlives its archive (run not ended): cancellation must stay pending. */
  archiveKeepsRunOpen = false;
  /** Runs at the start of getTask with the 1-based call count for that task id. */
  beforeGetTask: ((board: string, id: string, nth: number) => void) | null = null;
  private getCounts = new Map<string, number>();
  created: CreateTaskInput[] = [];
  private faults: { method: string; err: Error; times: number }[] = [];
  private clock = 1_700_000_000;

  addBoard(slug: string) {
    this.boards.set(slug, { tasks: new Map(), runs: [], events: [], comments: [], attachments: [], idem: new Map() });
  }
  failNext(method: string, err: Error, times = 1) {
    this.faults.push({ method, err, times });
  }
  private now() { return (this.clock += 1); }

  private enter(method: string, args: unknown[] = []) {
    this.calls.push(`${method}(${args.join(',')})`);
    if (!this.online) throw new HermesUnavailableError('Hermes dashboard unreachable');
    if (!this.authOk) throw new HermesAuthError('Hermes rejected the session token');
    const f = this.faults.find((x) => x.method === method && x.times > 0);
    if (f) { f.times -= 1; throw f.err; }
  }
  private board(slug: string): FBoard {
    const b = this.boards.get(slug);
    if (!b) throw new HermesNotFoundError(`board ${slug} does not exist`);
    return b;
  }
  private task(b: FBoard, id: string): FTask {
    const t = b.tasks.get(id);
    if (!t) throw new HermesNotFoundError(`task ${id} not found`);
    return t;
  }
  private event(b: FBoard, task_id: string, kind: string, payload: Record<string, unknown> | null = null, run_id: number | null = null) {
    const id = b.events.length ? b.events[b.events.length - 1]!.id + 1 : 1;
    const e = { id, task_id, run_id, kind, payload, created_at: this.now() };
    b.events.push(e);
    return e;
  }
  private satisfied(b: FBoard, t: FTask) {
    return t.parents.every((p) => ['done', 'archived'].includes(b.tasks.get(p)?.status ?? 'done'));
  }

  // ---- test controls (simulate Hermes/worker progress) ----

  seedTask(board: string, o: Partial<FTask> & { title: string; id?: string; parents?: string[] }): FTask {
    const b = this.board(board);
    const id = o.id ?? `t_${(++seq).toString(16).padStart(8, '0')}`;
    const t: FTask = {
      created_at: this.now(), started_at: null, completed_at: null, result: null, last_failure_error: null,
      consecutive_failures: 0, block_kind: null, body: null, assignee: null, status: 'ready',
      ...o, id, parents: o.parents ?? [],
    };
    if (t.parents.length && t.status === 'ready' && !this.satisfied(b, t)) t.status = 'todo';
    b.tasks.set(id, t);
    this.event(b, id, 'created', { assignee: t.assignee, status: t.status, parents: t.parents });
    return t;
  }
  startRun(board: string, id: string, profile: string): RawRun {
    const b = this.board(board);
    const t = this.task(b, id);
    t.status = 'running';
    t.started_at ??= this.now();
    const run: RawRun = { id: b.runs.length + 1, task_id: id, profile, status: 'running', outcome: null, started_at: this.now(), ended_at: null, summary: null, error: null };
    b.runs.push(run);
    this.event(b, id, 'claimed', null, run.id);
    return run;
  }
  complete(board: string, id: string, summary: string) {
    const b = this.board(board);
    const t = this.task(b, id);
    for (const r of b.runs.filter((x) => x.task_id === id && x.ended_at === null)) Object.assign(r, { status: 'done', outcome: 'completed', ended_at: this.now(), summary });
    t.status = 'done';
    t.completed_at = this.now();
    t.latest_summary = summary;
    this.event(b, id, 'completed', { summary });
    this.promote(b);
  }
  fail(board: string, id: string, error: string) {
    const b = this.board(board);
    const t = this.task(b, id);
    for (const r of b.runs.filter((x) => x.task_id === id && x.ended_at === null)) Object.assign(r, { status: 'crashed', outcome: 'crashed', ended_at: this.now(), error });
    Object.assign(t, { status: 'blocked', last_failure_error: error, consecutive_failures: 2 });
    this.event(b, id, 'gave_up', { error });
  }
  attach(board: string, taskId: string, filename: string, text: string, stored_path = `/home/u/.hermes/kanban/boards/${board}/attachments/${taskId}/${filename}`): FAttach {
    const b = this.board(board);
    const bytes = new TextEncoder().encode(text);
    const a: FAttach = { id: b.attachments.length + 1, task_id: taskId, filename, content_type: null, size: bytes.length, created_at: this.now(), uploaded_by: null, bytes, stored_path };
    b.attachments.push(a);
    this.event(b, taskId, 'attached', { filename });
    return a;
  }
  private promote(b: FBoard) {
    for (const t of b.tasks.values()) if (t.status === 'todo' && this.satisfied(b, t)) t.status = 'ready';
  }
  statusOf(board: string, id: string): Status { return this.task(this.board(board), id).status; }
  commentsOf(board: string) { return this.board(board).comments; }

  // ---- KanbanApi ----

  async listBoardTasks(board: string, opts: { includeArchived?: boolean } = {}): Promise<RawTask[]> {
    this.enter('listBoardTasks', [board]);
    const b = this.board(board);
    return [...b.tasks.values()]
      .filter((t) => opts.includeArchived || t.status !== 'archived')
      .map((t) => ({ ...t, link_counts: { parents: t.parents.length, children: [...b.tasks.values()].filter((c) => c.parents.includes(t.id)).length } }));
  }

  async getTask(board: string, id: string): Promise<TaskDetail> {
    this.enter('getTask', [board, id]);
    const nth = (this.getCounts.get(`${board}/${id}`) ?? 0) + 1;
    this.getCounts.set(`${board}/${id}`, nth);
    this.beforeGetTask?.(board, id, nth);
    const b = this.board(board);
    const t = this.task(b, id);
    return {
      task: { ...t, latest_summary: t.latest_summary ?? b.runs.filter((r) => r.task_id === id && r.summary).at(-1)?.summary ?? null },
      links: { parents: [...t.parents], children: [...b.tasks.values()].filter((c) => c.parents.includes(id)).map((c) => c.id).sort() },
      comments: b.comments.filter((c) => c.task_id === id),
      events: b.events.filter((e) => e.task_id === id),
      attachments: b.attachments.filter((a) => a.task_id === id).map(({ bytes: _b, stored_path: _s, ...a }) => a),
      runs: b.runs.filter((r) => r.task_id === id),
    };
  }

  async createTask(board: string, input: CreateTaskInput): Promise<{ task: RawTask; warning?: string }> {
    this.enter('createTask', [board]);
    this.created.push(input);
    const b = this.board(board);
    if (input.idempotency_key) {
      const existing = b.idem.get(input.idempotency_key);
      if (existing) return { task: this.task(b, existing) };
    }
    for (const p of input.parents ?? []) this.task(b, p);
    const t = this.seedTask(board, { title: input.title, body: input.body ?? null, assignee: input.assignee ?? null, parents: input.parents });
    if (input.idempotency_key) b.idem.set(input.idempotency_key, t.id);
    return { task: t, ...(this.gatewayWarning ? { warning: this.gatewayWarning } : {}) };
  }

  async archiveTask(board: string, id: string): Promise<void> {
    this.enter('archiveTask', [board, id]);
    this.beforeArchive?.(board, id);
    const b = this.board(board);
    const t = this.task(b, id);
    if (t.status === 'archived') throw new HermesRejectedError('already archived');
    if (!this.archiveKeepsRunOpen) for (const r of b.runs.filter((x) => x.task_id === id && x.ended_at === null)) Object.assign(r, { status: 'reclaimed', outcome: 'reclaimed', ended_at: this.now(), summary: 'task archived with run still active' });
    t.status = 'archived';
    this.event(b, id, 'archived');
    this.promote(b); // Hermes: archived parents no longer block their children
  }

  async addComment(board: string, id: string, author: string, body: string): Promise<void> {
    this.enter('addComment', [board, id]);
    const b = this.board(board);
    this.task(b, id);
    b.comments.push({ id: b.comments.length + 1, task_id: id, author, body, created_at: this.now() });
  }

  async unblockTask(board: string, id: string): Promise<void> {
    this.enter('unblockTask', [board, id]);
    const t = this.task(this.board(board), id);
    if (t.status !== 'blocked') throw new HermesRejectedError(`status transition to 'ready' not valid from ${t.status}`);
    Object.assign(t, { status: 'ready', consecutive_failures: 0 });
    this.event(this.board(board), id, 'unblocked');
  }
  /** The agent asks for input: blocked with a reason, not a failure. */
  block(board: string, id: string, reason: string) {
    const b = this.board(board);
    for (const r of b.runs.filter((x) => x.task_id === id && x.ended_at === null)) Object.assign(r, { status: 'blocked', outcome: 'blocked', ended_at: this.now() });
    this.task(b, id).status = 'blocked';
    this.event(b, id, 'blocked', { reason });
  }

  async downloadAttachment(board: string, attachmentId: number): Promise<Response> {
    this.enter('downloadAttachment', [board, attachmentId]);
    const a = this.board(board).attachments.find((x) => x.id === attachmentId);
    if (!a) throw new HermesNotFoundError('attachment not found');
    return new Response(a.bytes as BodyInit, { status: 200, headers: { 'content-type': a.content_type ?? 'application/octet-stream' } });
  }

  async uploadAttachment(board: string, taskId: string, file: UploadFile, uploadedBy: string): Promise<RawAttachment> {
    this.enter('uploadAttachment', [board, taskId, file.filename]);
    const b = this.board(board);
    this.task(b, taskId);
    // Hermes' rules: basename only, no leading dots, a free name on collision
    const base = file.filename.split(/[\\/]/).pop()!.replace(/^\.+/, '').slice(0, 200);
    if (!base) throw new HermesRejectedError('Hermes 400: invalid filename');
    let name = base;
    for (let n = 1; b.attachments.some((x) => x.task_id === taskId && x.filename === name); n++) name = base.replace(/(\.[^.]*)?$/, `-${n}$1`);
    const a: FAttach = {
      id: b.attachments.length + 1, task_id: taskId, filename: name, content_type: file.contentType, size: file.bytes.length,
      created_at: this.now(), uploaded_by: uploadedBy, bytes: file.bytes, stored_path: `/home/u/.hermes/kanban/boards/${board}/attachments/${taskId}/${name}`,
    };
    b.attachments.push(a);
    this.event(b, taskId, 'attached', { filename: name });
    const { bytes: _b, stored_path: _s, ...view } = a;
    return view;
  }
}
