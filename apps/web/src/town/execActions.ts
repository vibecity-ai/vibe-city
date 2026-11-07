/* What each object in the Executive Office opens (feature spec 3.1). Shared by the canvas (click) and the DOM labels
   (keyboard and screen readers), so both paths do the same thing. */
import { useStore } from './store';
import { api } from '../api';
import type { ExecObjectId } from './world/execRoom';

export function execAction(id: ExecObjectId) {
  const s = useStore.getState();
  switch (id) {
    case 'desk': s.openPanel('board', { composer: true, composerDept: null, boardDept: null, boardQuest: null }); break;
    case 'table': s.openPanel('board', { composer: false, boardDept: null, boardFilter: 'all', boardQuest: null }); break;
    case 'trophy': s.ui$({ questLog: true }); break;
    case 'org': case 'safe': case 'calendar': s.ui$({ execModal: id }); break;
    case 'assistant': s.ui$({ newDept: true }); break;
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
