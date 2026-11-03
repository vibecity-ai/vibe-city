import { create } from 'zustand';
import type {
  ActivityEvent, EffectiveInventory, Inventory, ProfilesView, ProvisioningStatus, QuestDetail, QuestResults, QuestSummary,
} from '@vibe-city/shared';
import type { AgentStatus, Connection, Dept } from './data/types';

/* World effects: one-shot cues the renderer plays. They are only emitted after the backend reports the change they
   illustrate (data/live.ts diffs consecutive snapshots), so animation may lag the truth but never leads it. */
export type Fx =
  | { k: 'delegate'; dept: string; to: string }
  | { k: 'taskDone'; dept: string; worker: string }
  | { k: 'taskFail'; dept: string; worker: string }
  | { k: 'plan'; dept: string }
  | { k: 'questDone'; dept: string }
  | { k: 'floorAdded'; dept: string }
  | { k: 'chiefArrived'; dept: string }
  | { k: 'workerJoined'; dept: string; worker: string };

export type View = 'tower' | 'floor';
export type Panel = 'exec' | 'dept' | 'inventory' | 'board' | 'quest';
export type DeptTab = 'overview' | 'inventory' | 'quests';

export interface Toast { id: number; text: string; tone: 'good' | 'warn' | 'bad' }
export interface LogLine { t: string; dept: string; kind: AgentStatus | 'chief'; text: string }
export interface QuestItem { deptId: string; summary: QuestSummary }
export interface QuestExtra { activity: ActivityEvent[]; results: QuestResults | null; error: string | null; loading: boolean }
export interface DeptInfo {
  inventory: Inventory | null; provisioning: ProvisioningStatus | null;
  effective: EffectiveInventory | null; profiles: ProfilesView | null;
}

interface UI {
  view: View; floorId: string | null; panel: Panel; deptTab: DeptTab; questId: string | null;
  modal: 'create' | null; composer: boolean; agent: string | null; boardFilter: 'all' | 'active' | 'attention' | 'finished';
}

export interface State {
  company: { name: string } | null;
  depts: Dept[];
  quests: QuestItem[];
  /** Task trees of quests that are in flight, plus any quest the user opened. */
  details: Record<string, QuestDetail>;
  extra: Record<string, QuestExtra>;
  info: Record<string, DeptInfo>;
  conn: Connection;
  /** First snapshot received. */
  loaded: boolean;
  /** The latest refresh failed: what is on screen is the last good data. */
  stale: boolean;
  /** In-flight mutations, keyed e.g. `provision:<deptId>`. */
  busy: Record<string, true>;
  ui: UI;
  toasts: Toast[];
  fx: { seq: number; fx: Fx }[];
  log: LogLine[];
  ui$: (p: Partial<UI>) => void;
  openFloor: (id: string) => void;
  closeFloor: () => void;
  openPanel: (p: Panel, extra?: Partial<UI>) => void;
  toast: (text: string, tone?: Toast['tone']) => void;
  emit: (fx: Fx) => void;
}

let fxSeq = 0, toastSeq = 0;

export const useStore = create<State>((set) => ({
  company: null,
  depts: [],
  quests: [],
  details: {},
  extra: {},
  info: {},
  conn: { backend: true, hermes: true, gateway: true },
  loaded: false,
  stale: false,
  busy: {},
  ui: { view: 'tower', floorId: null, panel: 'exec', deptTab: 'overview', questId: null, modal: null, composer: false, agent: null, boardFilter: 'all' },
  toasts: [], fx: [], log: [],

  ui$: (p) => set((s) => ({ ui: { ...s.ui, ...p } })),
  openFloor: (id) => set((s) => ({ ui: { ...s.ui, view: 'floor', floorId: id, panel: 'dept', deptTab: 'overview', agent: null, composer: false } })),
  closeFloor: () => set((s) => ({ ui: { ...s.ui, view: 'tower', floorId: null, panel: 'exec', agent: null, composer: false } })),
  openPanel: (panel, extra) => set((s) => ({ ui: { ...s.ui, panel, ...extra } })),
  toast: (text, tone = 'good') => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'bad' ? 7000 : 4200);
  },
  emit: (fx) => set((s) => ({ fx: [...s.fx.slice(-40), { seq: ++fxSeq, fx }] })),
}));

/** Floor number shown on signs: the top department has the highest number. */
export const floorNum = (depts: Dept[], id: string) => depts.length - depts.findIndex((d) => d.id === id);
