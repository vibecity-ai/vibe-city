/* What each object in the Executive Office opens (feature spec 3.1). Shared by the canvas (click) and the DOM labels
   (keyboard and screen readers), so both paths do the same thing. */
import { useStore } from './store';
import { api } from '../api';
import type { ExecObjectId } from './world/execRoom';
import type { FloorObjectId } from './data/floor';

/** A click on something in the world starts from a clear desk, so the tool it opens is the one you see (a tool
    opened from inside another sheet stacks on it instead). Conversations and calls are scenes, not desk tools. */
const CLEAR_DESK = { execModal: null, scheduleDept: null, floorSheet: null, questLog: false, modal: null, skillLib: null, boardQuest: null } as const;

export function execAction(id: ExecObjectId) {
  const s = useStore.getState();
  s.ui$(CLEAR_DESK);
  switch (id) {
    case 'desk': s.openPanel('board', { composer: true, composerDept: null, boardDept: null, boardQuest: null }); break;
    // the meeting table is where jobs are reviewed, here and on every floor: the Ops board (all floors here)
    case 'table': s.openPanel('board', { composer: false, boardDept: null, boardFilter: 'all', boardQuest: null }); break;
    case 'trophy': s.ui$({ questLog: true }); break;
    case 'org': case 'safe': case 'calendar': s.ui$({ execModal: id }); break;
    case 'assistant': {
      // the Chief of Staff runs hiring too: an open shortlist or a scout's call comes first
      const h = s.hiring;
      if (h && h.state === 'shortlist') s.ui$({ call: { mode: 'shortlist', reqId: h.id } });
      else if (h && (h.state === 'scouting' || h.state === 'intake')) s.ui$({ call: { mode: 'ar', reqId: h.id } });
      else s.ui$({ newDept: true });
      break;
    }
    case 'library': s.ui$({ skillLib: { deptId: null, skill: null } }); break;
    case 'phone': {
      // The phone rings for incoming calls (AR); otherwise it reaches the assistant.
      const h = s.hiring;
      if (h && h.state === 'ringing') void api.hiringAnswer(h.id).then((v) => { s.hiring$(v); s.ui$({ call: { mode: 'ar', reqId: v.id } }); }).catch(() => undefined);
      else s.ui$({ newDept: true });
      break;
    }
  }
}

/** What each control on a department floor opens (the canvas click and the DOM label share it). */
export function floorAction(id: FloorObjectId, deptId: string) {
  const s = useStore.getState();
  s.ui$(CLEAR_DESK);
  const d = s.depts.find((x) => x.id === deptId);
  switch (id) {
    case 'board': s.openPanel('board', { composer: false, boardDept: deptId, boardFilter: 'all', boardQuest: null }); break;
    case 'lead': if (d?.chief) s.openPanel('agent', { agent: 'chief' }); else s.openPanel('dept', { deptTab: 'overview' }); break;
    case 'meeting': s.openPanel('board', { composer: false, boardDept: deptId, boardFilter: 'all', boardQuest: null }); break;
    // the rack holds the floor's gear: the loadout, where tools and skills are switched on and off
    case 'rack': s.openPanel('dept', { deptTab: 'loadout', agent: null }); break;
    case 'station': s.ui$({ floorSheet: 'station' }); break;
    case 'clock': s.ui$({ execModal: 'calendar', scheduleDept: deptId }); break;
  }
}
