import type { DatabaseSync } from 'node:sqlite';
import {
  AGENT_EXCLUDED_TOOLSETS, TOOLSETS, boardSlugForDepartment, profileNameForAgent,
  type AgentView, type EffectiveInventory, type HealthView, type HermesDefaultsView, type HermesModelsView, type Inventory, type ProfilesView, type ProvisioningError, type ProvisioningStatus, type SyncCheck,
} from '@vibe-city/shared';
import {
  HermesAuthError, HermesRejectedError, HermesUnavailableError, type HermesRuntime,
} from '../hermes/ports.ts';
import { ConflictError, NotFoundError } from './errors.ts';
import { scrub } from './scrub.ts';
import { agentModel, agentSkills, type AgentRow, type DepartmentService } from './departmentService.ts';
import { buildBlock, hasBlock, upsertBlock } from './instructions.ts';
import {
  ESSENTIAL_SKILLS, REQUIRED_TOOLSETS, agentInventory, buildAgentReport, buildDepartmentWideReport, desiredHash, desiredToolsetMap, diffObserved,
  effectiveSkills, effectiveToolsets, modelToApply, parseObserved, skillsToDisable, type ObservedConfig, type ObservedRole,
} from './inventoryPolicy.ts';

type Step = ProvisioningError['step'];
/** user = the CEO's Sync; background = the periodic check (heals drift); check = Refresh (reads only). */
type SyncMode = 'user' | 'background' | 'check';
const seatName = (m: Member) => (m.lead ? 'Lead' : m.key);

/** An agent as provisioning sees it: its profile name (stored, or the managed default) and where that came from. */
interface Member { a: AgentRow; key: string; lead: boolean; profile: string; origin: 'created' | 'associated' }

const members = (deptId: string, agents: AgentRow[]): Member[] => agents.map((a) => ({
  a, key: a.agent_key, lead: a.seat === 0,
  profile: a.profile_ref ?? profileNameForAgent(deptId, a.agent_key),
  // Before provisioning has recorded an origin, a user-chosen ref is by definition an association.
  origin: a.origin ?? (a.profile_ref ? 'associated' : 'created'),
}));

const hashOf = (inv: Inventory, ms: Member[]) =>
  desiredHash(inv, ms.map((m) => ({ key: m.key, profile: m.profile, model: agentModel(m.a), skills: agentSkills(m.a) })));
/** Pre-agent errors were tagged with the role step they failed in. */
const STEP_ALIASES: Record<string, Step> = { chief: 'agents', worker: 'agents' };

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

/** Agents synced at once. Each toolset read is a `hermes` CLI process (a few seconds of Python start-up). */
const AGENT_PARALLELISM = 4;
/** Apply + read-back rounds per agent before a difference counts as a verification failure. */
const MAX_APPLY_ROUNDS = 3;

/** Runs `fn` over `items`, at most `limit` at a time; waits for every one, then rethrows the first failure. */
async function settleAll<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: PromiseSettledResult<R>[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!).then((value) => ({ status: 'fulfilled', value }) as const, (reason: unknown) => ({ status: 'rejected', reason }) as const);
    }
  }));
  const bad = out.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (bad) throw bad.reason;
  return out.map((r) => (r as PromiseFulfilledResult<R>).value);
}

export class ProvisioningService {
  private db: DatabaseSync;
  private depts: DepartmentService;
  private hermes: HermesRuntime;
  private inflight = new Map<string, { p: Promise<unknown>; mode: SyncMode }>();
  private sweep: Promise<ProvisioningStatus[]> | null = null;

  /** Runs after a successful provisioning, before the department is marked ready, with every agent's profile. Errors are swallowed. */
  afterProvision: ((departmentId: string, profiles: string[]) => Promise<void>) | null = null;

  constructor(db: DatabaseSync, depts: DepartmentService, hermes: HermesRuntime) {
    this.db = db;
    this.depts = depts;
    this.hermes = hermes;
  }

  // ---- views -----------------------------------------------------------------

  /** Whether what Hermes was last given still matches the inventory and the team. */
  private inSync(id: string): boolean {
    return this.depts.getRow(id).inventory_applied_hash === hashOf(this.depts.getInventory(id), members(id, this.depts.agents(id)));
  }

