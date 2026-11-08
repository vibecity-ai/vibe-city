import { create } from 'zustand';
import type { GameState } from '@vibe-city/shared';
import type {
  HiringRequestView, QuestOrigin, QuestRequestView, Schedule, Character,
  ActivityEvent, AgentView, CancellationStatus, EffectiveInventory, Inventory, ProfilesView, ProvisioningStatus, QuestDetail, QuestResults, QuestSummary,
} from '@vibe-city/shared';
import type { AgentStatus, Connection, Dept } from './data/types';
import type { QuestSync } from './data/company';

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
  | { k: 'workerJoined'; dept: string; worker: string }
  /** A chief handed work to another department: a packet flies from floor to floor. */
  | { k: 'questRequest'; dept: string; from: string }
  /** A schedule fired: the floor holds a short stand-up at its Kanban wall. */
  | { k: 'standup'; dept: string };

export type View = 'tower' | 'floor';
export type Panel = 'exec' | 'dept' | 'settings' | 'board' | 'quest' | 'agent';
export type DeptTab = 'overview' | 'loadout' | 'quests';

/** A dialogue opened about a blocked task: the agent explains what it needs and can suggest resuming it. */
export interface BlockedTalk { questId: string; taskId: string; title: string; reason: string | null }

export interface Toast { id: number; text: string; tone: 'good' | 'warn' | 'bad' }
export interface LogLine { t: string; dept: string; kind: AgentStatus | 'chief'; text: string; taskId?: string }
export interface QuestItem { deptId: string; summary: QuestSummary }
/** `poll` tracks the explicit cancellation polling after a cancel request (see live.ts pollCancellation). */
export type CancelPoll = 'idle' | 'polling' | 'timeout' | 'hermes_down';
export interface QuestExtra {
  activity: ActivityEvent[]; results: QuestResults | null; error: string | null; loading: boolean;
  /** Newest cancellation status seen (from quest detail or polling); never regresses from confirmed. */
  cancellation: CancellationStatus | null; poll: CancelPoll;
}
export const emptyExtra = (): QuestExtra => ({ activity: [], results: null, error: null, loading: false, cancellation: null, poll: 'idle' });
export interface DeptInfo {
  inventory: Inventory | null; provisioning: ProvisioningStatus | null;
  effective: EffectiveInventory | null; profiles: ProfilesView | null;
  /** Last error loading effective inventory / profiles (the previous values are kept). */
  infoError?: string | null;
}

interface UI {
  view: View; floorId: string | null; panel: Panel; deptTab: DeptTab; questId: string | null;
  modal: 'create' | 'archive' | null; composer: boolean; agent: string | null; boardFilter: 'all' | 'active' | 'attention' | 'finished'; boardBy: 'anyone' | 'user' | 'agent' | 'schedule';
  /** Company quest board: department filter (null = every department) and the department the composer starts with. */
  boardDept: string | null; composerDept: string | null;
  /** Where quest detail returns to: the company board, or the floor it was opened from. */
  questFrom: 'board' | 'dept';
  /** The dialogue window: who you are talking to (a chief or a worker desk), in which chat (a Hermes session id or
      'new'; omitted = their last chat). */
  talk: { deptId: string; agentKey: string; session?: string; blocked?: BlockedTalk } | null;
  /** AR hiring: the dialogue window on AR's head (intake) or on a candidate (interview), or the shortlist popup. */
  call: { mode: 'ar' | 'interview' | 'shortlist'; reqId: string; candId?: string } | null;
  /** Quest open in the drawer over the company board (the board stays visible behind it). */
  boardQuest: string | null;
  /** New floor through the dialogue window with the executive assistant (the form stays as the accessible fallback). */
  newDept: boolean;
  /** Inside the Executive Office (the penthouse opened up, feature spec 3.1), and which of its screens is open. */
  execRoom: boolean; execModal: 'org' | 'safe' | 'calendar' | null;
  /** Calendar opened from a floor: show only that floor's schedules. */
  scheduleDept: string | null;
  /** The CEO quest log window (brief 05). */
  questLog: boolean;
  /** A sheet opened from a floor's control: the tools behind the server rack, or the template's station. */
  floorSheet: 'tools' | 'station' | null;
  /** The Skill library window: opened from a floor (that floor first) or the Executive Office, maybe on one skill. */
  skillLib: { deptId: string | null; skill: string | null } | null;
}

