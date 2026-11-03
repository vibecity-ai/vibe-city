import type { DatabaseSync } from 'node:sqlite';
import {
  boardSlugForDepartment, profileNamesForDepartment,
  type AgentRole, type AgentView, type EffectiveInventory, type HealthView, type ProfilesView, type ProvisioningError, type ProvisioningStatus,
} from '@vibe-city/shared';
import {
  HermesAuthError, HermesRejectedError, HermesUnavailableError, type HermesRuntime,
} from '../hermes/ports.ts';
import { ConflictError } from './errors.ts';
import { scrub } from './scrub.ts';
import type { DepartmentRow, DepartmentService } from './departmentService.ts';
import { buildBlock, hasBlock, upsertBlock, type Role } from './instructions.ts';
import {
  ESSENTIAL_SKILLS, buildDepartmentWideReport, buildRoleReport, desiredToolsetMap, diffObserved, effectiveToolsets,
  inventoryHash, preferredModel, skillsToDisable, type ObservedConfig, type ObservedRole,
} from './inventoryPolicy.ts';

type Step = ProvisioningError['step'];

/** A failure with a known cause. `unavailable` = temporary Hermes problem (state becomes disconnected). */
class StepError extends Error {
  code: string;
  step: Step;
  retryable: boolean;
  unavailable: boolean;
  constructor(step: Step, code: string, message: string, opts: { retryable: boolean; unavailable?: boolean }) {
    super(message);
    this.step = step;
    this.code = code;
    this.retryable = opts.retryable;
    this.unavailable = opts.unavailable ?? false;
  }
}

const now = () => new Date().toISOString();

export class ProvisioningService {
  private db: DatabaseSync;
  private depts: DepartmentService;
  private hermes: HermesRuntime;
  private inflight = new Map<string, Promise<ProvisioningStatus>>();

  constructor(db: DatabaseSync, depts: DepartmentService, hermes: HermesRuntime) {
    this.db = db;
    this.depts = depts;
    this.hermes = hermes;
  }

  // ---- views -----------------------------------------------------------------

  status(id: string): ProvisioningStatus {
    const r = this.depts.getRow(id);
    const inv = this.depts.getInventory(id);
    const confirmed = JSON.parse(r.confirmed_profile_refs_json) as string[];
    const res = (ref: string | null, at: string | null, recorded: 'created' | 'associated' | null, profile = false) => {
      // Before provisioning has recorded an origin, a user-chosen ref is by definition an association.
      const origin = recorded ?? (profile && ref ? 'associated' : null);
      return {
      ref, verified: at !== null, verifiedAt: at, origin,
      modificationConfirmed: profile && origin === 'associated' ? !!ref && confirmed.includes(ref) : null,
      };
    };
    return {
      departmentId: id,
      state: r.provisioning_state,
      attempts: r.provisioning_attempts,
      error: r.provisioning_error_json ? (JSON.parse(r.provisioning_error_json) as ProvisioningError) : null,
      board: res(r.hermes_board_ref, r.board_verified_at, r.hermes_board_ref ? 'created' : null),
      chief: res(r.chief_profile_ref, r.chief_verified_at, r.chief_origin, true),
      worker: res(r.worker_profile_ref, r.worker_verified_at, r.worker_origin, true),
      inventory: {
        applied: r.inventory_applied_at !== null,
        appliedAt: r.inventory_applied_at,
        inSync: r.inventory_applied_hash === inventoryHash(inv),
      },
      lastReconciledAt: r.last_reconciled_at,
    };
  }

  effectiveInventory(id: string): EffectiveInventory {
    const r = this.depts.getRow(id);
    const inv = this.depts.getInventory(id);
    const obs = r.observed_config_json ? (JSON.parse(r.observed_config_json) as ObservedConfig) : null;
    const inSync = r.inventory_applied_hash === inventoryHash(inv);
    // Observed data is only trusted for the report while it matches the current inventory.
    const usable = inSync ? obs : null;
    return {
      departmentId: id,
      observedAt: obs?.at ?? null,
      inSync,
      chief: { role: 'chief', profileRef: r.chief_profile_ref, entries: buildRoleReport('chief', inv, usable?.chief ?? null) },
      worker: { role: 'worker', profileRef: r.worker_profile_ref, entries: buildRoleReport('worker', inv, usable?.worker ?? null) },
      departmentWide: buildDepartmentWideReport(inv, obs?.globalConcurrencyCap),
    };
  }

