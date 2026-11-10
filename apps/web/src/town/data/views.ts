/* Pure view logic and user-facing copy for the city panels: what a backend DTO means in words, which actions are
   allowed, what a form change sends. No React, no I/O: tested in views.test.ts. The wording rules come from the spec:
   configured is never "guaranteed", a requested cancel is never "cancelled". */
import type {
  CancellationStatus, Character, DepartmentUpdate, DepartmentView, ProvisioningError, ProvisioningStatus, SyncCheck, TaskNode,
} from '@vibe-city/shared';
import { ENV_NAME_RE, QUEST_FILE_MAX_BYTES, QUEST_FILES_MAX, isReservedEnvName } from '@vibe-city/shared';
import type { FieldIssue } from '../../api.ts';
import type { Said } from './types.ts';
import type { StatusKey } from '../ui/kit.tsx';

/* ---------- names ---------- */

/** Agents report teammates by their Hermes profile id (vc-0e8bd7b1c040-w01); the dialogue says their names instead. */
export function nameProfiles(text: string, agents: readonly { key: string; profileRef: string | null }[], label: (key: string) => string): string {
  let out = text;
  for (const a of [...agents].sort((x, y) => (y.profileRef?.length ?? 0) - (x.profileRef?.length ?? 0))) if (a.profileRef) out = out.split(a.profileRef).join(label(a.key));
  return out;
}

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
  'Changing the name, purpose, loadout or profiles takes the floor out of sync with Hermes. ' +
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
    'Vibe City keeps the floor record, its loadout and settings.',
    hermes.length
      ? `Nothing is deleted in Hermes: ${hermes.join(', ')} and every job, result and attachment stay there.`
      : 'It was never synced, so it has no Hermes resources.',
    'This is not Hermes resource deletion, and there is no restore in this version. Running Hermes tasks are not stopped: cancel active jobs first.',
  ];
}

export const archivedNotice = (name: string, retained: boolean) =>
  retained ? `Archived “${name}”. Its Hermes board and profiles were kept; delete them in Hermes if you no longer need them.` : `Archived “${name}”.`;

/* ---------- inventory ---------- */

export const LIMIT_COPY = {
  teammates: 'Every agent is its own Hermes profile, so teammates work in parallel. Each runs up to Hermes\' host-wide per-profile cap at once.',
  maxTaskRuntimeSeconds: 'Applies to the job task the lead receives. It does not propagate automatically to the tasks the lead hands to teammates.',
  maxDelegationDepth: 'Fixed at 1: agents are told to do handed-over tasks themselves. Hermes cannot enforce it.',
} as const;

/** What to tell the user after an inventory save, based on the sync state before and after. */
export function inventorySavedNotice(before: ProvisioningStatus['state'] | undefined, after: ProvisioningStatus['state'] | undefined): { text: string; tone: 'good' | 'warn' } {
  if (after === 'unconfigured' && before && before !== 'unconfigured' && before !== 'provisioning') {
    return { text: 'Loadout saved. Sync the floor so Hermes uses it.', tone: 'warn' };
  }
  if (after === 'unconfigured') return { text: 'Loadout saved. It is applied when you sync the floor.', tone: 'good' };
  return { text: 'Loadout saved.', tone: 'good' };
}

/** Only an enforced entry with the backend's guarantee flag gets lock styling. */
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
  return t.assignee ? 'Assigned to an agent outside this floor. Detected, not prevented.' : 'Not assigned to any of this floor’s agents yet.';
}

/* ---------- cancellation ---------- */

export interface CancellationView {
  headline: string;
  tone: 'warn' | 'good';
  remaining: { id: string; title: string; status: string }[];
  archived: { id: string; title: string }[];
  finished: { id: string; title: string }[];
}