export interface State {
  company: { name: string } | null;
  depts: Dept[];
  quests: QuestItem[];
  /** Per department: whether its quest list is current, out of date, never loaded, or absent (no board yet). */
  questSync: Record<string, QuestSync>;
  /** Task trees of quests that are in flight, plus any quest the user opened. */
  details: Record<string, QuestDetail>;
  extra: Record<string, QuestExtra>;
  info: Record<string, DeptInfo>;
  conn: Connection;
  /** First snapshot received. */
  loaded: boolean;
  /** The latest refresh failed: what is on screen is the last good data. */
  stale: boolean;
  /** Agent views keyed `<deptId>:<role>`; a failed reload keeps the last view and sets `error`. */
  agents: Record<string, { view: AgentView | null; error: string | null; loading: boolean }>;
  /** Departments whose live socket to the backend is down (REST polling still runs). */
  liveDown: Record<string, true>;
  /** In-flight mutations, keyed e.g. `provision:<deptId>`. */
  busy: Record<string, true>;
  ui: UI;
  /** The open AR hiring request (ringing, intake, scouting, shortlist), polled from the backend. */
  hiring: HiringRequestView | null;
  /** Quests between departments (spec 2.4): recent requests, and who created each quest. */
  requests: QuestRequestView[];
  /** Schedules of every floor (feature spec 8). */
  schedules: Schedule[];
  /** Personas of agent seats, keyed `<deptId>:<agentKey>` (loaded when a floor opens). */
  personas: Record<string, Character>;
  /** The game loop (brief 05): CEO quests, decisions, runway. Null until first read. */
  game: GameState | null;
  origins: Record<string, QuestOrigin>;
  hiring$: (h: HiringRequestView | null) => void;
  toasts: Toast[];
  fx: { seq: number; fx: Fx }[];
  log: LogLine[];
  ui$: (p: Partial<UI>) => void;
  openFloor: (id: string) => void;
  closeFloor: () => void;
  openExec: () => void;
  openPanel: (p: Panel, extra?: Partial<UI>) => void;
  toast: (text: string, tone?: Toast['tone']) => void;
  emit: (fx: Fx) => void;
}

let fxSeq = 0, toastSeq = 0;

export const useStore = create<State>((set) => ({
  company: null,
  depts: [],
  quests: [],
  questSync: {},
  details: {},
  extra: {},
  info: {},
  conn: { backend: true, hermes: true, gateway: true },
  loaded: false,
  stale: false,
  busy: {},
  agents: {},
  liveDown: {},
  ui: { view: 'tower', floorId: null, panel: 'exec', deptTab: 'overview', questId: null, modal: null, composer: false, agent: null, boardFilter: 'all', boardDept: null, composerDept: null, questFrom: 'board', talk: null, call: null, boardQuest: null, newDept: false, boardBy: 'anyone', execRoom: false, execModal: null, scheduleDept: null, questLog: false, floorSheet: null, skillLib: null },
  toasts: [], fx: [], log: [],
  hiring: null,
  requests: [], game: null, origins: {}, schedules: [], personas: {},
  hiring$: (h) => set({ hiring: h }),

  ui$: (p) => set((s) => ({ ui: { ...s.ui, ...p } })),
  openFloor: (id) => set((s) => ({ ui: { ...s.ui, view: 'floor', floorId: id, panel: 'dept', deptTab: 'overview', agent: null, composer: false, execRoom: false, execModal: null, floorSheet: null } })),
  openExec: () => set((s) => ({ ui: { ...s.ui, view: 'tower', floorId: null, panel: 'exec', agent: null, composer: false, talk: null, execRoom: true } })),
  closeFloor: () => set((s) => ({ ui: { ...s.ui, view: 'tower', floorId: null, panel: 'exec', agent: null, composer: false, talk: null, execRoom: false, execModal: null, floorSheet: null } })),
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
