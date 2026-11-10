/* What changed between two refreshes, as city events (world/City.ts draws them, ui/Moments.tsx celebrates them).
   Pure: tested in fx.test.ts. */
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
