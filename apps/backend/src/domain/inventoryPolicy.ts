import { createHash } from 'node:crypto';
import { AGENT_EXCLUDED_TOOLSETS, type CapabilityEntry, type Inventory } from '@vibe-city/shared';

type Draft = Omit<CapabilityEntry, 'guarantee'>;
/** A guarantee exists only where behavior was tested (status 'enforced'); everything else is explicitly not one. */
const withGuarantee = (e: Draft): CapabilityEntry => ({ ...e, guarantee: e.status === 'enforced' });
import type { Role } from './instructions.ts';

/** Always enabled: Hermes' Kanban lifecycle tools (complete/block/comment/create) are how any agent reports. */
export const REQUIRED_TOOLSETS = ['kanban'] as const;
/** Hermes pins these skills on ("cannot be disabled from any surface", agent/skill_utils.py ESSENTIAL_SKILLS). */
export const ESSENTIAL_SKILLS = ['hermes-agent'] as const;
/** Restrictions whose runtime effect was verified against real Hermes (HERMES_COMPATIBILITY.md section 3). */
export const BEHAVIOR_TESTED_TOOLSETS = ['terminal', 'file', 'web', 'browser', 'code_execution'] as const;

/**
 * Effective = the department allowance minus what no agent gets (delegation, cronjob), plus required toolsets.
 * Chief and worker get the same set: the chief does the work itself when there are no workers, and may still work
 * when there are.
 */
export function effectiveToolsets(_role: Role, inv: Inventory): string[] {
  const allowed = inv.allowedToolsets.filter((t) => !(AGENT_EXCLUDED_TOOLSETS as readonly string[]).includes(t));
  return [...new Set([...allowed, ...REQUIRED_TOOLSETS])].sort();
}

/** A worker profile exists only when the department asks for workers. */
export const hasWorkers = (inv: Inventory) => inv.limits.maxConcurrentWorkers > 0;

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

/** The model to make the profile default to; null when the department states no preference. */
export const preferredModel = (inv: Inventory, current: string | null): string | null => {
  if (!inv.allowedModelIds.length) return null;
  return current && inv.allowedModelIds.includes(current) ? current : inv.allowedModelIds[0]!;
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

/** What was last read back from a Hermes profile. */
export interface ObservedRole {
  profile: string;
  toolsets: Record<string, boolean>;
  enabledSkills: string[];
  installedSkills: string[];
  model: string | null;
  instructionsPresent: boolean;
}

export interface ObservedConfig {
  at: string;
  globalConcurrencyCap: number | null;
  chief: ObservedRole;
  /** Null when the department has no workers. */
  worker: ObservedRole | null;
}

/** Differences between what the inventory demands and what Hermes reports (empty = in sync). */
export function diffObserved(role: Role, inv: Inventory, o: ObservedRole): string[] {
  const diffs: string[] = [];
  const want = desiredToolsetMap(Object.keys(o.toolsets), effectiveToolsets(role, inv));
  for (const [t, on] of Object.entries(want)) if (o.toolsets[t] !== on) diffs.push(`toolset ${t} is ${o.toolsets[t] ? 'enabled' : 'disabled'}, expected ${on ? 'enabled' : 'disabled'}`);
  const wantSkills = effectiveSkills(inv, o.installedSkills);
  const have = [...o.enabledSkills].sort();
  if (JSON.stringify(wantSkills) !== JSON.stringify(have)) diffs.push('enabled skills differ from the inventory');
  if (inv.allowedModelIds.length && (!o.model || !inv.allowedModelIds.includes(o.model))) diffs.push('default model is outside the allowed models');
  if (!o.instructionsPresent) diffs.push('department instructions block is missing');
  return diffs;
}

/** Honest, per-capability report. `enforced` only where behavior was tested against real Hermes. */
export function buildRoleReport(role: Role, inv: Inventory, o: ObservedRole | null): CapabilityEntry[] {
  const entries: Draft[] = [];
  const effTools = effectiveToolsets(role, inv);
  const tested = new Set<string>(BEHAVIOR_TESTED_TOOLSETS);
  const diffs = o ? diffObserved(role, inv, o) : null;
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
      : 'Not yet applied or not matching Hermes; provision the department.',
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
      ? 'Skills not in the allowlist are disabled in the profile (read back via Hermes). Hermes always keeps its essential skill(s) enabled (hermes-agent). Allowed ids that are not installed in the profile are ignored.'
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
    requested: inv.allowedModelIds,
    effective: o?.model ?? null,
    status: inv.allowedModelIds.length === 0 ? 'unverified' : modelOk ? 'configured' : 'unverified',
    detail: inv.allowedModelIds.length === 0
      ? 'No allowed models listed: the profile keeps its own default model (not changed).'
      : 'The profile default model is set to an allowed model and read back. Whether the provider accepts it is not checked.',
  });
  entries.push({
    capability: 'models.restriction',
    requested: inv.allowedModelIds,
    effective: null,
    status: 'unsupported',
    detail: 'Hermes has no setting that prevents an agent or task from selecting a different model (tasks accept model overrides), so the allowlist is not enforced.',
  });

  const instrOk = o !== null && o.instructionsPresent;
  entries.push({
    capability: 'instructions',
    requested: { sharedContextRefs: inv.sharedContextRefs },
    effective: instrOk ? 'department block present in SOUL.md' : null,
    status: instrOk ? 'configured' : 'unverified',
    detail: 'Department purpose, role rules and shared context references are written into a managed block of the profile\'s SOUL.md; the rest of the file is untouched. References only, not file contents.',
  });
  return entries.map(withGuarantee);
}

