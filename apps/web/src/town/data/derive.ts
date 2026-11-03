/* Pure derivation of the city's view model from backend DTOs. No I/O, no clock: tested in derive.test.ts. */
import type { DepartmentView, ProvisioningStatus, QuestDetail, QuestSummary, TaskNode } from '@vibe-city/shared';
import type { AgentStatus, Chief, Dept, DeptState, Worker } from './types.ts';

/** Desks in the office renderer (world/interior.ts DESKS). Tasks beyond this are counted but not drawn. */
export const MAX_DESKS = 6;

export const SHIRTS = ['#9B5CFF', '#FF7A6B', '#2EB8F0', '#7CF5B4', '#FFB547', '#FF3EA5'];
const THEMES = [
  { floor: '#173a5a', accent: '#2EE6F0' }, { floor: '#1b3046', accent: '#2EE6F0' }, { floor: '#17304a', accent: '#2EE6F0' },
  { floor: '#2a2146', accent: '#FFB547' }, { floor: '#262044', accent: '#B3ACDD' }, { floor: '#2c1834', accent: '#FF5C7A' },
];
export const themeFor = (floorOrder: number) => THEMES[Math.abs(floorOrder) % THEMES.length]!;

/** Quests whose work is still in flight (their task trees are fetched and drawn on the floor). */
export const LIVE_QUEST = new Set(['queued', 'planning', 'running', 'awaiting_input', 'in_review', 'failed', 'cancelling']);
export const isLiveQuest = (q: Pick<QuestSummary, 'status'>) => LIVE_QUEST.has(q.status);

export function workerStatus(t: Pick<TaskNode, 'status' | 'failed'>): AgentStatus {
  if (t.failed) return 'failed';
  switch (t.status) {
    case 'running': return 'running';
    case 'done': return 'completed';
    default: return 'idle'; // pending, blocked on input, in review: nobody is working on it right now
  }
}

const PRIORITY: Record<AgentStatus, number> = { running: 0, failed: 1, idle: 2, awaiting: 2, completed: 3, disconnected: 4 };

/**
 * Keeps a task on the same desk for as long as it stays in view. New tasks take the lowest free desk;
 * tasks that left view free theirs. Returns task id -> desk index (0-based).
 */
export function assignSlots(prev: ReadonlyMap<string, number>, tasks: { id: string; status: AgentStatus }[], max = MAX_DESKS): Map<string, number> {
  const next = new Map<string, number>();
  const used = new Set<number>();
  const ranked = [...tasks].sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status]);
  for (const t of ranked) {
    const p = prev.get(t.id);
    if (p !== undefined && p < max && !used.has(p)) { next.set(t.id, p); used.add(p); }
  }
  for (const t of ranked) {
    if (next.has(t.id)) continue;
    let i = 0;
    while (i < max && used.has(i)) i++;
    if (i >= max) break;
    next.set(t.id, i); used.add(i);
  }
  return next;
}

export const slotLabel = (i: number) => `W-${String(i + 1).padStart(2, '0')}`;

const hhmm = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
export const clock = hhmm;

export interface DeriveInput {
  dept: DepartmentView;
  provisioning: ProvisioningStatus | null;
  /** Details of the department's live quests only. */
  liveQuests: QuestDetail[];
  maxWorkers: number;
  chiefModel: string | null;
  /** Previous task -> desk map (kept so agents do not hop between desks). */
  slots: ReadonlyMap<string, number>;
  hermesUp: boolean;
}

export interface Derived { dept: Dept; slots: Map<string, number> }

export function deriveDept(i: DeriveInput): Derived {
  const { dept: v, provisioning: prov, liveQuests: quests } = i;
  const ready = v.state === 'ready';
  const disconnected = v.state === 'disconnected' || (ready && !i.hermesUp);

  const workerTasks = quests.flatMap((q) => q.tasks.filter((t) => t.role === 'worker' && t.status !== 'archived').map((t) => ({ q, t })));
  const cand = workerTasks.map(({ t }) => ({ id: t.id, status: workerStatus(t) }));
  const slots = ready ? assignSlots(i.slots, cand) : new Map<string, number>();

  const workers: Worker[] = workerTasks
    .filter(({ t }) => slots.has(t.id))
    .map(({ t }): Worker => {
      const idx = slots.get(t.id)!;
      return {
        id: slotLabel(idx), taskId: t.id, task: t.title,
        status: disconnected ? 'disconnected' : workerStatus(t),
        since: hhmm(t.status === 'done' ? t.completedAt : t.startedAt ?? t.createdAt),
        shirt: SHIRTS[idx % SHIRTS.length]!,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const chiefTasks = quests.flatMap((q) => q.tasks.filter((t) => t.role === 'chief').map((t) => ({ q, t })));
  const runningChief = chiefTasks.find(({ t }) => t.status === 'running');
  const failedChief = chiefTasks.find(({ t }) => t.failed);
  let chief: Chief | null = null;
  if (ready || v.state === 'disconnected') {
    const base = { name: `${v.name} Chief`, profile: v.chiefProfileRef ?? '', model: i.chiefModel };
    if (disconnected) chief = { ...base, status: 'disconnected', activity: 'Hermes is not reachable', since: hhmm(v.updatedAt) };
    else if (runningChief) {
      const q = runningChief.q;
      chief = { ...base, status: 'running', activity: `${q.status === 'planning' ? 'Planning' : 'Working on'} “${q.title}”`, since: hhmm(runningChief.t.startedAt) };
    } else if (failedChief) chief = { ...base, status: 'failed', activity: `Failed on “${failedChief.q.title}”`, since: hhmm(failedChief.t.startedAt) };
    else if (quests.some((q) => q.flags.planningComplete && q.status !== 'cancelling')) {
      const q = quests.find((x) => x.flags.planningComplete)!;
      chief = { ...base, status: 'idle', activity: `Planning finished · “${q.title}”`, since: hhmm(q.tasks.find((t) => t.role === 'chief')?.completedAt ?? null) };
    } else chief = { ...base, status: 'idle', activity: quests.length ? `Queued: “${quests[0]!.title}”` : 'Waiting for a quest', since: hhmm(v.updatedAt) };
  }

  let state: DeptState;
  let attention: string | undefined;
  if (v.state === 'unconfigured' || v.state === 'provisioning') state = 'unconfigured';
  else if (v.state === 'error') { state = 'attention'; attention = prov?.error?.message ?? 'Provisioning failed'; }
  else if (disconnected) { state = 'offline'; attention = i.hermesUp ? 'Hermes resources could not be verified' : 'Hermes is not reachable'; }
  else if (workers.some((w) => w.status === 'failed') || chief?.status === 'failed') {
    state = 'attention';
    const w = workers.find((x) => x.status === 'failed');
    attention = w ? `Task failed: ${w.task}` : chief?.activity;
  } else if (chief?.status === 'running' || workers.some((w) => w.status === 'running')) state = 'active';
  else state = 'idle';

  const dept: Dept = {
    id: v.id, name: v.name, purpose: v.purpose, state, provisioning: v.state, chief, workers,
    maxWorkers: i.maxWorkers, theme: themeFor(v.floorOrder), workspace: v.workspace, chiefProfileRef: v.chiefProfileRef, workerProfileRef: v.workerProfileRef, attention, view: v,
  };
  return { dept, slots };
}