  async health(): Promise<HealthView> {
    return { checkedAt: now(), hermes: await this.hermes.health() };
  }

  async profiles(id: string): Promise<ProfilesView> {
    const r = this.depts.getRow(id);
    const empty = (ref: string | null) => ({ ref, exists: null as boolean | null, model: null as string | null, description: null as string | null });
    try {
      const list = await this.hermes.listProfiles();
      const view = (ref: string | null) => {
        const p = ref ? list.find((x) => x.name === ref) : undefined;
        return { ref, exists: ref ? !!p : null, model: p?.model ?? null, description: p?.description ?? null };
      };
      return { departmentId: id, reachable: true, chief: view(r.chief_profile_ref), worker: view(r.worker_profile_ref) };
    } catch (e) {
      if (!(e instanceof HermesUnavailableError) && !(e instanceof HermesAuthError)) throw e;
      return { departmentId: id, reachable: false, chief: empty(r.chief_profile_ref), worker: empty(r.worker_profile_ref) };
    }
  }

  /**
   * One agent profile of the department. Skills/toolsets/model are the last read-back from Hermes (no CLI call per
   * view); sessions are read live and degrade to null with a reason when Hermes is unavailable.
   */
  async agent(id: string, role: AgentRole): Promise<AgentView> {
    const r = this.depts.getRow(id);
    const ref = role === 'chief' ? r.chief_profile_ref : r.worker_profile_ref;
    const obs = r.observed_config_json ? (JSON.parse(r.observed_config_json) as ObservedConfig) : null;
    const o = obs?.[role] ?? null;
    const enabled = new Set(o?.enabledSkills ?? []);
    let sessions: AgentView['sessions'] = null;
    let sessionsError: string | null = null;
    if (!ref) sessionsError = 'This department has no Hermes profile yet. Provision it first.';
    else {
      try {
        const iso = (t: number | null) => (t === null ? null : new Date(t * 1000).toISOString());
        sessions = (await this.hermes.listSessions(ref, 10)).map((x) => ({
          id: x.id, title: scrub(x.title, 200), source: scrub(x.source, 40), model: scrub(x.model, 128),
          startedAt: iso(x.startedAt), endedAt: iso(x.endedAt), lastActiveAt: iso(x.lastActive), active: x.active,
          messageCount: x.messageCount, toolCallCount: x.toolCallCount, endReason: scrub(x.endReason, 80),
        }));
      } catch (e) {
        if (e instanceof HermesUnavailableError) sessionsError = 'Hermes is not reachable, so sessions cannot be read right now.';
        else if (e instanceof HermesAuthError) sessionsError = 'Hermes rejected the configured session token.';
        else if (e instanceof HermesRejectedError) sessionsError = 'Hermes could not list sessions for this profile.';
        else throw e;
      }
    }
    return {
      departmentId: id, role, profileRef: ref, observedAt: o ? obs!.at : null, model: o?.model ?? null,
      skills: (o?.installedSkills ?? []).map((name) => ({ name, enabled: enabled.has(name), essential: (ESSENTIAL_SKILLS as readonly string[]).includes(name) })).sort((a, b) => a.name.localeCompare(b.name)),
      toolsets: Object.entries(o?.toolsets ?? {}).map(([name, on]) => ({ name, enabled: on })).sort((a, b) => a.name.localeCompare(b.name)),
      sessions, sessionsError,
    };
  }

  // ---- provisioning ------------------------------------------------------------

