import { createHash } from 'node:crypto';
import { AGENT_EXCLUDED_TOOLSETS, type CapabilityEntry, type Inventory, type ModelChoice } from '@vibe-city/shared';

type Draft = Omit<CapabilityEntry, 'guarantee'>;
/** A guarantee exists only where behavior was tested (status 'enforced'); everything else is explicitly not one. */
const withGuarantee = (e: Draft): CapabilityEntry => ({ ...e, guarantee: e.status === 'enforced' });

/** Always enabled: Hermes' Kanban lifecycle tools (complete/block/comment/create) are how any agent reports. */
export const REQUIRED_TOOLSETS = ['kanban'] as const;
/** Hermes pins these skills on ("cannot be disabled from any surface", agent/skill_utils.py ESSENTIAL_SKILLS). */
export const ESSENTIAL_SKILLS = ['hermes-agent'] as const;
/** Restrictions whose runtime effect was verified against real Hermes (a disabled toolset was confirmed unavailable to the agent). */
export const BEHAVIOR_TESTED_TOOLSETS = ['terminal', 'file', 'web', 'browser', 'code_execution'] as const;

/**
 * Effective = the department allowance minus what no agent gets (delegation, cronjob), plus required toolsets.
 * Toolsets are department-wide: every agent gets the same set.
 */
export function effectiveToolsets(inv: Inventory): string[] {
  const allowed = inv.allowedToolsets.filter((t) => !(AGENT_EXCLUDED_TOOLSETS as readonly string[]).includes(t));
  return [...new Set([...allowed, ...REQUIRED_TOOLSETS])].sort();
}

/** What one agent's profile must have: the department inventory plus the agent's own skills, and its own model if it has one. */
export function agentInventory(inv: Inventory, agent: { model: ModelChoice | null; skills: string[] }): Inventory {
  return { ...inv, model: agent.model ?? inv.model, allowedSkillIds: [...new Set([...inv.allowedSkillIds, ...agent.skills])] };
}

/** Desired state for every toolset Hermes reports: enabled iff in the effective set. */
export function desiredToolsetMap(universe: string[], effective: string[]): Record<string, boolean> {
  const eff = new Set(effective);
  return Object.fromEntries(universe.map((t) => [t, eff.has(t)]));
}

export const effectiveSkills = (inv: Inventory, installed: string[]) =>
  installed.filter((s) => inv.allowedSkillIds.includes(s) || (ESSENTIAL_SKILLS as readonly string[]).includes(s)).sort();

/** Skills to put in Hermes' disabled list: everything installed that is neither allowed nor essential. */
export const skillsToDisable = (inv: Inventory, installed: string[]) =>
  installed.filter((s) => !inv.allowedSkillIds.includes(s) && !(ESSENTIAL_SKILLS as readonly string[]).includes(s));

/** The model to set on the profile; null when the department keeps the profile's own default. Unchanged pairs are not rewritten. */
export const modelToApply = (inv: Inventory, current: { id: string | null; provider: string | null }): ModelChoice | null => {
  if (!inv.model) return null;
  return current.id === inv.model.id && current.provider === inv.model.provider ? null : inv.model;
};

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function inventoryHash(inv: Inventory): string {
  return createHash('sha256').update(stableStringify(inv)).digest('hex').slice(0, 32);
}

/** Everything provisioning applies: the inventory and the team (each agent's profile, model and skills go into Hermes). */
export function desiredHash(inv: Inventory, agents: { key: string; profile: string; model: ModelChoice | null; skills: string[] }[]): string {
  return createHash('sha256').update(stableStringify({ inv, agents })).digest('hex').slice(0, 32);
}

/** What was last read back from a Hermes profile. */
export interface ObservedRole {
  profile: string;
  toolsets: Record<string, boolean>;
  enabledSkills: string[];
  installedSkills: string[];
  model: string | null;
  provider: string | null;
  instructionsPresent: boolean;
}

