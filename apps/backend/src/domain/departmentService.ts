import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  InventorySchema, MAX_TEAMMATES, ModelChoiceSchema, boardSlugForDepartment,
  type DepartmentAgent, type DepartmentCreate, type DepartmentUpdate, type DepartmentView, type Inventory, type InventoryPatch, type ModelChoice,
} from '@vibe-city/shared';
import { ConflictError, InvalidInputError, NotFoundError } from './errors.ts';

interface Row {
  id: string; company_id: string; name: string; purpose: string; floor_order: number;
  hermes_board_ref: string | null; board_sync_state: 'not_provisioned' | 'synced' | 'error';
  archived_at: string | null; created_at: string; updated_at: string;
  provisioning_state: DepartmentView['state']; provisioning_error_json: string | null; provisioning_attempts: number;
  board_verified_at: string | null;
  inventory_applied_hash: string | null; inventory_applied_at: string | null;
  observed_config_json: string | null; last_reconciled_at: string | null;
  confirmed_profile_refs_json: string;
}

export type DepartmentRow = Row;

/** One agent = one Hermes profile. Seat 0 (key `chief`) is the lead; teammates are W-01, W-02, … */
export interface AgentRow {
  department_id: string; agent_key: string; seat: number;
  profile_ref: string | null; origin: 'created' | 'associated' | null; verified_at: string | null;
  model_json: string | null; skills_json: string; created_at: string;
}

export const LEAD_KEY = 'chief';
export const seatKey = (seat: number) => (seat === 0 ? LEAD_KEY : `W-${String(seat).padStart(2, '0')}`);
export const agentModel = (a: AgentRow): ModelChoice | null => (a.model_json ? ModelChoiceSchema.parse(JSON.parse(a.model_json)) : null);
export const agentSkills = (a: AgentRow): string[] => JSON.parse(a.skills_json) as string[];

const nameKey = (n: string) => n.trim().toLowerCase();
const RESERVED_PROFILES = new Set(['default']);

export function agentView(a: AgentRow): DepartmentAgent {
  return {
    key: a.agent_key, lead: a.seat === 0, profileRef: a.profile_ref, model: agentModel(a), skills: agentSkills(a), createdAt: a.created_at,
  };
}