  /** Idempotent. Concurrent calls for one department are refused (409), not duplicated. */
  provision(id: string): Promise<ProvisioningStatus> {
    const row = this.depts.getRow(id); // 404 if unknown
    if (row.archived_at) throw new ConflictError('department is archived');
    if (this.inflight.has(id)) throw new ConflictError('provisioning is already in progress for this department');
    const p = this.run(id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  /** Like provision, but only valid after a failed or interrupted attempt. */
  retry(id: string): Promise<ProvisioningStatus> {
    const s = this.depts.getRow(id).provisioning_state;
    if (s !== 'error' && s !== 'disconnected') throw new ConflictError(`nothing to retry: department is ${s}`);
    return this.provision(id);
  }

  /** At process start: a crash mid-provisioning leaves state 'provisioning'. Verified-step flags make resuming safe. */
  recoverInterrupted(): number {
    let n = 0;
    for (const id of this.depts.activeIds()) {
      const r = this.depts.getRow(id);
      if (r.provisioning_state !== 'provisioning' || this.inflight.has(id)) continue;
      this.depts.patchRow(id, {
        provisioning_state: 'error',
        provisioning_error_json: JSON.stringify(this.err('verify', 'interrupted', 'Provisioning was interrupted (restart); retry to resume.', true)),
      });
      n++;
    }
    return n;
  }

  private err(step: Step, code: string, message: string, retryable: boolean): ProvisioningError {
    return { code, step, message, retryable, at: now() };
  }

  private async run(id: string): Promise<ProvisioningStatus> {
    const start = this.depts.getRow(id);
    this.depts.patchRow(id, {
      provisioning_state: 'provisioning',
      provisioning_attempts: start.provisioning_attempts + 1,
      provisioning_error_json: null,
      // "verified" means verified in the latest attempt; every step re-verifies and re-stamps.
      board_verified_at: null, chief_verified_at: null, worker_verified_at: null,
    });
    try {
      await this.steps(id);
      this.depts.patchRow(id, { provisioning_state: 'ready', provisioning_error_json: null, last_reconciled_at: now() });
    } catch (e) {
      this.fail(id, e);
    }
    return this.status(id);
  }

  private fail(id: string, e: unknown) {
    let state: 'error' | 'disconnected' = 'error';
    let perr: ProvisioningError;
    if (e instanceof StepError) {
      state = e.unavailable ? 'disconnected' : 'error';
      perr = this.err(e.step, e.code, e.message, e.retryable);
    } else if (e instanceof HermesUnavailableError) {
      state = 'disconnected';
      perr = this.err('health', 'hermes_unreachable', 'Hermes is unreachable; try again when it is running.', true);
    } else if (e instanceof HermesAuthError) {
      perr = this.err('health', 'hermes_auth', 'Hermes rejected the configured session token.', false);
    } else if (e instanceof HermesRejectedError) {
      perr = this.err('verify', 'hermes_rejected', e.message, true);
    } else if (e instanceof ConflictError) {
      return; // department archived mid-run: nothing to record
    } else {
      perr = this.err('verify', 'internal', 'Unexpected error during provisioning.', true);
    }
    try {
      this.depts.patchRow(id, { provisioning_state: state, provisioning_error_json: JSON.stringify(perr) });
    } catch { /* archived concurrently */ }
  }

  /** Runs `fn` for a step, converting Hermes availability errors into step-tagged StepErrors. */
  private async step<T>(step: Step, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StepError) throw e;
      if (e instanceof HermesUnavailableError) throw new StepError(step, 'hermes_unreachable', 'Hermes is unreachable; try again when it is running.', { retryable: true, unavailable: true });
      if (e instanceof HermesAuthError) throw new StepError(step, 'hermes_auth', 'Hermes rejected the configured session token.', { retryable: false });
      if (e instanceof HermesRejectedError) throw new StepError(step, 'hermes_rejected', e.message, { retryable: true });
      throw e;
    }
  }

