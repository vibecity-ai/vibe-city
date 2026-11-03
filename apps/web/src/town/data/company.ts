/* The company quest board: the player's one board. It is a view over the department boards, which belong to the
   agents (each quest is still a root task on its department's Hermes board, assigned to that department's chief).
   Pure rules only, so they are testable without a browser:
   - a department whose quests could not be loaded is reported as missing, never shown as "no quests";
   - only ready departments can receive a quest; a stopped gateway is a warning (the quest queues), not a block. */
import type { QuestStatus } from '@vibe-city/shared';
import type { Dept } from './types.ts';
import type { QuestItem } from '../store.ts';

/** Per department: how much of its quest list the browser actually has. */
export type QuestSync = 'ok' | 'out_of_date' | 'not_loaded' | 'no_board';

export type ColumnKey = 'queued' | 'active' | 'attention' | 'finished';
export const COLUMNS: { key: ColumnKey; title: string; has: (q: QuestStatus) => boolean }[] = [
  { key: 'queued', title: 'Queued', has: (q) => q === 'queued' },
  { key: 'active', title: 'In progress', has: (q) => q === 'planning' || q === 'running' || q === 'cancelling' },
  { key: 'attention', title: 'Needs attention', has: (q) => q === 'awaiting_input' || q === 'in_review' || q === 'failed' },
  { key: 'finished', title: 'Finished', has: (q) => q === 'completed' || q === 'cancelled' },
];
export const columnOf = (s: QuestStatus): ColumnKey => COLUMNS.find((c) => c.has(s))!.key;

export type StatusFilter = 'all' | 'active' | 'attention' | 'finished';
const IN_FILTER: Record<StatusFilter, (c: ColumnKey) => boolean> = {
  all: () => true,
  active: (c) => c === 'queued' || c === 'active',
  attention: (c) => c === 'attention',
  finished: (c) => c === 'finished',
};
export const filterColumns = (f: StatusFilter) => COLUMNS.filter((c) => IN_FILTER[f](c.key));

export interface BoardQuest extends QuestItem { deptName: string; floor: string }

/** All quests of active departments, newest first, each labelled with its department and floor. */
export function companyQuests(depts: Dept[], quests: QuestItem[]): BoardQuest[] {
  const byId = new Map(depts.map((d, i) => [d.id, { name: d.name, floor: 'F' + (depts.length - i) }]));
  return quests
    .filter((q) => byId.has(q.deptId))
    .map((q) => ({ ...q, deptName: byId.get(q.deptId)!.name, floor: byId.get(q.deptId)!.floor }))
    .sort((a, b) => (b.summary.createdAt ?? '').localeCompare(a.summary.createdAt ?? '') || a.summary.id.localeCompare(b.summary.id));
}

export function filterQuests(list: BoardQuest[], dept: string | null, status: StatusFilter): BoardQuest[] {
  return list.filter((q) => (!dept || q.deptId === dept) && IN_FILTER[status](columnOf(q.summary.status)));
}

export interface MissingDept { id: string; name: string; sync: 'out_of_date' | 'not_loaded'; text: string }

/** Departments whose quests on the board are incomplete. `dept` narrows to one department when the board is filtered. */
export function missingDepts(depts: Dept[], sync: Record<string, QuestSync>, hermesUp: boolean, dept: string | null = null): MissingDept[] {
  const why = hermesUp ? 'the last refresh failed' : 'Hermes is not reachable';
  const out: MissingDept[] = [];
  for (const d of depts) {
    if (dept && d.id !== dept) continue;
    const s = sync[d.id];
    if (s === 'not_loaded') out.push({ id: d.id, name: d.name, sync: s, text: `${d.name}: quests not loaded (${why}). Its quests are missing from this board, not zero.` });
    else if (s === 'out_of_date') out.push({ id: d.id, name: d.name, sync: s, text: `${d.name}: showing the last quests received (${why}).` });
  }
  return out;
}

export interface DeptOption { id: string; label: string; chief: string | null; disabled: string | null }

/** Departments the composer offers. A disabled option carries the reason it cannot take a quest. */
export function questTargets(depts: Dept[], hermesUp: boolean): DeptOption[] {
  return depts.map((d, i) => {
    const label = `F${depts.length - i} · ${d.name}`;
    const disabled = d.provisioning !== 'ready'
      ? (d.provisioning === 'unconfigured' ? 'not provisioned' : d.provisioning === 'disconnected' ? 'Hermes resources not verified' : d.provisioning === 'provisioning' ? 'provisioning' : 'provisioning failed')
      : !hermesUp ? 'Hermes not reachable' : null;
    return { id: d.id, label, chief: d.chief?.name ?? null, disabled };
  });
}

/** The department the composer starts with: the requested one if it can take a quest, else the only one that can. */
export function defaultTarget(options: DeptOption[], wanted: string | null): string | null {
  const ok = options.filter((o) => !o.disabled);
  if (wanted && ok.some((o) => o.id === wanted)) return wanted;
  return ok.length === 1 ? ok[0]!.id : null;
}

export const GATEWAY_WARNING = 'The Hermes gateway is not running: the quest will be created and wait in Queued until the gateway starts. Nothing runs before that.';

/** Badge for the top bar: quests in the Needs attention column (from data actually loaded). */
export const attentionCount = (quests: QuestItem[]) => quests.filter((q) => columnOf(q.summary.status) === 'attention').length;
