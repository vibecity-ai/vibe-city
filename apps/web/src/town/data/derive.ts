/* Pure derivation of the city's view model from backend DTOs. No I/O, no clock: tested in derive.test.ts. */
import type { DepartmentView, ProvisioningStatus, QuestDetail, QuestSummary, TaskNode } from '@vibe-city/shared';
import type { AgentStatus, Chief, Dept, DeptState, Worker } from './types.ts';

/** Desks in the office renderer (world/interior.ts DESKS). Teammates beyond this are counted but not drawn. */
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

/** Which of an agent's tasks the floor shows: what it is doing now, else what failed, else what is next, else the last done. */
const PRIORITY: Record<AgentStatus, number> = { running: 0, failed: 1, idle: 2, awaiting: 2, completed: 3, disconnected: 4 };

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
  chiefModel: string | null;
  hermesUp: boolean;
}

type Seen = { q: QuestDetail; t: TaskNode };

/** The task an agent is shown with, among the live quests' tasks assigned to it. */
function current(tasks: Seen[]): Seen | null {
  const by = (x: Seen) => x.t.completedAt ?? x.t.startedAt ?? x.t.createdAt ?? '';
  return [...tasks].sort((a, b) => PRIORITY[workerStatus(a.t)] - PRIORITY[workerStatus(b.t)] || by(b).localeCompare(by(a)))[0] ?? null;
}

export function deriveDept(i: DeriveInput): Dept {
  const { dept: v, provisioning: prov, liveQuests: quests } = i;
  const ready = v.state === 'ready';
  // Synced before (the lead has a profile): unsynced edits or a re-sync keep the floor and its agents on screen.
  const staffed = ready || v.state === 'disconnected' || (!!v.agents.find((a) => a.lead)?.profileRef && (v.state === 'unconfigured' || v.state === 'provisioning'));
  const disconnected = v.state === 'disconnected' || (ready && !i.hermesUp);
  const tasksOf = (key: string): Seen[] => quests.flatMap((q) => q.tasks.filter((t) => t.agentKey === key && t.status !== 'archived').map((t) => ({ q, t })));

  // Every teammate is a real Hermes profile with its own desk, busy or not.
  const workers: Worker[] = (staffed ? v.agents.filter((a) => !a.lead) : []).slice(0, MAX_DESKS).map((a, idx): Worker => {
    const c = current(tasksOf(a.key));
    const t = c?.t;
    return {
      id: a.key, profile: a.profileRef, taskId: t?.id ?? null, task: t?.title ?? '',
      status: disconnected ? 'disconnected' : t ? workerStatus(t) : 'idle',
      since: t ? hhmm(t.status === 'done' ? t.completedAt : t.startedAt ?? t.createdAt) : hhmm(a.createdAt),
      shirt: SHIRTS[idx % SHIRTS.length]!,
      ...(a.title ? { title: a.title } : {}),
    };
  });

  const chiefTasks = tasksOf('chief');
  const runningChief = chiefTasks.find(({ t }) => t.status === 'running');
  const failedChief = chiefTasks.find(({ t }) => t.failed);
  const lead = v.agents.find((a) => a.lead);
  let chief: Chief | null = null;
  if (staffed) {
    const base = { name: `${v.name} Lead`, profile: lead?.profileRef ?? '', model: i.chiefModel, ...(lead?.title ? { title: lead.title } : {}) };
    if (disconnected) chief = { ...base, status: 'disconnected', activity: 'Hermes is not reachable', since: hhmm(v.updatedAt) };
    else if (runningChief) {
      const q = runningChief.q;
      chief = { ...base, status: 'running', activity: `${q.status === 'planning' ? 'Planning' : 'Working on'} “${q.title}”`, since: hhmm(runningChief.t.startedAt) };
    } else if (failedChief) chief = { ...base, status: 'failed', activity: `Failed on “${failedChief.q.title}”`, since: hhmm(failedChief.t.startedAt) };
    else if (quests.some((q) => q.flags.planningComplete && q.status !== 'cancelling')) {
      const q = quests.find((x) => x.flags.planningComplete)!;
      chief = { ...base, status: 'idle', activity: `Planning finished · “${q.title}”`, since: hhmm(q.tasks.find((t) => t.depth === 0)?.completedAt ?? null) };
    } else chief = { ...base, status: 'idle', activity: quests.length ? `Queued: “${quests[0]!.title}”` : 'Waiting for a quest', since: hhmm(v.updatedAt) };
  }

  let state: DeptState;
  let attention: string | undefined;
  if (v.state === 'unconfigured' || v.state === 'provisioning') state = 'unconfigured';
  else if (v.state === 'error') { state = 'attention'; attention = prov?.error?.message ?? 'Sync with Hermes failed'; }
  else if (disconnected) { state = 'offline'; attention = i.hermesUp ? 'Hermes resources could not be verified' : 'Hermes is not reachable'; }
  else if (workers.some((w) => w.status === 'failed') || chief?.status === 'failed') {
    state = 'attention';
    const w = workers.find((x) => x.status === 'failed');
    attention = w ? `Task failed: ${w.task}` : chief?.activity;
  } else if (chief?.status === 'running' || workers.some((w) => w.status === 'running')) state = 'active';
  else state = 'idle';

  return {
    id: v.id, name: v.name, purpose: v.purpose, state, provisioning: v.state, chief, workers, teamSize: v.agents.length,
    theme: themeFor(v.floorOrder), attention, view: v,
  };
}