  private async steps(id: string) {
    const row = this.depts.getRow(id);
    const slug = boardSlugForDepartment(id);
    const names = profileNamesForDepartment(id);

    // 1. health
    await this.step('health', async () => {
      const h = await this.hermes.health();
      if (h.dashboard === 'down') throw new StepError('health', 'hermes_unreachable', 'Hermes dashboard is not reachable.', { retryable: true, unavailable: true });
      if (h.auth === 'rejected') throw new StepError('health', 'hermes_auth', 'Hermes rejected the configured session token.', { retryable: false });
    });

    // 2. validate profile choices
    const chiefName = row.chief_profile_ref ?? names.chief;
    const workerName = row.worker_profile_ref ?? names.worker;
    const chiefOrigin = row.chief_origin ?? (row.chief_profile_ref ? 'associated' : 'created');
    const workerOrigin = row.worker_origin ?? (row.worker_profile_ref ? 'associated' : 'created');
    const existing = await this.step('validate', () => this.hermes.listProfiles());
    for (const [role, name, origin] of [['chief', chiefName, chiefOrigin], ['worker', workerName, workerOrigin]] as const) {
      if (origin === 'associated' && !existing.some((p) => p.name === name)) {
        throw new StepError('validate', 'profile_not_found', `The ${role} profile "${name}" does not exist in Hermes.`, { retryable: false });
      }
      if (name === 'default') throw new StepError('validate', 'profile_reserved', 'The default profile cannot be a department profile.', { retryable: false });
    }
    // Safeguard: never modify a pre-existing profile without explicit, per-profile consent. Checked before anything
    // is created or changed in Hermes, so a refusal leaves Hermes exactly as it was.
    const confirmed = JSON.parse(row.confirmed_profile_refs_json) as string[];
    for (const [role, name, origin] of [['chief', chiefName, chiefOrigin], ['worker', workerName, workerOrigin]] as const) {
      if (origin === 'associated' && !confirmed.includes(name)) {
        throw new StepError('validate', 'confirmation_required',
          `The ${role} profile "${name}" already exists. Provisioning would change its toolsets, skills, model and instructions, which may affect its use outside Vibe City. Confirm this explicitly (confirmModifyProfiles) or use a Vibe City-managed profile instead.`,
          { retryable: false });
      }
    }

    // 3. board (derived slug; Hermes create is idempotent and we check first)
    await this.step('board', async () => {
      let board = (await this.hermes.listBoards()).find((b) => b.slug === slug);
      if (board?.archived) throw new StepError('board', 'board_archived', 'The department board exists in Hermes but is archived.', { retryable: false });
      if (!board) {
        await this.hermes.createBoard(slug, row.name, { defaultWorkdir: this.workdirFor(row) });
        board = (await this.hermes.listBoards()).find((b) => b.slug === slug);
        if (!board) throw new StepError('board', 'board_not_found_after_create', 'Hermes did not report the board after creating it.', { retryable: true });
      }
      this.depts.patchRow(id, { hermes_board_ref: slug, board_sync_state: 'synced', board_verified_at: now() });
    });

    // 4/5. profiles (persist after each so a failure in the next step resumes without recreating)
    for (const [role, name, origin] of [['chief', chiefName, chiefOrigin], ['worker', workerName, workerOrigin]] as const) {
      await this.step(role, async () => {
        const list = await this.hermes.listProfiles();
        if (!list.some((p) => p.name === name)) {
          await this.hermes.createProfile(name, { description: `${role} for department "${row.name}" (managed by Vibe City)` });
          if (!(await this.hermes.listProfiles()).some((p) => p.name === name)) {
            throw new StepError(role, 'profile_not_found_after_create', `Hermes did not report profile "${name}" after creating it.`, { retryable: true });
          }
        }
        this.depts.patchRow(id, role === 'chief'
          ? { chief_profile_ref: name, chief_origin: origin, chief_verified_at: now() }
          : { worker_profile_ref: name, worker_origin: origin, worker_verified_at: now() });
      });
    }

    // 6. inventory
    const observed = await this.step('inventory', () => this.applyInventory(id, chiefName, workerName));
    const inv = this.depts.getInventory(id);
    const problems = [...diffObserved('chief', inv, observed.chief), ...diffObserved('worker', inv, observed.worker)];
    if (problems.length) {
      throw new StepError('inventory', 'inventory_verification_failed', `Applied inventory does not match what Hermes reports (${problems.length} difference(s)).`, { retryable: true });
    }

    // 7. final verification: everything still present and the inventory did not change mid-run
    await this.step('verify', async () => {
      const profiles = await this.hermes.listProfiles();
      const boards = await this.hermes.listBoards();
      const missing = [chiefName, workerName].filter((n) => !profiles.some((p) => p.name === n));
      if (missing.length || !boards.some((b) => b.slug === slug && !b.archived)) {
        throw new StepError('verify', 'resource_missing', 'A Hermes resource disappeared during provisioning.', { retryable: true });
      }
      if (inventoryHash(this.depts.getInventory(id)) !== inventoryHash(inv)) {
        throw new StepError('verify', 'inventory_changed', 'The inventory changed while provisioning; provision again to apply it.', { retryable: true });
      }
      this.depts.patchRow(id, { inventory_applied_hash: inventoryHash(inv), inventory_applied_at: now(), observed_config_json: JSON.stringify(observed) });
    });
  }

