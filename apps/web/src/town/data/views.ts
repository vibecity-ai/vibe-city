/* Pure view logic and user-facing copy for the city panels: what a backend DTO means in words, which actions are
   allowed, what a form change sends. No React, no I/O: tested in views.test.ts. The wording rules come from the spec:
   configured is never "guaranteed", a requested cancel is never "cancelled". */
import type {
  CancellationStatus, CapabilityEntry, Character, DepartmentUpdate, DepartmentView, ProvisioningError, ProvisioningStatus, SyncCheck, TaskNode,
} from '@vibe-city/shared';
import type { FieldIssue } from '../../api.ts';
import type { StatusKey } from '../ui/kit.tsx';

/* ---------- names ---------- */

/** What the user calls an agent: its persona name, else "Lead" / "Teammate 2". Never a seat key or profile id. */
export function agentLabel(key: string | null, ch?: Character | null): string {
  if (ch) return ch.name;
  if (!key) return 'Someone outside the floor';
  if (key === 'chief') return 'Lead';
  const n = Number(key.replace(/\D/g, ''));
  return n ? `Teammate ${n}` : 'Teammate';
}

export const SYNC_STEP_LABEL: Record<ProvisioningError['step'], string> = {
  health: 'Checking Hermes', validate: 'Checking the setup', board: 'Creating the board',
  agents: 'Creating the agent profiles', inventory: 'Applying the loadout', verify: 'Verifying',
};

/* ---------- department settings ---------- */

export const RESET_WARNING =
  'Changing the name, purpose, loadout or profiles takes the department out of sync with Hermes. ' +
  'Agents then get no new work until you sync again.';

export interface SettingsForm { name: string; purpose: string }

export const settingsFormFrom = (d: Pick<DepartmentView, 'name' | 'purpose'>): SettingsForm => ({ name: d.name, purpose: d.purpose });

/** The PATCH body for a settings form: only fields that changed. Null when nothing would change. */
export function settingsPatch(d: Pick<DepartmentView, 'name' | 'purpose'>, f: SettingsForm): DepartmentUpdate | null {
  const out: DepartmentUpdate = {};
  if (f.name.trim() !== d.name) out.name = f.name.trim();
  if (f.purpose.trim() !== d.purpose) out.purpose = f.purpose.trim();
  return Object.keys(out).length ? out : null;
}

/** Maps backend validation issues to form fields; anything unmapped is returned under `form`. */
export function fieldErrors(issues: FieldIssue[], fields: readonly string[], fallback?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const f = fields.find((x) => i.path === x || i.path.startsWith(`${x}.`)) ?? 'form';
    out[f] = out[f] ? `${out[f]}; ${i.message}` : i.message;
  }
  if (!issues.length && fallback) out.form = fallback;
  return out;
}

/** Attaches a plain backend error message to the name field when it is about the name, else to the form. */
export const settingsErrorField = (message: string) => (/name/i.test(message) ? 'name' : 'form');

/* ---------- archive ---------- */

export function archiveConsequences(d: Pick<DepartmentView, 'name' | 'hermesBoardRef' | 'agents'>): string[] {
  const profiles = d.agents.filter((a) => a.profileRef).length;
  const hermes = [d.hermesBoardRef && 'its board', profiles && `its ${profiles} agent profile${profiles === 1 ? '' : 's'}`].filter(Boolean);
  return [
    `“${d.name}” disappears from the active tower. The other floors close the gap.`,
    'Vibe City keeps the department record, its loadout and settings. You can still inspect it under Executive Office → Archived.',
    hermes.length
      ? `Nothing is deleted in Hermes: ${hermes.join(', ')} and every quest, result and attachment stay there.`
      : 'It was never synced, so it has no Hermes resources.',
    'This is not Hermes resource deletion, and there is no restore in this version. Running Hermes tasks are not stopped: cancel active quests first.',
  ];
}

export const archivedNotice = (name: string, retained: boolean) =>
  retained ? `Archived “${name}”. Its Hermes board and profiles were kept; delete them in Hermes if you no longer need them.` : `Archived “${name}”.`;

/* ---------- inventory ---------- */

export const LIMIT_COPY = {
  teammates: 'Every agent is its own Hermes profile, so teammates work in parallel. Each runs up to Hermes\' host-wide per-profile cap at once.',
  maxTaskRuntimeSeconds: 'Applies to the quest task the lead receives. It does not propagate automatically to the tasks the lead hands to teammates.',
  maxDelegationDepth: 'Fixed at 1: agents are told to do handed-over tasks themselves. Hermes cannot enforce it.',
} as const;

/** What to tell the user after an inventory save, based on the sync state before and after. */
export function inventorySavedNotice(before: ProvisioningStatus['state'] | undefined, after: ProvisioningStatus['state'] | undefined): { text: string; tone: 'good' | 'warn' } {
  if (after === 'unconfigured' && before && before !== 'unconfigured' && before !== 'provisioning') {
    return { text: 'Loadout saved. Sync the department so Hermes uses it.', tone: 'warn' };
  }
  if (after === 'unconfigured') return { text: 'Loadout saved. It is applied when you sync the department.', tone: 'good' };
  return { text: 'Loadout saved.', tone: 'good' };
}

