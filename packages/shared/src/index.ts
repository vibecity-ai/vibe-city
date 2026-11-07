export * from './schemas.ts';

/** Subset of Hermes Kanban task fields Vibe City reads (verified against Hermes 2026.9.24). */
export type HermesTaskStatus =
  | 'triage' | 'todo' | 'ready' | 'running' | 'blocked'
  | 'scheduled' | 'review' | 'done' | 'archived';

export interface HermesTask {
  id: string;
  title: string;
  body: string | null;
  assignee: string | null;
  status: HermesTaskStatus;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
  last_failure_error: string | null;
}
export * from './templates/index.ts';
