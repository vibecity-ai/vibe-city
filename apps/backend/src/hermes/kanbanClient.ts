import { HermesHttp } from './http.ts';
import type { CreateTaskInput, KanbanApi, RawAttachment, RawTask, TaskDetail } from './kanbanApi.ts';

export type { TaskDetail, RawRun as HermesRun } from './kanbanApi.ts';

export interface KanbanClientOptions {
  baseUrl: string; // e.g. http://127.0.0.1:9119
  sessionToken: string; // server-side only; never sent to the browser
}

const q = (board: string, extra = '') => `?board=${encodeURIComponent(board)}${extra}`;

/** Thin client over Hermes' kanban dashboard plugin (/api/plugins/kanban). */
export class KanbanClient implements KanbanApi {
  private http: HermesHttp;
  constructor(opts: KanbanClientOptions) {
    this.http = new HermesHttp({ baseUrl: opts.baseUrl, sessionToken: opts.sessionToken });
  }

  private p(path: string) {
    return `/api/plugins/kanban${path}`;
  }

  // ---- phase 0 / integration helpers ----
  listBoards() {
    return this.http.json<{ boards: { slug: string; name: string; archived: boolean }[] }>('GET', this.p('/boards'));
  }
  createBoard(slug: string, name: string, defaultWorkdir?: string) {
    return this.http.json<{ board: { slug: string } }>('POST', this.p('/boards'), {
      body: { slug, name, ...(defaultWorkdir ? { default_workdir: defaultWorkdir } : {}) },
    });
  }
  getBoard(board: string) {
    return this.http.json<{ columns: { name: string; tasks: RawTask[] }[] }>('GET', this.p(`/board${q(board)}`));
  }
  listAttachments(board: string, id: string) {
    return this.http.json<{ attachments: (RawAttachment & { stored_path?: string })[] }>('GET', this.p(`/tasks/${encodeURIComponent(id)}/attachments${q(board)}`));
  }

  // ---- KanbanApi ----
  async listBoardTasks(board: string, opts: { includeArchived?: boolean } = {}): Promise<RawTask[]> {
    const j = await this.http.json<{ columns: { name: string; tasks: RawTask[] }[] }>(
      'GET', this.p(`/board${q(board, opts.includeArchived ? '&include_archived=true' : '')}`));
    return j.columns.flatMap((c) => c.tasks);
  }

  async getTask(board: string, id: string): Promise<TaskDetail> {
    const j = await this.http.json<TaskDetail & { attachments: (RawAttachment & { stored_path?: string })[] }>(
      'GET', this.p(`/tasks/${encodeURIComponent(id)}${q(board)}`));
    return {
      task: j.task, links: j.links, comments: j.comments ?? [], events: j.events ?? [], runs: j.runs ?? [],
      // strip stored_path at the boundary so no caller can leak it
      attachments: (j.attachments ?? []).map(({ id: aid, task_id, filename, content_type, size, created_at }) => ({ id: aid, task_id, filename, content_type, size, created_at })),
    };
  }

  createTask(board: string, input: CreateTaskInput) {
    return this.http.json<{ task: RawTask; warning?: string }>('POST', this.p(`/tasks${q(board)}`), { body: input });
  }

  async archiveTask(board: string, id: string): Promise<void> {
    await this.http.json('PATCH', this.p(`/tasks/${encodeURIComponent(id)}${q(board)}`), { body: { status: 'archived' } });
  }

  async addComment(board: string, id: string, author: string, body: string): Promise<void> {
    await this.http.json('POST', this.p(`/tasks/${encodeURIComponent(id)}/comments${q(board)}`), { body: { author, body } });
  }

  async unblockTask(board: string, id: string): Promise<void> {
    await this.http.json('PATCH', this.p(`/tasks/${encodeURIComponent(id)}${q(board)}`), { body: { status: 'ready' } });
  }

  downloadAttachment(board: string, attachmentId: number): Promise<Response> {
    return this.http.raw('GET', this.p(`/attachments/${attachmentId}${q(board)}`), { timeoutMs: 60_000 });
  }
}