/** Only an enforced entry with the backend's guarantee flag gets lock styling. */
export const isGuaranteed = (e: Pick<CapabilityEntry, 'status' | 'guarantee'>) => e.status === 'enforced' && e.guarantee;

export const CAP_STATUS_LABEL: Record<CapabilityEntry['status'], string> = {
  enforced: 'Enforced', configured: 'Configured, not tested', unverified: 'Unverified', unsupported: 'Not supported by Hermes',
};

/** Compact, safe rendering of a capability's requested/effective value. */
export function capValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.length ? v.map((x) => capValue(x)).join(', ') : 'none';
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${capValue(x)}`).join('; ');
  return String(v);
}

/* ---------- sync with Hermes ---------- */

/**
 * Whether the Sync button shows, and what to say. Sync is offered only when the floor is not in sync: never synced,
 * edited since, failed, unverified, or a Refresh (check) found Hermes different.
 */
export function syncView(p: Pick<ProvisioningStatus, 'state' | 'error'> | null, check: Pick<SyncCheck, 'inSync'> | null): { sync: boolean; hint: string | null } {
  if (!p) return { sync: false, hint: null };
  switch (p.state) {
    case 'provisioning': return { sync: true, hint: 'Syncing with Hermes…' };
    case 'unconfigured': return { sync: true, hint: 'Hermes does not have this floor yet, or it changed since the last sync.' };
    case 'disconnected': return { sync: true, hint: 'Hermes could not be reached to verify this floor. Sync once it is running.' };
    case 'error': return { sync: true, hint: p.error?.retryable ? 'The last sync failed. You can try again.' : 'The last sync failed: change the configuration first, then sync.' };
    case 'ready': return check && !check.inSync ? { sync: true, hint: 'Hermes does not match this floor.' } : { sync: false, hint: check ? 'Checked just now: Hermes matches this floor.' : null };
  }
}

export const PROVISIONING_STATE_LABEL: Record<ProvisioningStatus['state'], string> = {
  unconfigured: 'Not synced', provisioning: 'Syncing', ready: 'In sync', error: 'Sync failed', disconnected: 'Not verified (Hermes unreachable)',
};

/* ---------- quest tasks ---------- */

/** Task status in words. Pending, blocked and review are never shown as running; failure is distinct from blocked. */
export function taskStatusView(t: Pick<TaskNode, 'status' | 'failed'>): { k: StatusKey; label: string } {
  if (t.failed) return { k: 'failed', label: 'Failed' };
  switch (t.status) {
    case 'running': return { k: 'running', label: 'Running' };
    case 'done': return { k: 'completed', label: 'Done' };
    case 'blocked': return { k: 'blocked', label: 'Blocked · needs input' };
    case 'review': return { k: 'blocked', label: 'In review' };
    case 'archived': return { k: 'disconnected', label: 'Archived' };
    default: return { k: 'todo', label: `Pending (${t.status})` };
  }
}

export function assigneeWarning(t: Pick<TaskNode, 'agentKey' | 'assignee'>): string | null {
  if (t.agentKey !== null) return null;
  return t.assignee ? 'Assigned to an agent outside this department. Detected, not prevented.' : 'Not assigned to any of this department’s agents yet.';
}

export const RUN_STATE_LABEL: Record<TaskNode['runs'][number]['state'], string> = {
  queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', unknown: 'Unknown',
};

/* ---------- cancellation ---------- */

export interface CancellationView {
  headline: string;
  tone: 'warn' | 'good';
  remaining: { id: string; title: string; status: string }[];
  archived: { id: string; title: string }[];
  finished: { id: string; title: string }[];
}

export const CANCEL_CONFIRM = [
  'Unfinished tasks are archived in Hermes. Archived tasks cannot be dispatched again: to redo the work, create a new quest.',
  'Tasks that already finished are left untouched; their summaries and files stay available.',
  'A task that is running right now may take a moment to stop. The quest shows “Cancelled” only after Hermes confirms nothing is active.',
];

export function cancellationView(c: CancellationStatus, tasks: Pick<TaskNode, 'id' | 'title'>[]): CancellationView | null {
  if (c.state === 'none') return null;
  const title = (id: string) => tasks.find((t) => t.id === id)?.title ?? id;
  return {
    headline: c.state === 'confirmed'
      ? 'Cancellation confirmed: Hermes reports no active task.'
      : `Cancellation requested, not confirmed yet: ${c.remaining.length} task${c.remaining.length === 1 ? '' : 's'} still stopping.`,
    tone: c.state === 'confirmed' ? 'good' : 'warn',
    remaining: c.remaining.map((r) => ({ id: r.taskId, title: title(r.taskId), status: r.status })),
    archived: c.archivedTaskIds.map((id) => ({ id, title: title(id) })),
    finished: c.alreadyFinishedTaskIds.map((id) => ({ id, title: title(id) })),
  };
}

/** A newer status never goes back from confirmed to requested (a stale response must not undo a confirmation). */
export function newerCancellation(prev: CancellationStatus | null | undefined, next: CancellationStatus): CancellationStatus {
  if (prev?.state === 'confirmed' && next.state !== 'confirmed') return prev;
  return next;
}
