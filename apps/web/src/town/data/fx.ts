/* What changed between two refreshes, as city events (world/City.ts draws them, ui/Moments.tsx celebrates them).
   Pure: tested in fx.test.ts. */
import type { GameState } from '@vibe-city/shared';
import type { Fx, QuestItem } from '../store.ts';
import { isLiveQuest } from './derive.ts';
import type { Dept } from './types.ts';

/** The events between two refreshes: floors and hires arriving, tasks moving, jobs starting, finishing or waiting on you. */
export function fxBetween(prev: Dept[], next: Dept[], pq: QuestItem[], nq: QuestItem[]): Fx[] {
  const out: Fx[] = [];
  const emit = (f: Fx) => { out.push(f); };
  const before = new Map(prev.map((d) => [d.id, d]));
  for (const d of next) {
    const p = before.get(d.id);
    if (!p) { emit({ k: 'floorAdded', dept: d.id }); continue; }
    if (!p.chief && d.chief) emit({ k: 'chiefArrived', dept: d.id });
    if (p.chief?.status !== 'running' && d.chief?.status === 'running') emit({ k: 'plan', dept: d.id });
    const had = new Map(p.workers.map((w) => [w.id, w]));
    for (const w of d.workers) {
      const o = had.get(w.id);
      if (!o) { emit({ k: 'workerJoined', dept: d.id, worker: w.id }); if (w.status === 'running') emit({ k: 'delegate', dept: d.id, to: w.id, title: w.said?.title ?? null }); continue; }
      // A teammate keeps its desk across tasks: a new task counts as a change even when the status reads the same.
      const changed = o.status !== w.status || o.taskId !== w.taskId;
      if (changed && w.status === 'completed') emit({ k: 'taskDone', dept: d.id, worker: w.id });
      if (changed && w.status === 'failed') emit({ k: 'taskFail', dept: d.id, worker: w.id });
      if (changed && w.status === 'running') emit({ k: 'delegate', dept: d.id, to: w.id, title: w.said?.title ?? null });
    }
  }
  const was = new Map(pq.map((q) => [q.summary.id, q.summary.status]));
  const fresh = new Set(next.filter((d) => !before.has(d.id)).map((d) => d.id));
  for (const q of nq) {
    const old = was.get(q.summary.id), t = q.summary.title;
    // a brand-new floor already celebrates; its first job does not need a second banner
    if (old === undefined && !fresh.has(q.deptId) && isLiveQuest(q.summary)) emit({ k: 'questStarted', dept: q.deptId, title: t });
    if (old !== undefined && old !== q.summary.status && q.summary.status === 'completed') emit({ k: 'questDone', dept: q.deptId, title: t });
    if (old !== undefined && old !== q.summary.status && q.summary.status === 'awaiting_input') emit({ k: 'needsYou', dept: q.deptId, title: t });
  }
  return out;
}

/** Quest-log quests that turned done between two game states. The first load is history, not news, and the IPO
    quest is left out: the opening bell already celebrates it. */
export const questsCompleted = (prev: GameState | null, next: GameState | null): Fx[] => {
  if (!prev || !next) return [];
  const was = new Set(prev.quests.filter((q) => q.done).map((q) => q.id));
  return next.quests.filter((q) => q.done && !was.has(q.id) && q.id !== 'ipo').map((q) => ({ k: 'questComplete', title: q.title, unlocks: q.unlocks }));
};

/* The opening bell (IPO): the ceremony's clock, shared by the city (the bell swings, world/City.ts) and the sound (it
   strikes, sfx.ts). */
export const BELL_S = 7, BELL_STRIKES = 5;
/** When strike `k` lands, in seconds into the ceremony. */
export const bellStrike = (k: number) => 0.9 + k * 1.1;
/** The bell's angle in radians `T` seconds in: at rest at both ends, at full swing (alternating sides) on every strike. */
export const bellSwing = (T: number) => (T <= 0 || T >= BELL_S ? 0
  : 0.42 * Math.min(1, T / 0.9, (BELL_S - T) / 1.6) * Math.cos((Math.PI * (T - 0.9)) / 1.1));