  status(id: string): ProvisioningStatus {
    const r = this.depts.getRow(id);
    const confirmed = JSON.parse(r.confirmed_profile_refs_json) as string[];
    const error = r.provisioning_error_json ? (JSON.parse(r.provisioning_error_json) as ProvisioningError) : null;
    return {
      departmentId: id,
      state: r.provisioning_state,
      attempts: r.provisioning_attempts,
      error: error ? { ...error, step: STEP_ALIASES[error.step] ?? error.step } : null,
      board: {
        ref: r.hermes_board_ref, verified: r.board_verified_at !== null, verifiedAt: r.board_verified_at,
        origin: r.hermes_board_ref ? 'created' : null, modificationConfirmed: null,
      },
      agents: this.depts.agents(id).map((a) => {
        const origin = a.origin ?? (a.profile_ref ? 'associated' : null);
        return {
          key: a.agent_key, ref: a.profile_ref, verified: a.verified_at !== null, verifiedAt: a.verified_at, origin,
          modificationConfirmed: origin === 'associated' ? !!a.profile_ref && confirmed.includes(a.profile_ref) : null,
        };
      }),
      inventory: {
        applied: r.inventory_applied_at !== null,
        appliedAt: r.inventory_applied_at,
        inSync: this.inSync(id),
      },
      lastReconciledAt: r.last_reconciled_at,
    };
  }

  effectiveInventory(id: string): EffectiveInventory {
    const r = this.depts.getRow(id);
    const inv = this.depts.getInventory(id);
    const agents = this.depts.agents(id);
    const obs = parseObserved(r.observed_config_json);
    const inSync = this.inSync(id);
    // Observed data is only trusted for the report while it matches the current inventory and team.
    const usable = inSync ? obs : null;
    return {
      departmentId: id,
      observedAt: obs?.at ?? null,
      inSync,
      agents: agents.map((a) => ({
        agentKey: a.agent_key, profileRef: a.profile_ref,
        entries: buildAgentReport(agentInventory(inv, { model: agentModel(a), skills: agentSkills(a) }), usable?.agents[a.agent_key] ?? null),
      })),
      departmentWide: buildDepartmentWideReport(inv, agents.length, obs?.globalConcurrencyCap),
    };
  }

  async health(): Promise<HealthView> {
    return { checkedAt: now(), hermes: await this.hermes.health() };
  }

  /** Hermes' model picker data, read live: the only models a department can choose from. */
  async hermesModels(): Promise<HermesModelsView> {
    return { checkedAt: now(), ...(await this.hermes.listModels()) };
  }

