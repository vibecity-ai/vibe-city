/** What Vibe City reads from Hermes Kanban (fields verified against Hermes 2026.9.24). */
export interface RawTask {
  id: string;
  title: string;
  body: string | null;
  assignee: string | null;
  status: 'triage' | 'todo' | 'ready' | 'running' | 'blocked' | 'scheduled' | 'review' | 'done' | 'archived';
  created_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
  last_failure_error: string | null;
  consecutive_failures: number | null;
  block_kind: string | null;
  latest_summary?: string | null;
  link_counts?: { parents: number; children: number };
}

export interface RawRun {
  id: number;
  task_id: string;
  profile: string | null;
  status: string;
  outcome: string | null;
  started_at: number | null;
  ended_at: number | null;
  summary: string | null;
  error: string | null;
}

export interface RawEvent {
  id: number;
  task_id: string;
  run_id: number | null;
  kind: string;
  payload: Record<string, unknown> | null;
  created_at: number;
}

export interface RawComment { id: number; task_id: string; author: string; body: string; created_at: number }

/** `stored_path` is deliberately not modeled: it must never leave the adapter layer. */
export interface RawAttachment {
  id: number;
  task_id: string;
  filename: string;
  content_type: string | null;
  size: number;
  created_at: number | null;
}

export interface TaskDetail {
  task: RawTask;
  links: { parents: string[]; children: string[] };
  comments: RawComment[];
  events: RawEvent[];
  attachments: RawAttachment[];
  runs: RawRun[];
}

export interface CreateTaskInput {
  title: string;
  body?: string;
  assignee?: string;
  parents?: string[];
  idempotency_key?: string;
  max_runtime_seconds?: number;
}

/** Narrow port over Hermes Kanban so quest logic can be tested without Hermes. */
export interface KanbanApi {
  /** All tasks of a board (flattened across columns), optionally including archived ones. */
  listBoardTasks(board: string, opts?: { includeArchived?: boolean }): Promise<RawTask[]>;
  getTask(board: string, id: string): Promise<TaskDetail>;
  createTask(board: string, input: CreateTaskInput): Promise<{ task: RawTask; warning?: string }>;
  /**
   * Archive = terminal status (never redispatched) + the active worker is terminated by Hermes.
   * NOTE: Hermes' `DELETE /tasks/{id}` is a hard delete and is never used.
   */
  archiveTask(board: string, id: string): Promise<void>;
  addComment(board: string, id: string, author: string, body: string): Promise<void>;
  /** Streams an attachment's bytes. The caller must have authorized (board, attachment) first. */
  downloadAttachment(board: string, attachmentId: number): Promise<Response>;
}