  private workdirFor(row: DepartmentRow): string | undefined {
    // The stored path stays server-side; Hermes uses it as the board's default workdir (advisory, not isolation).
    return row.workspace_path ?? undefined;
  }

  // ---- inventory application ----------------------------------------------------

  private async applyInventory(id: string, chief: string, worker: string): Promise<ObservedConfig> {
    const row = this.depts.getRow(id);
    const inv = this.depts.getInventory(id);
    const roles: [Role, string, string][] = [['chief', chief, worker], ['worker', worker, chief]];
    const out: Partial<Record<Role, ObservedRole>> = {};
    for (const [role, profile, counterpart] of roles) {
      // toolsets: every toolset Hermes lists is set explicitly, so nothing outside the allowance stays on.
      const universe = Object.keys(await this.hermes.getToolsets(profile));
      const want = desiredToolsetMap(universe, effectiveToolsets(role, inv));
      await this.hermes.setToolsets(profile, {
        enable: universe.filter((t) => want[t]),
        disable: universe.filter((t) => !want[t]),
      });
      // skills: everything installed that is not allowed is disabled
      const installed = (await this.hermes.listSkills(profile)).map((s) => s.name);
      await this.hermes.setDisabledSkills(profile, skillsToDisable(inv, installed));
      // model: only when the department states a preference
      const model = preferredModel(inv, await this.hermes.getModel(profile));
      if (model) await this.hermes.setModel(profile, model);
      // instructions: managed block only
      const block = buildBlock({ deptId: id, deptName: row.name, purpose: row.purpose, role, counterpart, inv });
      const soul = await this.hermes.readInstructions(profile);
      const next = upsertBlock(soul, block, id, role);
      if (next !== soul) await this.hermes.writeInstructions(profile, next);
      out[role] = await this.observeRole(id, role, profile, counterpart);
    }
    return { at: now(), globalConcurrencyCap: await this.hermes.getConcurrencyCap(), chief: out.chief!, worker: out.worker! };
  }

  /** Read-only: what Hermes currently reports for one profile. */
  private async observeRole(id: string, role: Role, profile: string, counterpart: string): Promise<ObservedRole> {
    const row = this.depts.getRow(id);
    const inv = this.depts.getInventory(id);
    const skills = await this.hermes.listSkills(profile);
    const soul = await this.hermes.readInstructions(profile);
    const block = buildBlock({ deptId: id, deptName: row.name, purpose: row.purpose, role, counterpart, inv });
    return {
      profile,
      toolsets: await this.hermes.getToolsets(profile),
      installedSkills: skills.map((s) => s.name),
      enabledSkills: skills.filter((s) => s.enabled).map((s) => s.name),
      model: await this.hermes.getModel(profile),
      instructionsPresent: hasBlock(soul, block),
    };
  }

  // ---- reconciliation ------------------------------------------------------------

