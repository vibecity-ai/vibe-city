import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  InventorySchema, boardSlugForDepartment,
  type DepartmentCreate, type DepartmentUpdate, type DepartmentView, type Inventory, type InventoryPatch,
} from '@vibe-city/shared';
import { ConflictError, InvalidInputError, NotFoundError } from './errors.ts';

interface Row {
  id: string; company_id: string; name: string; purpose: string; floor_order: number;
  chief_profile_ref: string | null; worker_profile_ref: string | null;
  hermes_board_ref: string | null; board_sync_state: 'not_provisioned' | 'synced' | 'error';
  archived_at: string | null; created_at: string; updated_at: string;
  provisioning_state: DepartmentView['state']; provisioning_error_json: string | null; provisioning_attempts: number;
  board_verified_at: string | null; chief_verified_at: string | null; worker_verified_at: string | null;
  chief_origin: 'created' | 'associated' | null; worker_origin: 'created' | 'associated' | null;
  inventory_applied_hash: string | null; inventory_applied_at: string | null;
  observed_config_json: string | null; last_reconciled_at: string | null;
  confirmed_profile_refs_json: string;
}

export type DepartmentRow = Row;

const nameKey = (n: string) => n.trim().toLowerCase();
const RESERVED_PROFILES = new Set(['default']);

export function toView(r: Row, floorPosition: number | null): DepartmentView {
  return {
    id: r.id,
    name: r.name,
    purpose: r.purpose,
    floorOrder: r.floor_order,
    floorPosition: r.archived_at ? null : floorPosition,
    // Set only by the provisioning service after every Hermes resource has been verified.
    state: r.provisioning_state,
    chiefProfileRef: r.chief_profile_ref,
    workerProfileRef: r.worker_profile_ref,
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
      .map((r) => toView(r, r.archived_at ? null : ++pos));
  }

  get(id: string): DepartmentView {
    const r = this.row(id);
    const above = r.archived_at ? 0 : (this.db
      .prepare('SELECT COUNT(*) AS n FROM department WHERE archived_at IS NULL AND floor_order > ?')
      .get(r.floor_order) as { n: number }).n;
    return toView(r, above + 1);
  }

  /** Internal: raw row for the provisioning service. */
  getRow(id: string): Row {
    return this.row(id);
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
      return this.get(id);
    });
  }

  update(id: string, patch: DepartmentUpdate): DepartmentView {
    return this.tx(() => {
      const cur = this.row(id);
      if (cur.archived_at) throw new ConflictError('department is archived');
      if (patch.name !== undefined) this.assertUniqueName(patch.name, id);
      const chief = patch.chiefProfileRef === undefined ? cur.chief_profile_ref : patch.chiefProfileRef;
      const worker = patch.workerProfileRef === undefined ? cur.worker_profile_ref : patch.workerProfileRef;
      this.assertProfileRefs(id, chief, worker);
      const refsChanged = chief !== cur.chief_profile_ref || worker !== cur.worker_profile_ref;
      // Consent is bound to specific profile names: it survives only for refs that are unchanged and still set.
      let confirmed: string[] = (JSON.parse(cur.confirmed_profile_refs_json) as string[]).filter((r) => r === chief || r === worker);
      if (patch.confirmModifyProfiles !== undefined) {
        for (const r of patch.confirmModifyProfiles) {
          if (r !== chief && r !== worker) throw new InvalidInputError(`cannot confirm "${r}": it is not this department's chief or worker profile`);
        }
        confirmed = [...new Set(patch.confirmModifyProfiles)];
      }
      const name = patch.name ?? cur.name;
      this.db.prepare(
        `UPDATE department SET name = ?, name_key = ?, purpose = ?,
           chief_profile_ref = ?, worker_profile_ref = ?, updated_at = ? WHERE id = ?`,
      ).run(name, nameKey(name), patch.purpose ?? cur.purpose, chief, worker, new Date().toISOString(), id);
      this.db.prepare('UPDATE department SET confirmed_profile_refs_json = ? WHERE id = ?').run(JSON.stringify(confirmed), id);
      // Anything Hermes-side that was applied from the old values is no longer trustworthy: require re-provisioning.
      const contextChanged = (patch.purpose !== undefined && patch.purpose !== cur.purpose) || (patch.name !== undefined && patch.name !== cur.name);
      const confirmationChanged = JSON.stringify(confirmed) !== cur.confirmed_profile_refs_json;
      if (refsChanged) this.resetProvisioning(id, true);
      else if (confirmationChanged && cur.provisioning_state === 'error') this.resetProvisioning(id, false);
      else if (contextChanged && cur.provisioning_state !== 'unconfigured') this.resetProvisioning(id, false);
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
        hermesResourcesRetained: !!(cur.hermes_board_ref || cur.chief_profile_ref || cur.worker_profile_ref),
      };
    });
  }

  /** Profiles must be distinct, non-reserved, and not shared with another active department (private identities). */
  private assertProfileRefs(id: string, chief: string | null, worker: string | null) {
    for (const ref of [chief, worker]) {
      if (ref && RESERVED_PROFILES.has(ref)) throw new InvalidInputError(`profile "${ref}" is reserved and cannot be a department profile`);
    }
    if (chief && worker && chief === worker) throw new InvalidInputError('chief and worker must be different profiles');
    for (const ref of [chief, worker]) {
      if (!ref) continue;
      const hit = this.db.prepare(
        'SELECT id FROM department WHERE archived_at IS NULL AND id != ? AND (chief_profile_ref = ? OR worker_profile_ref = ?)',
      ).get(id, ref, ref);
      if (hit) throw new ConflictError(`profile "${ref}" is already used by another department`);
    }
  }

  /** Drop verification results; keep the desired refs only when `keepRefs`. */
  private resetProvisioning(id: string, refsChanged: boolean) {
    this.db.prepare(
      `UPDATE department SET provisioning_state = 'unconfigured', provisioning_error_json = NULL,
         chief_verified_at = NULL, worker_verified_at = NULL, ${refsChanged ? 'chief_origin = NULL, worker_origin = NULL,' : ''}
         inventory_applied_hash = NULL, inventory_applied_at = NULL, observed_config_json = NULL WHERE id = ?`,
    ).run(id);
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
