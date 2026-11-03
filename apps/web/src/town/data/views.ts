/* Pure view logic and user-facing copy for the city panels: what a backend DTO means in words, which actions are
   allowed, what a form change sends. No React, no I/O: tested in views.test.ts. The wording rules come from the spec:
   configured is never "guaranteed", a workspace is never "isolated", a requested cancel is never "cancelled". */
import type {
  CancellationStatus, CapabilityEntry, DepartmentUpdate, DepartmentView, ProfilesView, ProvisioningStatus, TaskNode, WorkspaceView,
} from '@vibe-city/shared';
import type { FieldIssue } from '../../api.ts';
import type { StatusKey } from '../ui/kit.tsx';

/* ---------- department settings ---------- */

export const WORKSPACE_ADVISORY =
  'Advisory only. The path is stored on the server and never sent back to the browser; afterwards only its last folder name is shown. ' +
  'It is a configured working directory, not a sandbox: agents with file or terminal tools can still reach outside it.';

export const RESET_WARNING =
  'Changing the name, purpose, workspace, inventory or profiles can return a provisioned department to “Not provisioned”. ' +
  'Agents then get no new work until you provision again.';

export function workspaceSummary(w: WorkspaceView): { label: string; isolation: string } {
  return {
    label: w.configured ? w.label ?? 'configured' : 'Not configured',
    // `verified` is in the contract but nothing sets it yet; still, never claim more than the backend says.
    isolation: w.isolation === 'verified' ? 'Isolation verified by the backend.' : 'Isolation unverified: not a sandbox.',
  };
}

export type WorkspaceMode = 'keep' | 'set' | 'clear';
export interface SettingsForm { name: string; purpose: string; workspaceMode: WorkspaceMode; workspacePath: string }

export const settingsFormFrom = (d: Pick<DepartmentView, 'name' | 'purpose'>): SettingsForm => ({ name: d.name, purpose: d.purpose, workspaceMode: 'keep', workspacePath: '' });