export const CANCEL_CONFIRM = [
  'Unfinished tasks are archived in Hermes. Archived tasks cannot be dispatched again: to redo the work, create a new job.',
  'Tasks that already finished are left untouched; their summaries and files stay available.',
  'A task that is running right now may take a moment to stop. The job shows “Cancelled” only after Hermes confirms nothing is active.',
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

/** Reference files for a job: accepts what fits Hermes' limits and says why the rest did not (same name twice: kept once). */
export function pickFiles<F extends { name: string; size: number }>(have: F[], picked: F[]): { files: F[]; error: string | null } {
  const files = [...have];
  const refused: string[] = [];
  for (const f of picked) {
    if (files.some((x) => x.name === f.name)) continue;
    if (f.size === 0) refused.push(`"${f.name}" is empty`);
    else if (f.size > QUEST_FILE_MAX_BYTES) refused.push(`"${f.name}" is over 25 MB`);
    else if (files.length >= QUEST_FILES_MAX) refused.push(`a job takes at most ${QUEST_FILES_MAX} files`);
    else files.push(f);
  }
  return { files, error: refused.length ? `${[...new Set(refused)].join('; ')}.` : null };
}

/** A floor env variable's name: why it cannot be used, or null (empty is not a problem yet). */
export function envNameProblem(name: string): string | null {
  if (!name) return null;
  if (!ENV_NAME_RE.test(name)) return 'Use capitals, digits and _ (starting with a capital), 2 to 64 characters.';
  if (isReservedEnvName(name)) return 'Vibe City or Hermes sets this one itself.';
  return null;
}

const clip = (x: string, n: number) => (x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x);
const firstSentence = (x: string) => clip((x.split(/(?<=[.!?])\s|\n/)[0] ?? x).trim(), 70);

/**
 * What an agent says over its head, in a few words, or null for nothing to say. Its own progress note while it is
 * fresh (agents are told to post one every few steps), else what it is on; a short recap for a few minutes after it
 * finishes; a nudge when it waits on the CEO or is stuck.
 */
/** How an agent signs off when the CEO ends a chat: back to the task they are on, or a friendly goodbye. */
export function farewellLine(o: { lead: boolean; task: string | null; n: number }): string {
  if (o.task) return [`Alright, back to “${clip(o.task, 40)}”. Shout if you need me!`, `Got it. Back to “${clip(o.task, 40)}” then. Talk soon, boss!`][Math.abs(Math.floor(o.n)) % 2]!;
  if (o.lead) return 'Understood. I’ll keep the floor moving. Talk soon, boss!';
  return ['Anytime, boss. See you around!', 'Talk soon! I’ll be at my desk.'][Math.abs(Math.floor(o.n)) % 2]!;
}

/** What an agent says when the CEO clicks them: a short hello, picked by a number so it varies between clicks. */
export const GREETINGS = ['Hey boss!', 'Hi! Need me?', 'Oh, hello!', 'Hey, CEO!', 'At your service!', 'Hi there!'] as const;
export const greetingLine = (n: number) => GREETINGS[Math.abs(Math.floor(n)) % GREETINGS.length]!;

/** The lead handing a task to a teammate at their desk: what each says. */
export function handoffLines(title: string | null, n: number): { lead: string; mate: string } {
  const replies = ['On it!', 'Sure, leave it to me.', 'Got it!', 'Starting now.'];
  return { lead: title ? `Can you take “${clip(title, 34)}”?` : 'Got a task for you.', mate: replies[Math.abs(Math.floor(n)) % replies.length]! };
}

export function bubbleText(s: Said | null | undefined, now: number): string | null {
  if (!s) return null;
  const within = (iso: string | null, minutes: number) => !!iso && now - Date.parse(iso) < minutes * 60_000;
  switch (s.state) {
    case 'running': return s.note && within(s.note.at, 20) ? s.note.text : `On “${clip(s.title, 44)}”`;
    case 'input': return `Waiting on you: “${clip(s.title, 36)}”`;
    case 'stuck': return `Stuck on “${clip(s.title, 40)}”`;
    case 'done': {
      if (!within(s.doneAt, 5)) return null;
      // a summary worth reading, not just "Done."
      const line = s.summary ? firstSentence(s.summary) : '';
      return line && !/^(done|completed?|finished)$/i.test(line.replace(/[.!]+$/, '')) ? `Done! ${line}` : `Done with “${clip(s.title, 40)}”`;
    }
    default: return null;
  }
}
