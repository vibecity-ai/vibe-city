import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { KanbanClient, HermesRun } from '../hermes/kanbanClient.ts';
import type { DepartmentService } from './departmentService.ts';

export type RunState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface RunReference {
  id: string;
  departmentId: string;
  hermesTaskRef: string;
  hermesRunRef: string | null;
  parentTaskRef: string | null;
  profileRef: string;
  role: 'chief' | 'worker';
  state: RunState;
  lastObservedAt: string;
}

/** Maps a Hermes run row to Vibe City's minimal run state. Unrecognized values are `unknown`, never guessed. */
export function runState(r: Pick<HermesRun, 'status' | 'outcome' | 'ended_at'>): RunState {
  const v = `${r.outcome ?? ''} ${r.status}`.toLowerCase();
  if (/reclaim|cancel|terminat/.test(v)) return 'cancelled';
  if (/crash|fail|timed_out|spawn_failed|gave_up|error/.test(v)) return 'failed';
  if (r.ended_at === null) return /running|claimed|active/.test(v) ? 'running' : 'queued';
  if (/complet|done|success/.test(v)) return 'completed';
  return 'unknown';
}

interface Row {
  id: string; department_id: string; hermes_task_ref: string; hermes_run_ref: string | null; parent_task_ref: string | null;
  profile_ref: string; role: 'chief' | 'worker'; state: RunState; last_observed_at: string;
}

/**
 * Keeps references to real Hermes task/run identifiers (no task content, no scheduling).
 * Hermes Kanban stays the source of truth; these rows exist for UI correlation and restart reconciliation.
 */
export class RunTracker {
  private db: DatabaseSync;
  private depts: DepartmentService;
  constructor(db: DatabaseSync, depts: DepartmentService) {
    this.db = db;
    this.depts = depts;
  }

  list(departmentId: string): RunReference[] {
    const rows = this.db.prepare('SELECT * FROM run_reference WHERE department_id = ? ORDER BY last_observed_at ASC, rowid ASC').all(departmentId) as unknown as Row[];
    return rows.map((r) => ({
      id: r.id, departmentId: r.department_id, hermesTaskRef: r.hermes_task_ref, hermesRunRef: r.hermes_run_ref,
      parentTaskRef: r.parent_task_ref, profileRef: r.profile_ref, role: r.role, state: r.state, lastObservedAt: r.last_observed_at,
    }));
  }

  /** Upsert by (department, task, run). Returns the stored reference id. */
  record(departmentId: string, ref: Omit<RunReference, 'id' | 'departmentId' | 'lastObservedAt'>): string {
    const now = new Date().toISOString();
    const existing = this.db.prepare(
      'SELECT id FROM run_reference WHERE department_id = ? AND hermes_task_ref = ? AND hermes_run_ref IS ?',
    ).get(departmentId, ref.hermesTaskRef, ref.hermesRunRef) as { id: string } | undefined;
    if (existing) {
      this.db.prepare('UPDATE run_reference SET state = ?, last_observed_at = ?, profile_ref = ?, role = ? WHERE id = ?')
        .run(ref.state, now, ref.profileRef, ref.role, existing.id);
      return existing.id;
    }
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO run_reference (id, department_id, hermes_task_ref, hermes_run_ref, parent_task_ref, profile_ref, role, state, last_observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, departmentId, ref.hermesTaskRef, ref.hermesRunRef, ref.parentTaskRef, ref.profileRef, ref.role, ref.state, now);
    return id;
  }

  /**
   * Reads a quest task and its children from Hermes and records every run. A run is attributed to a role only if its
   * profile is the department's chief/worker profile; anything else is reported as a violation, not recorded.
   */
  async observe(departmentId: string, kanban: KanbanClient, questTaskId: string): Promise<{ recorded: RunReference[]; violations: string[] }> {
    const dept = this.depts.getRow(departmentId);
    const board = dept.hermes_board_ref;
    if (!board || !dept.chief_profile_ref || !dept.worker_profile_ref) throw new Error('department is not provisioned');
    const violations: string[] = [];
    const quest = await kanban.getTask(board, questTaskId);
    const tasks: { id: string; parent: string | null; detail: typeof quest }[] = [{ id: questTaskId, parent: null, detail: quest }];
    for (const childId of quest.links.children) tasks.push({ id: childId, parent: questTaskId, detail: await kanban.getTask(board, childId) });
    for (const t of tasks) {
      for (const run of t.detail.runs) {
        const role = run.profile === dept.chief_profile_ref ? 'chief' : run.profile === dept.worker_profile_ref ? 'worker' : null;
        if (!role) {
          violations.push(`run ${run.id} of task ${t.id} used profile "${run.profile}", which is not this department's chief or worker`);
          continue;
        }
        this.record(departmentId, {
          hermesTaskRef: t.id, hermesRunRef: String(run.id), parentTaskRef: t.parent, profileRef: run.profile!, role, state: runState(run),
        });
      }
    }
    return { recorded: this.list(departmentId), violations };
  }
}