/** The PATCH body for a settings form: only fields that changed. Null when nothing would change. */
export function settingsPatch(d: Pick<DepartmentView, 'name' | 'purpose' | 'workspace'>, f: SettingsForm): DepartmentUpdate | null {
  const out: DepartmentUpdate = {};
  if (f.name.trim() !== d.name) out.name = f.name.trim();
  if (f.purpose.trim() !== d.purpose) out.purpose = f.purpose.trim();
  if (f.workspaceMode === 'set') out.workspace = f.workspacePath.trim();
  if (f.workspaceMode === 'clear' && d.workspace.configured) out.workspace = null;
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

/** Workspace errors from the backend are plain messages (never the path); attach them to the workspace field. */
export const workspaceErrorField = (message: string) => (/workspace/i.test(message) ? 'workspace' : /name/i.test(message) ? 'name' : 'form');

/* ---------- archive ---------- */

export function archiveConsequences(d: Pick<DepartmentView, 'name' | 'hermesBoardRef' | 'chiefProfileRef' | 'workerProfileRef'>): string[] {
  const hermes = [d.hermesBoardRef && `board ${d.hermesBoardRef}`, d.chiefProfileRef && `profile ${d.chiefProfileRef}`, d.workerProfileRef && `profile ${d.workerProfileRef}`].filter(Boolean);
  return [
    `“${d.name}” disappears from the active tower. The other floors close the gap.`,
    'Vibe City keeps the department record, its inventory and settings. You can still inspect it under Executive Office → Archived.',
    hermes.length
      ? `Nothing is deleted in Hermes: ${hermes.join(', ')} and every quest, result and attachment stay there.`
      : 'It was never provisioned, so it has no Hermes resources.',
    'This is not Hermes resource deletion, and there is no restore in this version. Running Hermes tasks are not stopped: cancel active quests first.',
  ];
}

export const archivedNotice = (name: string, retained: boolean) =>
  retained ? `Archived “${name}”. Its Hermes board and profiles were kept; delete them in Hermes if you no longer need them.` : `Archived “${name}”.`;

/* ---------- inventory ---------- */

export const LIMIT_COPY = {
  maxConcurrentWorkers: 'Requested, host-limited. Hermes only has a host-wide per-profile cap, so this is not guaranteed per department.',
  maxTaskRuntimeSeconds: 'Applies to the quest task the chief receives. It does not propagate automatically to the tasks the chief creates for workers.',
  maxDelegationDepth: 'Fixed at 1 and instructed to the chief. Hermes cannot enforce it.',
  sharedContextRefs: 'References written into the agents’ instructions (SOUL.md block). Agents are told about them; access is not granted or checked.',
} as const;

/** What to tell the user after an inventory save, based on the provisioning state before and after. */
export function inventorySavedNotice(before: ProvisioningStatus['state'] | undefined, after: ProvisioningStatus['state'] | undefined): { text: string; tone: 'good' | 'warn' } {
  if (after === 'unconfigured' && before && before !== 'unconfigured' && before !== 'provisioning') {
    return { text: 'Inventory saved. The department needs provisioning again before Hermes uses it.', tone: 'warn' };
  }
  if (after === 'unconfigured') return { text: 'Inventory saved. It is applied when you provision the department.', tone: 'good' };
  return { text: 'Inventory saved.', tone: 'good' };
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

/* ---------- provisioning ---------- */

export interface ProvisioningActions {
  provision: { show: boolean; label: string };
  /** Retry is offered only where the backend accepts it AND it can help: a retryable error or a disconnect. */
  retry: boolean;
  hint: string | null;
}

export function provisioningActions(p: Pick<ProvisioningStatus, 'state' | 'error'> | null): ProvisioningActions {
  if (!p) return { provision: { show: false, label: 'Provision' }, retry: false, hint: null };
  switch (p.state) {
    case 'provisioning': return { provision: { show: false, label: 'Provision' }, retry: false, hint: 'Provisioning is running.' };
    case 'unconfigured': return { provision: { show: true, label: 'Provision' }, retry: false, hint: null };
    case 'ready': return { provision: { show: true, label: 'Provision again' }, retry: false, hint: 'Already verified. Provisioning again re-applies and re-verifies everything.' };
    case 'disconnected': return { provision: { show: false, label: 'Provision' }, retry: true, hint: 'Hermes resources could not be verified. Retry once Hermes is reachable.' };
    case 'error':
      return p.error?.retryable
        ? { provision: { show: false, label: 'Provision' }, retry: true, hint: 'This failure can be retried.' }
        : { provision: { show: true, label: 'Provision again' }, retry: false, hint: 'Retrying alone will not help: change the configuration first, then provision again.' };
  }
}

export const PROVISIONING_STATE_LABEL: Record<ProvisioningStatus['state'], string> = {
  unconfigured: 'Not provisioned', provisioning: 'Provisioning', ready: 'Ready (verified)', error: 'Provisioning failed', disconnected: 'Not verified (disconnected)',
};

type Resource = ProvisioningStatus['chief'];
export function originText(r: Resource): string {
  if (!r.origin) return r.ref ? 'Not created yet' : 'Will be created and managed by Vibe City';
  if (r.origin === 'created') return 'Managed: created by Vibe City (no consent needed)';
  if (r.modificationConfirmed) return 'Associated existing profile · you allowed Vibe City to modify it';
  return 'Associated existing profile · modification NOT confirmed: provisioning stops before changing it';
}

export interface ProfileRow { role: 'chief' | 'worker'; ref: string; exists: string; model: string; description: string; origin: string; verified: string }

export function profileRows(profiles: ProfilesView | null, prov: ProvisioningStatus | null, at: (iso: string | null) => string): ProfileRow[] {
  return (['chief', 'worker'] as const).map((role) => {
    const p = profiles?.[role];
    const r = prov?.[role];
    const exists = !profiles ? 'Not loaded' : !profiles.reachable ? 'Unknown (Hermes unreachable)' : p?.exists === null ? '—' : p?.exists ? 'Exists in Hermes' : 'Missing in Hermes';
    return {
      role,
      ref: p?.ref ?? r?.ref ?? '(managed, not created yet)',
      exists,
      model: p?.model ?? '—',
      description: p?.description ?? '—',
      origin: r ? originText(r) : '—',
      verified: r ? (r.verified ? `Verified ${at(r.verifiedAt)}` : 'Not verified') : '—',
    };
  });
}

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

export function assigneeWarning(t: Pick<TaskNode, 'role' | 'assignee'>): string | null {
  if (t.role !== 'other') return null;
  return `Assigned to ${t.assignee ? `“${t.assignee}”` : 'nobody'}, which is not this department’s chief or worker. Detected, not prevented.`;
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
