import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deptView, detail } from '../../testing/fakeBackend.ts';
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

test('seat titles from a template appear on the desks; floors without a template show none', () => {
  const base = deptView();
  const titled = derive(deptView({ agents: base.agents.map((a) => ({ ...a, title: a.lead ? 'Engineering Manager' : 'Coder' })) }));
  assert.equal(titled.chief?.title, 'Engineering Manager');
  assert.deepEqual(titled.workers.map((w) => w.title), ['Coder']);
  const plain = derive(base);
  assert.equal(plain.chief?.title, undefined);
  assert.ok(plain.workers.every((w) => w.title === undefined));
});

test('a failed task puts the floor in attention even when the same agent is also running another one', () => {
  const base = detail().tasks[0]!;
  const quest = detail({ tasks: [
    { ...base, id: 't_run', title: 'Keep going', agentKey: 'W-01', status: 'running', depth: 1 },
    { ...base, id: 't_bad', title: 'Scrape A', agentKey: 'W-01', status: 'blocked', failed: true, depth: 1 },
  ] });
  const d = deriveDept({ dept: deptView(), provisioning: null, liveQuests: [quest], chiefModel: null, hermesUp: true });
  assert.equal(d.workers[0]!.status, 'running');
  assert.equal(d.state, 'attention');
  assert.equal(d.attention, 'Task failed: Scrape A');
});
