/* A floor's own env variables: keys a skill or tool needs (an API key, a base URL). Stored here because Hermes keeps
   them per profile and a floor has several; written into every agent profile's .env right away when Hermes is
   reachable, and again at every sync (so a newly hired agent gets them too). Values never leave the server. */
import type { DatabaseSync } from 'node:sqlite';
import type { DepartmentEnvVar } from '@vibe-city/shared';
import type { HermesRuntime } from '../hermes/ports.ts';
import type { DepartmentService } from './departmentService.ts';
import { NotFoundError } from './errors.ts';

interface Row { name: string; value: string; updated_at: string; applied_at: string | null }

export class DepartmentEnvService {
  private db: DatabaseSync;
  private depts: DepartmentService;
  private hermes: HermesRuntime | undefined;
  private now: () => Date;

  constructor(db: DatabaseSync, depts: DepartmentService, hermes: HermesRuntime | undefined, now = () => new Date()) {
    this.db = db; this.depts = depts; this.hermes = hermes; this.now = now;
  }

  private rows(deptId: string): Row[] {
    return this.db.prepare('SELECT name, value, updated_at, applied_at FROM department_env WHERE department_id = ? ORDER BY name').all(deptId) as unknown as Row[];
  }
  private profiles(deptId: string): string[] {
    return this.depts.agents(deptId).map((a) => a.profile_ref).filter((p): p is string => !!p);
  }

  list(deptId: string): DepartmentEnvVar[] {
    this.depts.getRow(deptId);
    return this.rows(deptId).map((r) => ({ name: r.name, updatedAt: r.updated_at, onAgents: r.applied_at !== null && r.applied_at >= r.updated_at }));
  }

  /** Name -> value, for writing into the profiles. Server-side only. */
  values(deptId: string): Record<string, string> {
    return Object.fromEntries(this.rows(deptId).map((r) => [r.name, r.value]));
  }

  /** After every profile took the values read at `at`. */
  markApplied(deptId: string, at: string): void {
    this.db.prepare('UPDATE department_env SET applied_at = ? WHERE department_id = ? AND updated_at <= ?').run(at, deptId, at);
  }

  /** Saves the value, then writes it into the floor's profiles. Hermes being down only delays that: `warning` says so. */
  async set(deptId: string, name: string, value: string): Promise<{ vars: DepartmentEnvVar[]; warning: string | null }> {
    this.depts.getRow(deptId);
    const at = this.now().toISOString();
    this.db.prepare(`INSERT INTO department_env (department_id, name, value, updated_at, applied_at) VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT (department_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, applied_at = NULL`).run(deptId, name, value, at);
    const profiles = this.profiles(deptId);
    let warning: string | null = null;
    if (!profiles.length) warning = 'Saved. The agents get it when the floor is first synced.';
    else if (!this.hermes?.setProfileEnv) warning = 'Saved, but Hermes is not configured: the agents get it at the next sync.';
    else {
      try {
        for (const p of profiles) await this.hermes.setProfileEnv(p, { [name]: value });
        this.markApplied(deptId, at);
      } catch {
        warning = 'Saved, but Hermes did not take it: the agents get it at the next sync.';
      }
    }
    return { vars: this.list(deptId), warning };
  }

  /** Takes the variable out of every profile first; only then forgets it, so nothing is left behind on an agent. */
  async remove(deptId: string, name: string): Promise<DepartmentEnvVar[]> {
    this.depts.getRow(deptId);
    if (!this.rows(deptId).some((r) => r.name === name)) throw new NotFoundError('variable not found');
    const profiles = this.profiles(deptId);
    if (profiles.length && this.hermes?.unsetProfileEnv) for (const p of profiles) await this.hermes.unsetProfileEnv(p, [name]);
    this.db.prepare('DELETE FROM department_env WHERE department_id = ? AND name = ?').run(deptId, name);
    return this.list(deptId);
  }
}