  /** Hermes' `default` profile, read live: the starting point of a new department's capabilities. */
  async hermesDefaults(): Promise<HermesDefaultsView> {
    const toolsets = await this.hermes.getToolsets('default');
    const skills = await this.hermes.listSkills('default');
    const known = new Set<string>(TOOLSETS);
    const excluded = new Set<string>(AGENT_EXCLUDED_TOOLSETS);
    return {
      checkedAt: now(), profile: 'default', model: (await this.hermes.getModel('default')).id,
      toolsets: Object.entries(toolsets).map(([name, enabled]) => ({ name, enabled, manageable: known.has(name) && !excluded.has(name) && !(REQUIRED_TOOLSETS as readonly string[]).includes(name) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      skills: skills.map((x) => ({ name: x.name, enabled: x.enabled })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async profiles(id: string): Promise<ProfilesView> {
    const agents = this.depts.agents(id);
    try {
      const list = await this.hermes.listProfiles();
      return {
        departmentId: id, reachable: true,
        agents: agents.map(({ agent_key: key, profile_ref: ref }) => {
          const p = ref ? list.find((x) => x.name === ref) : undefined;
          return { key, ref, exists: ref ? !!p : null, model: p?.model ?? null, description: p?.description ?? null };
        }),
      };
    } catch (e) {
      if (!(e instanceof HermesUnavailableError) && !(e instanceof HermesAuthError)) throw e;
      return { departmentId: id, reachable: false, agents: agents.map((a) => ({ key: a.agent_key, ref: a.profile_ref, exists: null, model: null, description: null })) };
    }
  }

  /**
   * One agent of the department (its own Hermes profile). Skills/toolsets/model are the last read-back from Hermes
   * (no CLI call per view); sessions are read live and degrade to null with a reason when Hermes is unavailable.
   */
  async agent(id: string, agentKey: string): Promise<AgentView> {
    const r = this.depts.getRow(id);
    const a = this.depts.agents(id).find((x) => x.agent_key === agentKey);
    if (!a) throw new NotFoundError('agent not found');
    const ref = a.profile_ref;
    const o = parseObserved(r.observed_config_json)?.agents[agentKey] ?? null;
    const enabled = new Set(o?.enabledSkills ?? []);
    let sessions: AgentView['sessions'] = null;
    let sessionsError: string | null = null;
    if (!ref) sessionsError = 'This agent has no Hermes profile yet. Sync the department first.';
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
      departmentId: id, agentKey, lead: a.seat === 0, profileRef: ref, observedAt: o ? parseObserved(r.observed_config_json)!.at : null,
      model: o?.model ?? null, provider: o?.provider ?? null,
      skills: (o?.installedSkills ?? []).map((name) => ({ name, enabled: enabled.has(name), essential: (ESSENTIAL_SKILLS as readonly string[]).includes(name) })).sort((a, b) => a.name.localeCompare(b.name)),
      toolsets: Object.entries(o?.toolsets ?? {}).map(([name, on]) => ({ name, enabled: on })).sort((a, b) => a.name.localeCompare(b.name)),
      sessions, sessionsError,
    };
  }

  // ---- sync: provisioning and reconciliation are one operation ------------------------

  /**
   * The CEO's Sync. Idempotent. A second one while one runs is refused (409); a background check or a Refresh check that
   * is running is waited for first, so the button never fails just because the 30 s check happened to be underway.
   */
  provision(id: string): Promise<ProvisioningStatus> {
    const row = this.depts.getRow(id); // 404 if unknown
    if (row.archived_at) throw new ConflictError('department is archived');
    const cur = this.inflight.get(id);
    if (cur?.mode === 'user') throw new ConflictError('a sync is already running for this department');
    if (cur) return cur.p.catch(() => undefined).then(() => this.provision(id));
    return this.start(id, 'user').then((r) => r.status);
  }

  /**
   * Refresh: the same sync with every write left out. Reads Hermes and lists what differs from the department (empty =
   * in sync). Never changes Hermes; a department that fully verifies is marked ready, one that differs keeps its state.
   */
  async check(id: string): Promise<SyncCheck> {
    const row = this.depts.getRow(id); // 404 if unknown
    if (row.archived_at) throw new ConflictError('department is archived');
    const cur = this.inflight.get(id);
    if (cur) await cur.p.catch(() => undefined);
    const { status, differences } = await this.start(id, 'check');
    return { inSync: status.state === 'ready' && differences.length === 0, differences, status };
  }

  /** Like provision, but only valid after a failed or interrupted attempt. */
  retry(id: string): Promise<ProvisioningStatus> {
    const s = this.depts.getRow(id).provisioning_state;
    if (s !== 'error' && s !== 'disconnected') throw new ConflictError(`nothing to retry: department is ${s}`);
    return this.provision(id);
  }

  /**
   * Background check of a provisioned (ready/disconnected) department: the same sync, which writes to Hermes only when
   * something vanished or drifted. Unconfigured and errored departments wait for the CEO.
   */
  reconcile(id: string): Promise<ProvisioningStatus> {
    const r = this.depts.getRow(id);
    if (r.archived_at || this.inflight.has(id) || (r.provisioning_state !== 'ready' && r.provisioning_state !== 'disconnected')) {
      return Promise.resolve(this.status(id));
    }
    return this.start(id, 'background').then((r) => r.status);
  }

  /** One sweep at a time: a call while a sweep runs (timer or API) gets that sweep's result instead of starting another. */
  reconcileAll(): Promise<ProvisioningStatus[]> {
    return (this.sweep ??= this.sweepAll().finally(() => { this.sweep = null; }));
  }

  private async sweepAll(): Promise<ProvisioningStatus[]> {
    const out: ProvisioningStatus[] = [];
    for (const id of this.depts.activeIds()) {
      try {
        out.push(await this.reconcile(id));
      } catch { /* one department must not stop the sweep */ }
    }
    return out;
  }

  /** At process start: a crash mid-provisioning leaves state 'provisioning'. Verified-step flags make resuming safe. */
  recoverInterrupted(): number {
    let n = 0;
    for (const id of this.depts.activeIds()) {
      const r = this.depts.getRow(id);
      if (r.provisioning_state !== 'provisioning' || this.inflight.has(id)) continue;
      this.depts.patchRow(id, {
        provisioning_state: 'error',
        provisioning_error_json: JSON.stringify(this.err('verify', 'interrupted', 'The sync was interrupted (restart); sync again to resume.', true)),
      });
      n++;
    }
    return n;
  }

  private err(step: Step, code: string, message: string, retryable: boolean): ProvisioningError {
    return { code, step, message, retryable, at: now() };
  }

  private start(id: string, mode: SyncMode): Promise<{ status: ProvisioningStatus; differences: string[] }> {
    const p = this.sync(id, mode).finally(() => this.inflight.delete(id));
    this.inflight.set(id, { p, mode });
    return p;
  }

  /**
   * One sync: read what Hermes has, change only what differs, read the changes back. `ready` only after every agent
   * verifies against Hermes. The department leaves `ready` (new quests wait) only while Hermes is being changed, so a
   * background check that finds nothing to fix is invisible.
   */
  private async sync(id: string, mode: SyncMode): Promise<{ status: ProvisioningStatus; differences: string[] }> {
    const user = mode === 'user';
    let marked = false;
    const differences: string[] = [];
    /** Called before every write to Hermes with what it fixes. False = leave it (a check only collects differences). */
    const writing = (what: string) => {
      if (mode === 'check') { differences.push(what); return false; }
      if (!marked) {
        marked = true;
        this.depts.patchRow(id, { provisioning_state: 'provisioning', provisioning_attempts: this.depts.getRow(id).provisioning_attempts + 1, provisioning_error_json: null });
      }
      return true;
    };
    if (user) {
      writing('');
      // "verified" means verified in the latest attempt; every step re-verifies and re-stamps.
      this.depts.patchRow(id, { board_verified_at: null });
      for (const a of this.depts.agents(id)) this.depts.patchAgent(id, a.agent_key, { verified_at: null });
    }
    try {
      const changed = await this.steps(id, writing);
      if (differences.length) return { status: this.status(id), differences };
      // Best effort extras (e.g. the Vibe City MCP server on every agent), after a change or when the CEO asks. Never fails the sync.
      const profiles = this.depts.agents(id).map((a) => a.profile_ref).filter((p): p is string => !!p);
      if ((user || changed) && profiles.length && this.afterProvision) {
        try { await this.afterProvision(id, profiles); } catch (e) { console.warn(`after-provision hook failed for ${id}: ${(e as Error).message}`); }
      }
      this.depts.patchRow(id, { provisioning_state: 'ready', provisioning_error_json: null, last_reconciled_at: now() });
    } catch (e) {
      this.fail(id, e);
    }
    return { status: this.status(id), differences };
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
      perr = this.err('verify', 'internal', 'Unexpected error while syncing with Hermes.', true);
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

  /** Returns whether anything was written to Hermes. In a check (writing returns false) it stops before verifying once something differs. */
  private async steps(id: string, writing: (what: string) => boolean): Promise<boolean> {
    const row = this.depts.getRow(id);
    const slug = boardSlugForDepartment(id);
    const team = members(id, this.depts.agents(id));
    const inv = this.depts.getInventory(id);
    let changed = false;
    let differs = false;
    const write = (what: string) => { if (writing(what)) return (changed = true); differs = true; return false; };

    // 1. health
    await this.step('health', async () => {
      const h = await this.hermes.health();
      if (h.dashboard === 'down') throw new StepError('health', 'hermes_unreachable', 'Hermes dashboard is not reachable.', { retryable: true, unavailable: true });
      if (h.auth === 'rejected') throw new StepError('health', 'hermes_auth', 'Hermes rejected the configured session token.', { retryable: false });
    });

    // 2. validate profile choices
    const existing = await this.step('validate', () => this.hermes.listProfiles());
    for (const { key, profile: name, origin } of team) {
      if (origin === 'associated' && !existing.some((p) => p.name === name)) {
        throw new StepError('validate', 'profile_not_found', `The profile "${name}" of agent ${key} does not exist in Hermes.`, { retryable: false });
      }
      if (name === 'default') throw new StepError('validate', 'profile_reserved', 'The default profile cannot be a department profile.', { retryable: false });
    }
    // Safeguard: never modify a pre-existing profile without explicit, per-profile consent. Checked before anything
    // is created or changed in Hermes, so a refusal leaves Hermes exactly as it was.
    const confirmed = JSON.parse(row.confirmed_profile_refs_json) as string[];
    for (const { key, profile: name, origin } of team) {
      if (origin === 'associated' && !confirmed.includes(name)) {
        throw new StepError('validate', 'confirmation_required',
          `The profile "${name}" of agent ${key} already exists. Syncing would change its toolsets, skills, model and instructions, which may affect its use outside Vibe City. Confirm this explicitly (confirmModifyProfiles) or use a Vibe City-managed profile instead.`,
          { retryable: false });
      }
    }

    // 3. board (derived slug; Hermes create is idempotent and we check first)
    await this.step('board', async () => {
      let board = (await this.hermes.listBoards()).find((b) => b.slug === slug);
      if (board?.archived) throw new StepError('board', 'board_archived', 'The department board exists in Hermes but is archived.', { retryable: false });
      if (!board) {
        if (!write('The Kanban board is missing')) return;
        await this.hermes.createBoard(slug, row.name);
        board = (await this.hermes.listBoards()).find((b) => b.slug === slug);
        if (!board) throw new StepError('board', 'board_not_found_after_create', 'Hermes did not report the board after creating it.', { retryable: true });
      }
      this.depts.patchRow(id, { hermes_board_ref: slug, board_sync_state: 'synced', board_verified_at: now() });
    });

    // 4. every agent at once (each is its own profile): create it if missing, read it, change what differs, read back.
    // The host-wide concurrency cap is a slow CLI read: only on the CEO's sync or while unknown.
    const prevCap = parseObserved(row.observed_config_json)?.globalConcurrencyCap ?? null;
    const cap = prevCap === null || row.provisioning_state !== 'ready' ? this.hermes.getConcurrencyCap().catch(() => null) : Promise.resolve(prevCap);
    const names = new Set(existing.map((p) => p.name));
    const observed = await settleAll(team, AGENT_PARALLELISM, (m) => this.syncAgent(id, m, team, inv, names, write));
    if (differs) return false;

    // 5. final verification: everything still present and neither the inventory nor the team changed mid-run
    await this.step('verify', async () => {
      const [profiles, boards] = await Promise.all([this.hermes.listProfiles(), this.hermes.listBoards()]);
      const missing = team.map((m) => m.profile).filter((n) => !profiles.some((p) => p.name === n));
      if (missing.length || !boards.some((b) => b.slug === slug && !b.archived)) {
        throw new StepError('verify', 'resource_missing', 'A Hermes resource disappeared during the sync.', { retryable: true });
      }
      const applied = hashOf(inv, team);
      if (hashOf(this.depts.getInventory(id), members(id, this.depts.agents(id))) !== applied) {
        throw new StepError('verify', 'inventory_changed', 'The inventory or the team changed during the sync; sync again to apply it.', { retryable: true });
      }
      const obs: ObservedConfig = { at: now(), globalConcurrencyCap: await cap, agents: Object.fromEntries(team.map((m, i) => [m.key, observed[i]!])) as Record<string, ObservedRole> };
      this.depts.patchRow(id, {
        inventory_applied_hash: applied, observed_config_json: JSON.stringify(obs),
        ...(changed || !row.inventory_applied_at ? { inventory_applied_at: now() } : {}),
      });
    });
    return changed;
  }

  // ---- one agent ----------------------------------------------------------------------

  /** The agent as verified, or null when a check found it differs (nothing was written). */
  private async syncAgent(id: string, m: Member, team: Member[], base: Inventory, existing: Set<string>, write: (what: string) => boolean): Promise<ObservedRole | null> {
    const present = await this.step('agents', async () => {
      if (!existing.has(m.profile)) {
        if (!write(`${seatName(m)}: Hermes profile ${m.profile} is missing`)) return false;
        await this.hermes.createProfile(m.profile, { description: `Agent ${m.key} of department "${this.depts.getRow(id).name}" (managed by Vibe City)` });
        if (!(await this.hermes.listProfiles()).some((p) => p.name === m.profile)) {
          throw new StepError('agents', 'profile_not_found_after_create', `Hermes did not report profile "${m.profile}" after creating it.`, { retryable: true });
        }
      }
      // persisted right away, so a failure elsewhere resumes without recreating
      this.depts.patchAgent(id, m.key, { profile_ref: m.profile, origin: m.origin });
      return true;
    });
    if (!present) return null;
    return this.step('inventory', async () => {
      const want = agentInventory(base, { model: agentModel(m.a), skills: agentSkills(m.a) });
      const block = this.block(id, m, team);
      let { observed, soul } = await this.read(m, block);
      // Converge: Hermes can change a profile underneath us (other `hermes` runs install newly bundled skills, enabled,
      // into existing profiles), so a read-back that still differs gets one more apply. Bounded; then it is an error.
      for (let round = 0; round < MAX_APPLY_ROUNDS; round++) {
        const r = await this.apply(id, m, want, observed, soul, block, write);
        if (r === 'differs') return null;
        if (r === 'same') break;
        ({ observed, soul } = await this.read(m, block));
      }
      const problems = diffObserved(want, observed);
      if (problems.length) {
        throw new StepError('inventory', 'inventory_verification_failed', `Applied inventory does not match what Hermes reports (${problems.length} difference(s)).`, { retryable: true });
      }
      this.depts.patchAgent(id, m.key, { verified_at: now() });
      return observed;
    });
  }

  /** The block an agent's SOUL.md must contain: the same rules for everyone, plus who its teammates are. */
  private block(id: string, m: Member, team: Member[]): string {
    const row = this.depts.getRow(id);
    return buildBlock({
      deptId: id, deptName: row.name, purpose: row.purpose, agentKey: m.key, lead: m.lead,
      teammates: team.filter((t) => t.key !== m.key).map((t) => t.profile), inv: this.depts.getInventory(id),
    });
  }

  /** Read-only: what Hermes currently reports for one agent's profile. */
  private async read(m: Member, block: string): Promise<{ observed: ObservedRole; soul: string | null }> {
    // The CLI read goes first: a `hermes` run can install newly bundled skills into the profile, so skills read alongside
    // it can miss one that is enabled a moment later (seen on freshly cloned profiles). The rest is milliseconds.
    const toolsets = await this.hermes.getToolsets(m.profile);
    const [skills, model, soul] = await Promise.all([
      this.hermes.listSkills(m.profile), this.hermes.getModel(m.profile), this.hermes.readInstructions(m.profile),
    ]);
    return {
      soul,
      observed: {
        profile: m.profile, toolsets,
        installedSkills: skills.map((s) => s.name), enabledSkills: skills.filter((s) => s.enabled).map((s) => s.name),
        model: model.id, provider: model.provider, instructionsPresent: hasBlock(soul, block),
      },
    };
  }

  /** Writes only what differs from `want`: 'same' = nothing to do, 'differs' = a check left it, 'written' = applied. */
  private async apply(id: string, m: Member, want: Inventory, o: ObservedRole, soul: string | null, block: string, write: (what: string) => boolean): Promise<'same' | 'differs' | 'written'> {
    // toolsets: every toolset Hermes lists has a wanted state, so nothing outside the allowance stays on
    const wantTools = desiredToolsetMap(Object.keys(o.toolsets), effectiveToolsets(want));
    const enable = Object.keys(wantTools).filter((t) => wantTools[t] && !o.toolsets[t]);
    const disable = Object.keys(wantTools).filter((t) => !wantTools[t] && o.toolsets[t]);
    const skillsOk = JSON.stringify(effectiveSkills(want, o.installedSkills)) === JSON.stringify([...o.enabledSkills].sort());
    const model = modelToApply(want, { id: o.model, provider: o.provider });
    const nextSoul = upsertBlock(soul, block, id, m.key);
    const what = [
      enable.length ? `${enable.join(', ')} off in Hermes (should be on)` : '', disable.length ? `${disable.join(', ')} on in Hermes (should be off)` : '',
      skillsOk ? '' : 'skills differ', model ? `model is ${o.model ?? 'unset'} (should be ${model.id})` : '', nextSoul === soul ? '' : 'instructions are out of date',
    ].filter(Boolean);
    if (!what.length) return 'same';
    if (!write(`${seatName(m)}: ${what.join('; ')}`)) return 'differs';
    await Promise.all([
      nextSoul !== soul ? this.hermes.writeInstructions(m.profile, nextSoul) : null,
      // toolsets, skills and model all live in the profile's config.yaml: one writer at a time
      (async () => {
        if (enable.length || disable.length) await this.hermes.setToolsets(m.profile, { enable, disable });
        if (!skillsOk) await this.hermes.setDisabledSkills(m.profile, skillsToDisable(want, o.installedSkills));
        if (model) await this.hermes.setModel(m.profile, model);
      })(),
    ]);
    return 'written';
  }
}
