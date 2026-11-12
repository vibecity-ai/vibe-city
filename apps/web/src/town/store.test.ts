import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useStore } from './store.ts';

test('opening a panel puts away the sheets lying over it, unless the caller keeps one', () => {
  const s = useStore.getState();
  s.ui$({ questLog: true, floorSheet: 'station', skillLib: { deptId: null, skill: null }, execModal: 'safe', newDept: true, talk: null });
  s.openPanel('agent', { agent: 'chief' });
  const ui = useStore.getState().ui;
  assert.equal(ui.panel, 'agent');
  assert.equal(ui.agent, 'chief');
  assert.deepEqual([ui.questLog, ui.floorSheet, ui.skillLib, ui.execModal, ui.newDept], [false, null, null, null, false]);
  s.openPanel('board', { questLog: true });
  assert.equal(useStore.getState().ui.questLog, true, 'a caller may open a panel together with a sheet');
});

test('a busy toast is replaced by the next toast, so a result never sits beside its progress note', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  useStore.setState({ toasts: [] });
  const s = useStore.getState();
  s.toast('Earlier news');
  s.toast('Registering…', 'busy');
  s.toast('Registered');
  assert.deepEqual(useStore.getState().toasts.map((x) => x.text), ['Earlier news', 'Registered']);
});
