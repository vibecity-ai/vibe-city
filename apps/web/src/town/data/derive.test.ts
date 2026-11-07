import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deptView } from '../../testing/fakeBackend.ts';
import { deriveDept } from './derive.ts';

const derive = (v: ReturnType<typeof deptView>) => deriveDept({ dept: v, provisioning: null, liveQuests: [], chiefModel: null, hermesUp: true });

test('a synced floor with unsynced edits keeps its lead and team; a never-synced one shows setup', () => {
  const edited = derive(deptView({ state: 'unconfigured' }));
  assert.ok(edited.chief);
  assert.equal(edited.workers.length, 1);
  const fresh = derive(deptView({ state: 'unconfigured', agents: deptView().agents.map((a) => ({ ...a, profileRef: null })) }));
  assert.equal(fresh.chief, null);
  assert.equal(fresh.workers.length, 0);
});