export function toView(r: Row, floorPosition: number | null, agents: AgentRow[]): DepartmentView {
  return {
    id: r.id,
    name: r.name,
    purpose: r.purpose,
    floorOrder: r.floor_order,
    floorPosition: r.archived_at ? null : floorPosition,
    // Set only by the provisioning service after every Hermes resource has been verified.
    state: r.provisioning_state,
    agents: agents.map(agentView),
    hermesBoardSlug: boardSlugForDepartment(r.id),
    hermesBoardRef: r.hermes_board_ref,
    boardSyncState: r.board_sync_state,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mergeInventory(base: Inventory, patch: InventoryPatch): Inventory {
  return InventorySchema.parse({ ...base, ...patch, limits: { ...base.limits, ...patch.limits } });
}

/**
 * Stored inventories from before the single-model choice had `allowedModelIds` (a list without providers).
 * A model id alone cannot be set safely, so the old list is dropped and the profile keeps its own model.
 */
function migrateInventory(raw: Record<string, unknown>): Record<string, unknown> {
  if (!('allowedModelIds' in raw)) return raw;
  const { allowedModelIds: _dropped, ...rest } = raw;
  return rest;
}

export class DepartmentService {
  private db: DatabaseSync;
  private companyId: string;
  constructor(db: DatabaseSync, companyId: string) {
    this.db = db;
    this.companyId = companyId;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private row(id: string): Row {
    const r = this.db.prepare('SELECT * FROM department WHERE id = ?').get(id) as unknown as Row | undefined;
    if (!r) throw new NotFoundError('department not found');
    return r;
  }

  private assertUniqueName(name: string, exceptId?: string) {
    const hit = this.db
      .prepare('SELECT id FROM department WHERE name_key = ? AND archived_at IS NULL AND id IS NOT ?')
      .get(nameKey(name), exceptId ?? null);
    if (hit) throw new ConflictError('a department with this name already exists');
  }

  list(opts: { includeArchived?: boolean } = {}): DepartmentView[] {
    // Visible order is a projection of the active departments: newest first, directly below the Executive Office.
    // Archived rows (only with includeArchived) follow, also newest first, with no floor position.
    const rows = this.db.prepare(
      'SELECT * FROM department ORDER BY (archived_at IS NOT NULL) ASC, floor_order DESC, id ASC',
    ).all() as unknown as Row[];
    let pos = 0;
    return rows
      .filter((r) => opts.includeArchived || !r.archived_at)
      .map((r) => toView(r, r.archived_at ? null : ++pos, this.agents(r.id)));
  }

  get(id: string): DepartmentView {
    const r = this.row(id);
    const above = r.archived_at ? 0 : (this.db
      .prepare('SELECT COUNT(*) AS n FROM department WHERE archived_at IS NULL AND floor_order > ?')
      .get(r.floor_order) as { n: number }).n;
    return toView(r, above + 1, this.agents(id));
  }

  /** Internal: raw row for the provisioning service. */
  getRow(id: string): Row {
    return this.row(id);
  }

  /** The department's agents, lead first. */
  agents(id: string): AgentRow[] {
    return this.db.prepare('SELECT * FROM department_agent WHERE department_id = ? ORDER BY seat').all(id) as unknown as AgentRow[];
  }

  lead(id: string): AgentRow {
    const a = this.agents(id)[0];
    if (!a) throw new NotFoundError('department not found');
    return a;
  }

  /** Internal: provisioning bookkeeping on one agent. */
  patchAgent(id: string, agentKey: string, cols: Partial<Pick<AgentRow, 'profile_ref' | 'origin' | 'verified_at'>>): void {
    if (this.row(id).archived_at) throw new ConflictError('department is archived');
    const keys = Object.keys(cols) as (keyof typeof cols)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE department_agent SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE department_id = ? AND agent_key = ?`)
      .run(...keys.map((k) => cols[k] ?? null), id, agentKey);
  }

  /**
   * A new teammate (a hire): the next free seat, with its own model and skills. Its Hermes profile is created by the
   * next provisioning run, so the department goes back to `unconfigured` until then.
   */
  addAgent(id: string, loadout: { model: ModelChoice | null; skills: string[] }): AgentRow {
    return this.tx(() => {
      const cur = this.row(id);
      if (cur.archived_at) throw new ConflictError('department is archived');
      const seat = (this.db.prepare('SELECT COALESCE(MAX(seat), 0) + 1 AS n FROM department_agent WHERE department_id = ?').get(id) as { n: number }).n;
      if (seat > MAX_TEAMMATES) throw new ConflictError(`${cur.name} already has the maximum of ${MAX_TEAMMATES} teammates`);
      this.insertAgent(id, seat, loadout, new Date().toISOString());
      if (cur.provisioning_state !== 'unconfigured' && cur.provisioning_state !== 'provisioning') {
        this.db.prepare("UPDATE department SET provisioning_state = 'unconfigured', provisioning_error_json = NULL WHERE id = ?").run(id);
      }
      return this.agents(id).find((a) => a.seat === seat)!;
    });
  }

  /** The user's choice of one agent's own model (null = the department's). Hermes gets it on the next sync. */
  setAgentModel(id: string, agentKey: string, model: ModelChoice | null): DepartmentAgent {
    return this.tx(() => {
      const cur = this.row(id);
      if (cur.archived_at) throw new ConflictError('department is archived');
      const r = this.db.prepare('UPDATE department_agent SET model_json = ? WHERE department_id = ? AND agent_key = ?')
        .run(model ? JSON.stringify(model) : null, id, agentKey);
      if (!r.changes) throw new NotFoundError('agent not found');
      const now = new Date().toISOString();
      this.db.prepare('UPDATE department SET updated_at = ? WHERE id = ?').run(now, id);
      if (cur.provisioning_state !== 'unconfigured' && cur.provisioning_state !== 'provisioning') {
        this.db.prepare("UPDATE department SET provisioning_state = 'unconfigured', provisioning_error_json = NULL WHERE id = ?").run(id);
      }
      return agentView(this.agents(id).find((a) => a.agent_key === agentKey)!);
    });
  }

  private insertAgent(id: string, seat: number, loadout: { model: ModelChoice | null; skills: string[] }, now: string) {
    this.db.prepare('INSERT INTO department_agent (department_id, agent_key, seat, model_json, skills_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, seatKey(seat), seat, loadout.model ? JSON.stringify(loadout.model) : null, JSON.stringify([...new Set(loadout.skills)]), now);
  }

  /** Internal: apply column updates (provisioning bookkeeping). Refuses archived departments. */
  patchRow(id: string, cols: Record<string, string | number | null>): void {
    const cur = this.row(id);
    if (cur.archived_at) throw new ConflictError('department is archived');
    const keys = Object.keys(cols);
    if (!keys.length) return;
    if (!keys.every((k) => /^[a-z_]+$/.test(k))) throw new Error('invalid column name');
    this.db.prepare(`UPDATE department SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => cols[k]!), new Date().toISOString(), id);
  }

  /** Active departments, oldest first (for background reconciliation). */
  activeIds(): string[] {
    return (this.db.prepare('SELECT id FROM department WHERE archived_at IS NULL ORDER BY floor_order ASC').all() as unknown as { id: string }[]).map((r) => r.id);
  }

  create(input: DepartmentCreate): DepartmentView {
    const inventory = mergeInventory(InventorySchema.parse({}), input.inventory ?? {});
    return this.tx(() => {
      this.assertUniqueName(input.name);
      const id = randomUUID();
      const now = new Date().toISOString();
      // floor_order is monotonic and never reused or renumbered, so existing floors stay stable.
      const next = (this.db.prepare('SELECT COALESCE(MAX(floor_order), 0) + 1 AS n FROM department').get() as { n: number }).n;
      this.db.prepare(
        `INSERT INTO department (id, company_id, name, name_key, purpose, floor_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, this.companyId, input.name, nameKey(input.name), input.purpose, next, now, now);
      this.db.prepare('INSERT INTO department_inventory (department_id, inventory_json, updated_at) VALUES (?, ?, ?)')
        .run(id, JSON.stringify(inventory), now);
      for (let seat = 0; seat <= input.teammates; seat++) this.insertAgent(id, seat, { model: null, skills: [] }, now);
      return this.get(id);
    });
  }

  update(id: string, patch: DepartmentUpdate): DepartmentView {
    return this.tx(() => {
      const cur = this.row(id);
      if (cur.archived_at) throw new ConflictError('department is archived');
      if (patch.name !== undefined) this.assertUniqueName(patch.name, id);
      const curLead = this.lead(id).profile_ref;
      const lead = patch.leadProfileRef === undefined ? curLead : patch.leadProfileRef;
      this.assertLeadRef(id, lead);
      const refsChanged = lead !== curLead;
      // Consent is bound to a specific profile name: it survives only while the lead ref is unchanged and still set.
      let confirmed: string[] = (JSON.parse(cur.confirmed_profile_refs_json) as string[]).filter((r) => r === lead);
      if (patch.confirmModifyProfiles !== undefined) {
        for (const r of patch.confirmModifyProfiles) {
          if (r !== lead) throw new InvalidInputError(`cannot confirm "${r}": it is not this department's lead profile`);
        }
        confirmed = [...new Set(patch.confirmModifyProfiles)];
      }
      const name = patch.name ?? cur.name;
      this.db.prepare('UPDATE department SET name = ?, name_key = ?, purpose = ?, updated_at = ? WHERE id = ?')
        .run(name, nameKey(name), patch.purpose ?? cur.purpose, new Date().toISOString(), id);
      if (refsChanged) this.db.prepare('UPDATE department_agent SET profile_ref = ?, origin = NULL WHERE department_id = ? AND seat = 0').run(lead, id);
      this.db.prepare('UPDATE department SET confirmed_profile_refs_json = ? WHERE id = ?').run(JSON.stringify(confirmed), id);
      // Anything Hermes-side that was applied from the old values is no longer trustworthy: require re-provisioning.
      const contextChanged = (patch.purpose !== undefined && patch.purpose !== cur.purpose) || (patch.name !== undefined && patch.name !== cur.name);
      const confirmationChanged = JSON.stringify(confirmed) !== cur.confirmed_profile_refs_json;
      if (refsChanged) this.resetProvisioning(id);
      else if (confirmationChanged && cur.provisioning_state === 'error') this.resetProvisioning(id);
      else if (contextChanged && cur.provisioning_state !== 'unconfigured') this.resetProvisioning(id);
      return this.get(id);
    });
  }

  /**
   * Safe delete = archive. The row, inventory and Hermes references are kept (history is preserved) and
   * nothing is deleted in Hermes. The name and board slug are never reused; floor_order is not renumbered.
   */
  archive(id: string): { department: DepartmentView; hermesResourcesRetained: boolean } {
    return this.tx(() => {
      const cur = this.row(id);
      if (cur.archived_at) throw new NotFoundError('department not found');
      const now = new Date().toISOString();
      this.db.prepare('UPDATE department SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
      return {
        department: this.get(id),
        hermesResourcesRetained: !!cur.hermes_board_ref || this.agents(id).some((a) => a.profile_ref),
      };
    });
  }

  /** Every agent has its own profile: non-reserved, and not shared with another agent of any active department. */
  private assertLeadRef(id: string, ref: string | null) {
    if (!ref) return;
    if (RESERVED_PROFILES.has(ref)) throw new InvalidInputError(`profile "${ref}" is reserved and cannot be a department profile`);
    const hit = this.db.prepare(
      `SELECT a.department_id AS dept, a.seat AS seat FROM department_agent a JOIN department d ON d.id = a.department_id
       WHERE d.archived_at IS NULL AND a.profile_ref = ? AND NOT (a.department_id = ? AND a.seat = 0)`,
    ).get(ref, id) as { dept: string; seat: number } | undefined;
    if (hit?.dept === id) throw new InvalidInputError(`profile "${ref}" is already one of this department's teammates`);
    if (hit) throw new ConflictError(`profile "${ref}" is already used by another department`);
  }

  /** Drop verification results (on the department and every agent). */
  private resetProvisioning(id: string) {
    this.db.prepare(
      `UPDATE department SET provisioning_state = 'unconfigured', provisioning_error_json = NULL,
         inventory_applied_hash = NULL, inventory_applied_at = NULL, observed_config_json = NULL WHERE id = ?`,
    ).run(id);
    this.db.prepare('UPDATE department_agent SET verified_at = NULL WHERE department_id = ?').run(id);
  }

  getInventory(id: string): Inventory {
    this.row(id);
    const r = this.db.prepare('SELECT inventory_json FROM department_inventory WHERE department_id = ?').get(id) as unknown as { inventory_json: string };
    return InventorySchema.parse(migrateInventory(JSON.parse(r.inventory_json)));
  }

  patchInventory(id: string, patch: InventoryPatch): Inventory {
    return this.tx(() => {
      const cur = this.row(id);
      if (cur.archived_at) throw new ConflictError('department is archived');
      const next = mergeInventory(this.getInventory(id), patch);
      this.db.prepare('UPDATE department_inventory SET inventory_json = ?, updated_at = ? WHERE department_id = ?')
        .run(JSON.stringify(next), new Date().toISOString(), id);
      this.db.prepare('UPDATE department SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      // The Hermes profiles no longer match the inventory until it is re-applied.
      if (cur.provisioning_state !== 'unconfigured' && cur.provisioning_state !== 'provisioning') {
        this.db.prepare("UPDATE department SET provisioning_state = 'unconfigured', provisioning_error_json = NULL WHERE id = ?").run(id);
      }
      return next;
    });
  }

  /** For the later Hermes sync step (not exposed over REST in Milestone 1). */
  markBoardSynced(id: string, boardRef: string) {
    if (boardRef !== boardSlugForDepartment(id)) throw new InvalidInputError('board ref must match the derived slug');
    this.row(id);
    this.db.prepare("UPDATE department SET hermes_board_ref = ?, board_sync_state = 'synced', updated_at = ? WHERE id = ?")
      .run(boardRef, new Date().toISOString(), id);
  }
}