  /**
   * Compares stored state with live Hermes. Ready departments go `disconnected` when Hermes is unreachable and
   * come back to `ready` when everything verifies; missing resources or drift trigger an idempotent re-provision
   * (which recreates Vibe City-created resources; an associated profile that vanished becomes an error).
   */
  async reconcile(id: string): Promise<ProvisioningStatus> {
    const row = this.depts.getRow(id);
    if (row.archived_at || this.inflight.has(id)) return this.status(id);
    if (row.provisioning_state === 'unconfigured' || row.provisioning_state === 'provisioning') return this.status(id);
    if (row.provisioning_state === 'error') return this.status(id); // explicit retry only

    let health;
    try {
      health = await this.hermes.health();
    } catch {
      health = { dashboard: 'down', auth: 'unknown' } as const;
    }
    if (health.dashboard === 'down') {
      this.depts.patchRow(id, {
        provisioning_state: 'disconnected',
        provisioning_error_json: JSON.stringify(this.err('health', 'hermes_unreachable', 'Hermes is unreachable.', true)),
      });
      return this.status(id);
    }
    if (health.auth === 'rejected') {
      this.depts.patchRow(id, {
        provisioning_state: 'error',
        provisioning_error_json: JSON.stringify(this.err('health', 'hermes_auth', 'Hermes rejected the configured session token.', false)),
      });
      return this.status(id);
    }

    try {
      const problems = await this.verifyLive(id);
      if (problems.length === 0) {
        this.depts.patchRow(id, { provisioning_state: 'ready', provisioning_error_json: null, last_reconciled_at: now() });
        return this.status(id);
      }
    } catch (e) {
      if (e instanceof HermesUnavailableError) {
        this.depts.patchRow(id, {
          provisioning_state: 'disconnected',
          provisioning_error_json: JSON.stringify(this.err('verify', 'hermes_unreachable', 'Hermes is unreachable.', true)),
        });
        return this.status(id);
      }
      throw e;
    }
    // Something is missing or drifted: heal through the same idempotent path.
    return this.provision(id);
  }

  async reconcileAll(): Promise<ProvisioningStatus[]> {
    const out: ProvisioningStatus[] = [];
    for (const id of this.depts.activeIds()) {
      try {
        out.push(await this.reconcile(id));
      } catch { /* one department must not stop the sweep */ }
    }
    return out;
  }

  /** Empty = everything the stored state claims still holds in Hermes. */
  private async verifyLive(id: string): Promise<string[]> {
    const row = this.depts.getRow(id);
    const problems: string[] = [];
    const slug = boardSlugForDepartment(id);
    const boards = await this.hermes.listBoards();
    if (!boards.some((b) => b.slug === slug && !b.archived)) problems.push('board missing');
    const profiles = await this.hermes.listProfiles();
    for (const [role, ref] of [['chief', row.chief_profile_ref], ['worker', row.worker_profile_ref]] as const) {
      if (!ref || !profiles.some((p) => p.name === ref)) problems.push(`${role} profile missing`);
    }
    if (problems.length) return problems;
    const inv = this.depts.getInventory(id);
    if (row.inventory_applied_hash !== inventoryHash(inv)) return ['inventory not applied'];
    const chief = row.chief_profile_ref!;
    const worker = row.worker_profile_ref!;
    const [oc, ow] = [await this.observeRole(id, 'chief', chief, worker), await this.observeRole(id, 'worker', worker, chief)];
    problems.push(...diffObserved('chief', inv, oc).map((d) => `chief: ${d}`), ...diffObserved('worker', inv, ow).map((d) => `worker: ${d}`));
    if (!problems.length) {
      const prev = row.observed_config_json ? (JSON.parse(row.observed_config_json) as ObservedConfig) : null;
      this.depts.patchRow(id, {
        observed_config_json: JSON.stringify({ at: now(), globalConcurrencyCap: prev?.globalConcurrencyCap ?? null, chief: oc, worker: ow } satisfies ObservedConfig),
      });
    }
    return problems;
  }
}
