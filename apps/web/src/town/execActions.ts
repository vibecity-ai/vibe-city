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
    // the kanban board on the wall: the Ops board, every floor's jobs
    case 'board': s.openPanel('board', { composer: false, boardDept: null, boardFilter: 'all', boardQuest: null }); break;
    case 'trophy': s.ui$({ questLog: true }); break;
    case 'safe': case 'calendar': s.ui$({ execModal: id }); break;
    // always a fresh chat with the Chief of Staff's menu ("Hire a new agent" picks up a search already under way)
    case 'assistant': s.ui$({ newDept: true }); break;
    case 'library': s.ui$({ skillLib: { deptId: null, skill: null } }); break;
    case 'templates': s.ui$({ modal: 'create' }); break;
  }
}

/** What each control on a department floor opens (the canvas click and the DOM label share it). */
export function floorAction(id: FloorObjectId, deptId: string) {
  const s = useStore.getState();
  s.ui$(CLEAR_DESK);
  switch (id) {
    case 'board': s.openPanel('board', { composer: false, boardDept: deptId, boardFilter: 'all', boardQuest: null }); break;
    case 'lead': s.openPanel('dept', { deptTab: 'overview', agent: null }); break;
    case 'archive': s.ui$({ floorSheet: 'archive' }); break;
    // the floor's gear, each where it lives: tools in the rack, skills in the library, keys in the cabinet
    case 'rack': s.openPanel('dept', { deptTab: 'tools', agent: null }); break;
    case 'library': s.openPanel('dept', { deptTab: 'skills', agent: null }); break;
    case 'keys': s.openPanel('dept', { deptTab: 'env', agent: null }); break;
    case 'station': s.ui$({ floorSheet: 'station' }); break;
    case 'clock': s.ui$({ execModal: 'calendar', scheduleDept: deptId }); break;
  }
}
