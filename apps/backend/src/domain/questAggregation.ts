import type { QuestStatus } from '@vibe-city/shared';

type TaskStatus = 'triage' | 'todo' | 'ready' | 'running' | 'blocked' | 'scheduled' | 'review' | 'done' | 'archived';

export interface AggNode {
  id: string;
  status: TaskStatus;
  /** blocked after a failure (circuit breaker / crash), as opposed to a deliberate "needs input" block */
  failed: boolean;
  /** this task has (or ever had) a started run */
  everStarted: boolean;
  /** a run exists that has not ended */
  activeRun: boolean;
  /** same-department check: assignee is the department's chief or worker */
  authorized: boolean;
  hasChildren: boolean;
}

export interface Aggregate {
  status: QuestStatus;
  flags: {
    planningComplete: boolean;
    delegated: boolean;
    hasFailures: boolean;
    hasBlocked: boolean;
    idle: boolean;
    unauthorizedAssignees: boolean;
  };
  counts: { tasks: number; done: number; running: number; pending: number; blocked: number; failed: number; archived: number };
}

const PENDING: TaskStatus[] = ['triage', 'todo', 'ready', 'scheduled'];

/**
 * Derives a quest's status from its WHOLE task tree (root + all descendants). Hermes parent links are execution
 * dependencies, so the chief's task is routinely `done` while worker tasks have not started: root status alone
 * says nothing about the quest. No percentages are produced, only counts.
 *
 * Rules, first match wins ("live" = not done and not archived):
 *  1. cancellation requested: no live task and no active run -> cancelled (or completed if everything had finished);
 *     otherwise cancelling.
 *  2. no live task: any archived task -> cancelled (stopped via Hermes), else completed.
 *  3. any running task or active run -> planning if only the chief is running and no worker tasks exist, else running.
 *  4. any live task that failed -> failed.
 *  5. any live task in review -> in_review.
 *  6. any live task blocked (not failed) -> awaiting_input.
 *  7. only pending tasks (ready/todo/triage/scheduled) remain -> queued if nothing ever started, else running (idle).
 */
export function aggregateQuest(rootId: string, nodes: AggNode[], cancelRequested: boolean): Aggregate {
  const root = nodes.find((n) => n.id === rootId);
  const live = nodes.filter((n) => n.status !== 'done' && n.status !== 'archived');
  const archived = nodes.filter((n) => n.status === 'archived');
  const anyActive = nodes.some((n) => n.status === 'running' || n.activeRun);
  const failedLive = live.filter((n) => n.failed);
  const blockedLive = live.filter((n) => n.status === 'blocked' && !n.failed);

  const counts = {
    tasks: nodes.length,
    done: nodes.filter((n) => n.status === 'done').length,
    running: nodes.filter((n) => n.status === 'running').length,
    pending: nodes.filter((n) => PENDING.includes(n.status)).length,
    blocked: blockedLive.length,
    failed: failedLive.length,
    archived: archived.length,
  };
  const flags = {
    planningComplete: root?.status === 'done',
    delegated: nodes.length > 1,
    hasFailures: failedLive.length > 0,
    hasBlocked: blockedLive.length > 0,
    idle: false,
    unauthorizedAssignees: nodes.some((n) => !n.authorized),
  };

  const done = (status: QuestStatus): Aggregate => ({ status, flags, counts });

  if (cancelRequested) {
    if (live.length === 0 && !anyActive) return done(archived.length ? 'cancelled' : 'completed');
    return done('cancelling');
  }
  if (live.length === 0 && !anyActive) return done(archived.length ? 'cancelled' : 'completed');
  if (anyActive) {
    const onlyChiefRunning = nodes.length === 1 && root?.status === 'running';
    return done(onlyChiefRunning || (root?.status === 'running' && !root.hasChildren && nodes.length === 1) ? 'planning' : 'running');
  }
  if (failedLive.length) return done('failed');
  if (live.some((n) => n.status === 'review')) return done('in_review');
  if (blockedLive.length) return done('awaiting_input');
  // only pending work remains
  if (!nodes.some((n) => n.everStarted)) return done('queued');
  flags.idle = true;
  return done('running');
}
