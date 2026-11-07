/* Schedules (feature spec 8): recurring quests run by Vibe City, not by the agents. A tick (every 30 s in the server)
   creates an ordinary quest on the department's board for each schedule that is due. Firing is idempotent: one
   schedule_fire row per (schedule, fire time) is claimed before the quest is created, and the quest's clientRequestId
   is derived from the same pair, so neither a restart nor a retry creates a second quest.
   If the backend was down through several fire times, only the latest is run (no backlog of stale quests). */
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { QuestCreate, QuestCreated, Schedule, ScheduleCreate, SchedulePatch } from '@vibe-city/shared';
import type { DepartmentService } from './departmentService.ts';
import { InvalidInputError, NotFoundError } from './errors.ts';
import { isValidTimeZone, nextRun, parseCron } from './cron.ts';

export interface ScheduleDeps {
  db: DatabaseSync;
  departments: DepartmentService;
  createQuest: (departmentId: string, input: QuestCreate) => Promise<QuestCreated>;
  recordOrigin: (departmentId: string, questId: string, scheduleId: string) => void;
  now?: () => Date;
}

interface Row {
  id: string; department_id: string; name: string; cron: string; timezone: string; title: string; objective: string; instructions: string;
  enabled: number; next_run_at: string | null; last_run_at: string | null; last_quest_id: string | null; last_error: string | null; created_at: string;
}

/** A stable UUID (v5-style layout) from a string: the same fire always yields the same quest request id. */
export function stableUuid(s: string): string {
  const h = createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

export class ScheduleService {
  private d: ScheduleDeps;
  private now: () => Date;
  private ticking = false;
  constructor(d: ScheduleDeps) { this.d = d; this.now = d.now ?? (() => new Date()); }

  list(departmentId?: string): Schedule[] {
    const rows = (departmentId
      ? this.d.db.prepare('SELECT * FROM schedule WHERE deleted_at IS NULL AND department_id = ? ORDER BY created_at').all(departmentId)
      : this.d.db.prepare('SELECT * FROM schedule WHERE deleted_at IS NULL ORDER BY created_at').all()) as unknown as Row[];
    return rows.map((r) => this.view(r));
  }

  get(id: string): Schedule { return this.view(this.row(id)); }

  create(departmentId: string, input: ScheduleCreate): Schedule {
    const dept = this.d.departments.get(departmentId);
    if (dept.archivedAt) throw new InvalidInputError('department is archived');
    this.validate(input.cron, input.timezone);
    const id = randomUUID(), now = this.iso();
    this.d.db.prepare('INSERT INTO schedule (id, department_id, name, cron, timezone, title, objective, instructions, enabled, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, departmentId, input.name, input.cron, input.timezone, input.title, input.objective, input.instructions, input.enabled ? 1 : 0, input.enabled ? this.next(input.cron, input.timezone) : null, now);
    return this.get(id);
  }

  update(id: string, patch: SchedulePatch): Schedule {
    const r = this.row(id);
    const next = { name: r.name, cron: r.cron, timezone: r.timezone, title: r.title, objective: r.objective, instructions: r.instructions, enabled: !!r.enabled, ...patch };
    this.validate(next.cron, next.timezone);
    this.d.db.prepare('UPDATE schedule SET name = ?, cron = ?, timezone = ?, title = ?, objective = ?, instructions = ?, enabled = ?, next_run_at = ? WHERE id = ?')
      .run(next.name, next.cron, next.timezone, next.title, next.objective, next.instructions, next.enabled ? 1 : 0, next.enabled ? this.next(next.cron, next.timezone) : null, id);
    return this.get(id);
  }

  remove(id: string): void {
    this.row(id);
    this.d.db.prepare('UPDATE schedule SET deleted_at = ?, enabled = 0, next_run_at = NULL WHERE id = ?').run(this.iso(), id);
  }

  /** Runs a schedule now (outside its timetable). Its regular next run is unchanged. */
  async runNow(id: string): Promise<Schedule> {
    const r = this.row(id);
    await this.fire(r, this.iso(), 'manual');
    return this.get(id);
  }

  /** Fires every enabled schedule that is due. Safe to call concurrently (one tick at a time). Returns fired ids. */
  async tick(): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const fired: string[] = [];
    try {
      const now = this.iso();
      const due = this.d.db.prepare('SELECT * FROM schedule WHERE deleted_at IS NULL AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?').all(now) as unknown as Row[];
      for (const r of due) {
        // the slot that was due (only the latest if several were missed), then move on to the next future slot
        if (await this.fire(r, r.next_run_at!, 'scheduled')) fired.push(r.id);
        this.d.db.prepare('UPDATE schedule SET next_run_at = ? WHERE id = ?').run(this.next(r.cron, r.timezone), r.id);
      }
    } finally { this.ticking = false; }
    return fired;
  }

  private async fire(r: Row, slot: string, kind: 'scheduled' | 'manual'): Promise<boolean> {
    const fireKey = kind === 'manual' ? `manual:${slot}` : slot;
    const claimed = this.d.db.prepare('INSERT OR IGNORE INTO schedule_fire (schedule_id, fire_at) VALUES (?, ?)').run(r.id, fireKey).changes > 0;
    if (!claimed) return false;
    try {
      const created = await this.d.createQuest(r.department_id, {
        clientRequestId: stableUuid(`${r.id}|${fireKey}`), title: r.title, objective: r.objective,
        instructions: `${r.instructions ? r.instructions + '\n\n' : ''}This quest was created by the schedule "${r.name}" (${r.cron}, ${r.timezone}).`,
      });
      this.d.recordOrigin(r.department_id, created.questId, r.id);
      this.d.db.prepare('UPDATE schedule_fire SET quest_id = ? WHERE schedule_id = ? AND fire_at = ?').run(created.questId, r.id, fireKey);
      this.d.db.prepare('UPDATE schedule SET last_run_at = ?, last_quest_id = ?, last_error = NULL WHERE id = ?').run(this.iso(), created.questId, r.id);
      return true;
    } catch (e) {
      const msg = `Could not create the quest: ${(e as Error).message}`.slice(0, 500);
      this.d.db.prepare('UPDATE schedule_fire SET error = ? WHERE schedule_id = ? AND fire_at = ?').run(msg, r.id, fireKey);
      this.d.db.prepare('UPDATE schedule SET last_run_at = ?, last_error = ? WHERE id = ?').run(this.iso(), msg, r.id);
      return false;
    }
  }

  private validate(cron: string, tz: string) {
    if (!isValidTimeZone(tz)) throw new InvalidInputError(`unknown time zone "${tz}"`);
    try { parseCron(cron); } catch (e) { throw new InvalidInputError((e as Error).message); }
    if (!nextRun(parseCron(cron), tz, this.now())) throw new InvalidInputError('this schedule never runs');
  }
  private next(cron: string, tz: string) { return nextRun(parseCron(cron), tz, this.now())?.toISOString() ?? null; }
  private row(id: string): Row {
    const r = this.d.db.prepare('SELECT * FROM schedule WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as Row | undefined;
    if (!r) throw new NotFoundError('schedule not found');
    return r;
  }
  private view(r: Row): Schedule {
    return {
      id: r.id, departmentId: r.department_id, name: r.name, cron: r.cron, timezone: r.timezone, title: r.title, objective: r.objective,
      instructions: r.instructions, enabled: !!r.enabled, nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, lastQuestId: r.last_quest_id,
      lastError: r.last_error, createdAt: r.created_at,
    };
  }
  private iso() { return this.now().toISOString(); }
}