export interface ObservedConfig {
  at: string;
  globalConcurrencyCap: number | null;
  /** Agent key -> what its profile reported. */
  agents: Record<string, ObservedRole>;
}

/** Reads stored observations; anything from before per-agent profiles counts as never observed. */
export function parseObserved(json: string | null): ObservedConfig | null {
  if (!json) return null;
  const o = JSON.parse(json) as Partial<ObservedConfig>;
  return o.agents ? (o as ObservedConfig) : null;
}

/** Differences between what an agent's inventory demands and what Hermes reports (empty = in sync). */
export function diffObserved(inv: Inventory, o: ObservedRole): string[] {
  const diffs: string[] = [];
  const want = desiredToolsetMap(Object.keys(o.toolsets), effectiveToolsets(inv));
  for (const [t, on] of Object.entries(want)) if (o.toolsets[t] !== on) diffs.push(`toolset ${t} is ${o.toolsets[t] ? 'enabled' : 'disabled'}, expected ${on ? 'enabled' : 'disabled'}`);
  const wantSkills = effectiveSkills(inv, o.installedSkills);
  const have = [...o.enabledSkills].sort();
  if (JSON.stringify(wantSkills) !== JSON.stringify(have)) diffs.push('enabled skills differ from the inventory');
  if (inv.model && o.model !== inv.model.id) diffs.push(`default model is ${o.model ?? 'unset'}, expected ${inv.model.id}`);
  if (!o.instructionsPresent) diffs.push('department instructions block is missing');
  return diffs;
}

/** Honest, per-capability report for one agent. `enforced` only where behavior was tested against real Hermes. */
export function buildAgentReport(inv: Inventory, o: ObservedRole | null): CapabilityEntry[] {
  const entries: Draft[] = [];
  const effTools = effectiveToolsets(inv);
  const tested = new Set<string>(BEHAVIOR_TESTED_TOOLSETS);
  const diffs = o ? diffObserved(inv, o) : null;
  const toolsetOk = o !== null && !diffs!.some((d) => d.startsWith('toolset'));
  const universe = o ? Object.keys(o.toolsets) : [];
  const notEffective = universe.filter((t) => !effTools.includes(t));

  entries.push({
    capability: 'toolsets.behavior-tested',
    requested: inv.allowedToolsets.filter((t) => tested.has(t)),
    effective: effTools.filter((t) => tested.has(t)),
    status: toolsetOk ? 'enforced' : 'unverified',
    detail: toolsetOk
      ? 'terminal, file, web, browser, code_execution: applied, read back, and tested against real Hermes (a disabled toolset is not available to the agent).'
      : 'Not yet applied or not matching Hermes; sync the department.',
  });
  entries.push({
    capability: 'toolsets.other',
    requested: inv.allowedToolsets.filter((t) => !tested.has(t)),
    effective: effTools.filter((t) => !tested.has(t)),
    status: toolsetOk ? 'configured' : 'unverified',
    detail: `Applied and read back; runtime behavior not tested. Disabled in Hermes: ${notEffective.filter((t) => !tested.has(t)).join(', ') || 'none observed'}. "kanban" is always enabled (required for task reporting); delegation and cronjob are never enabled (sub-agents and cron jobs would run outside the department board).`,
  });

  const skillsOk = o !== null && !diffs!.some((d) => d.includes('skills'));
  entries.push({
    capability: 'skills',
    requested: inv.allowedSkillIds,
    effective: o ? effectiveSkills(inv, o.installedSkills) : [],
    status: skillsOk ? 'configured' : 'unverified',
    detail: skillsOk
      ? 'Skills not in the allowlist (the department\'s plus the agent\'s own) are disabled in the profile (read back via Hermes). Hermes always keeps its essential skill(s) enabled (hermes-agent). Allowed ids that are not installed in the profile are ignored.'
      : 'Not yet applied or not matching Hermes.',
  });

  entries.push({
    capability: 'mcp.tools',
    requested: inv.allowedMcpTools,
    effective: [],
    status: 'unverified',
    detail: 'Hermes supports enabling/disabling MCP tools ("server:tool"), but this installation has no MCP server to verify against, so nothing is applied and MCP access is not claimed to be restricted.',
  });

  const modelOk = o !== null && !diffs!.some((d) => d.includes('model'));
  entries.push({
    capability: 'models.default',
    requested: inv.model,
    effective: o ? { provider: o.provider, id: o.model } : null,
    status: !inv.model ? 'unverified' : modelOk ? 'configured' : 'unverified',
    detail: !inv.model
      ? 'No model chosen for the department or the agent: the profile keeps its own default model (not changed).'
      : 'Set through Hermes\' own model assignment, which checks the model against the provider\'s list, and read back.',
  });
  entries.push({
    capability: 'models.restriction',
    requested: inv.model,
    effective: null,
    status: 'unsupported',
    detail: 'Hermes has no setting that prevents an agent or task from selecting a different model (tasks accept model overrides), so the chosen model is a default, not a restriction.',
  });

  const instrOk = o !== null && o.instructionsPresent;
  entries.push({
    capability: 'instructions',
    requested: { sharedContextRefs: inv.sharedContextRefs },
    effective: instrOk ? 'department block present in SOUL.md' : null,
    status: instrOk ? 'configured' : 'unverified',
    detail: 'Department purpose, the team (teammate profiles), work rules and shared context references are written into a managed block of the profile\'s SOUL.md; the rest of the file is untouched. References only, not file contents.',
  });
  return entries.map(withGuarantee);
}

