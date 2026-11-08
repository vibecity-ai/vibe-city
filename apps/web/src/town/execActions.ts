/* What each object in the Executive Office opens (feature spec 3.1). Shared by the canvas (click) and the DOM labels
   (keyboard and screen readers), so both paths do the same thing. */
import { useStore } from './store';
import { api } from '../api';
import type { ExecObjectId } from './world/execRoom';
import type { FloorObjectId } from './data/floor';
import { callAr } from './ui/Hiring';

export function execAction(id: ExecObjectId) {
  const s = useStore.getState();
  switch (id) {
    case 'desk': s.openPanel('board', { composer: true, composerDept: null, boardDept: null, boardQuest: null }); break;
    case 'table': s.openPanel('board', { composer: false, boardDept: null, boardFilter: 'all', boardQuest: null }); break;
    case 'trophy': s.ui$({ questLog: true }); break;
    case 'org': case 'safe': case 'calendar': s.ui$({ execModal: id }); break;
    case 'assistant': s.ui$({ newDept: true }); break;
    case 'library': s.ui$({ skillLib: { deptId: null, skill: null } }); break;
    case 'phone': {
      // The phone rings for incoming calls (AR); otherwise it reaches the assistant.
      const h = s.hiring;
      if (h && h.state === 'ringing') void api.hiringAnswer(h.id).then((v) => { s.hiring$(v); s.ui$({ call: { mode: 'ar', reqId: v.id } }); }).catch(() => undefined);
      else s.ui$({ newDept: true });
      break;
    }
    case 'ar': {
      const h = s.hiring;
      // the hiring office: an open shortlist or call first, otherwise the Chief of Staff
      if (h && h.state === 'shortlist') s.ui$({ call: { mode: 'shortlist', reqId: h.id } });
      else if (h && (h.state === 'scouting' || h.state === 'intake')) s.ui$({ call: { mode: 'ar', reqId: h.id } });
      else s.ui$({ newDept: true });
      break;
    }
  }
}

/** What each control on a department floor opens (the canvas click and the DOM label share it). */
export function floorAction(id: FloorObjectId, deptId: string) {
  const s = useStore.getState();
  const d = s.depts.find((x) => x.id === deptId);
  switch (id) {
    case 'board': s.openPanel('board', { composer: false, boardDept: deptId, boardFilter: 'all', boardQuest: null }); break;
    case 'lead': if (d?.chief) s.openPanel('agent', { agent: 'chief' }); else s.openPanel('dept', { deptTab: 'overview' }); break;
    case 'meeting': s.openPanel('dept', { deptTab: 'loadout', agent: null }); break;
    case 'rack': s.ui$({ floorSheet: 'tools' }); break;
    case 'station': s.ui$({ floorSheet: 'station' }); break;
    case 'clock': s.ui$({ execModal: 'calendar', scheduleDept: deptId }); break;
    case 'elevator': void callAr(deptId); break;
  }
}
