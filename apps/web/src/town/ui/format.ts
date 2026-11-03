import type { QuestDetail, QuestStatus, TaskNode } from '@vibe-city/shared';

export interface StatusInfo { label: string; tone: 'neutral' | 'active' | 'good' | 'warn' | 'bad'; hint: string }

/** Plain-language status. `completed` is only ever shown when Hermes shows every task in the tree done. */
export const STATUS: Record<QuestStatus, StatusInfo> = {
  queued: { label: 'Queued', tone: 'neutral', hint: 'Waiting for the chief to start.' },
  planning: { label: 'Chief planning', tone: 'active', hint: 'The chief is running and has not created worker tasks yet.' },
  running: { label: 'In progress', tone: 'active', hint: 'Work is running or waiting to be dispatched.' },
  awaiting_input: { label: 'Needs input', tone: 'warn', hint: 'A task is blocked and waiting for a person.' },
  in_review: { label: 'In review', tone: 'warn', hint: 'A task is waiting for review.' },
  failed: { label: 'Failed', tone: 'bad', hint: 'Work stopped because a task failed.' },
  completed: { label: 'Completed', tone: 'good', hint: 'Every task in the quest is done.' },
  cancelling: { label: 'Cancelling', tone: 'warn', hint: 'Cancellation was requested but Hermes has not confirmed that everything stopped.' },
  cancelled: { label: 'Cancelled', tone: 'neutral', hint: 'Hermes confirms no task is active and none can be restarted.' },
};

export const canCancel = (s: QuestStatus) => s !== 'completed' && s !== 'cancelled';

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** What the chief finishing means, without implying the quest is done. */
export function planningNote(q: Pick<QuestDetail, 'flags' | 'status'>): string | null {
  if (q.flags.planningComplete && q.status !== 'completed' && q.status !== 'cancelled' && q.status !== 'cancelling') {
    return 'The chief has finished planning. The quest is complete only when all worker tasks are done.';
  }
  if (q.flags.planningComplete && !q.flags.delegated && q.status === 'completed') return 'The chief finished without creating worker tasks.';
  return null;
}

export interface TreeRow { node: TaskNode; depth: number }

/** Flattens the task graph depth-first for display. A task with several parents appears once (under its first parent). */
export function treeRows(nodes: TaskNode[]): TreeRow[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const rows: TreeRow[] = [];
  const walk = (id: string, depth: number) => {
    const n = byId.get(id);
    if (!n || seen.has(id)) return;
    seen.add(id);
    rows.push({ node: n, depth });
    for (const c of n.childIds) walk(c, depth + 1);
  };
  const root = nodes.find((n) => n.depth === 0) ?? nodes[0];
  if (root) walk(root.id, 0);
  for (const n of nodes) if (!seen.has(n.id)) walk(n.id, n.depth); // orphans (truncated trees)
  return rows;
}

/** Stable idempotency key: the same form content keeps the same id across retries; edited content gets a new one. */
export function requestIdFor(fingerprint: string, prev: { fingerprint: string; id: string } | null, gen: () => string): { fingerprint: string; id: string } {
  return prev && prev.fingerprint === fingerprint ? prev : { fingerprint, id: gen() };
}