export function buildDepartmentWideReport(inv: Inventory, agentCount: number, globalCap: number | null | undefined): CapabilityEntry[] {
  const entries: Draft[] = [
    concurrencyEntry(agentCount, globalCap),
    {
      capability: 'files.isolation',
      requested: 'department-scoped files',
      effective: null,
      status: 'unsupported',
      detail: 'Verified: on the local backend an agent with file tools can read and write anywhere the Hermes process can, including other departments\' task folders. Disabling the file/terminal toolsets is the enforceable control.',
    },
    {
      capability: 'limits.maxDelegationDepth',
      requested: inv.limits.maxDelegationDepth,
      effective: null,
      status: 'unsupported',
      detail: 'Every agent keeps the kanban toolset (needed to report results) and can therefore create tasks. Agents are instructed to do handed-over tasks themselves (depth 1), but this is not enforced.',
    },
    {
      capability: 'limits.maxTaskRuntimeSeconds',
      requested: inv.limits.maxTaskRuntimeSeconds,
      effective: null,
      status: 'unverified',
      detail: 'Hermes supports max_runtime_seconds per task; it will be set when quests are created (Milestone 3) and has not been tested.',
    },
  ];
  return entries.map(withGuarantee);
}

/**
 * Hermes has ONE host-wide `kanban.max_in_progress_per_profile`. Every agent is its own profile, so each agent runs up
 * to that many tasks at once and the department runs up to agents x cap. There is no per-department setting.
 */
export function concurrencyEntry(agents: number, globalCap: number | null | undefined): Draft {
  return {
    capability: 'limits.concurrency',
    requested: { agents },
    effective: { agents, perAgentCap: globalCap ?? null, departmentMax: globalCap != null ? agents * globalCap : null },
    status: 'configured',
    detail: globalCap != null
      ? `Each of the ${agents} agent(s) is its own Hermes profile and runs at most ${globalCap} task(s) at once (kanban.max_in_progress_per_profile, host-wide, read at gateway start), so this department runs at most ${agents * globalCap} at once.`
      : `Each of the ${agents} agent(s) is its own Hermes profile. Hermes reports no per-profile cap (kanban.max_in_progress_per_profile unset), so an agent's tasks are not limited by Vibe City or Hermes.`,
  };
}