export function buildDepartmentWideReport(inv: Inventory, globalCap: number | null | undefined): CapabilityEntry[] {
  const entries: Draft[] = [
    concurrencyEntry(inv.limits.maxConcurrentWorkers, globalCap),
    {
      capability: 'workspace.isolation',
      requested: 'configured workspace',
      effective: null,
      status: 'unsupported',
      detail: 'Verified: on the local backend an agent with file tools can write outside its workspace. Workspace paths are advisory. Disabling the file/terminal toolsets is the enforceable control.',
    },
    {
      capability: 'limits.maxDelegationDepth',
      requested: inv.limits.maxDelegationDepth,
      effective: null,
      status: 'unsupported',
      detail: 'Workers keep the kanban toolset (needed to report results) and can therefore create tasks. Depth 1 is instructed in the worker profile but not enforced.',
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
 * Hermes has ONE host-wide `kanban.max_in_progress_per_profile` (no per-profile or per-department map).
 * Because every department has its own worker profile, that cap bounds each department's worker.
 * So a requested limit is only backed by Hermes when it equals the cap; any other value is not enforceable.
 */
export function concurrencyEntry(requested: number, globalCap: number | null | undefined): Draft {
  if (requested === 0) {
    return {
      capability: 'limits.maxConcurrentWorkers',
      requested,
      effective: 0,
      status: 'configured',
      detail: 'No workers: no worker profile is provisioned and the chief is instructed to do the work itself. Nothing in Hermes stops the chief from assigning tasks to other profiles; such tasks are reported as violations.',
    };
  }
  const matches = globalCap != null && globalCap === requested;
  return {
    capability: 'limits.maxConcurrentWorkers',
    requested,
    effective: globalCap ?? null,
    status: matches ? 'configured' : 'unsupported',
    detail: matches
      ? `The requested limit equals Hermes' host-wide per-profile cap (kanban.max_in_progress_per_profile=${globalCap}), which bounds this department's worker profile. The cap is global, applies to every department, is read at gateway start, and was only exercised for value 1.`
      : `Hermes has only a host-wide per-profile cap (kanban.max_in_progress_per_profile, currently ${globalCap ?? 'unset/unlimited'}); there is no per-department setting, so the requested value is recorded but NOT enforced. Changing the cap affects all departments and needs a gateway restart.`,
  };
}
