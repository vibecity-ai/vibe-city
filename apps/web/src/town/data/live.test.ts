/* The live connector against a scripted backend: stale/disconnected preservation, burst coalescing, archive cleanup,
   cancellation polling and failed-mutation safety. Fake WebSocket + mocked timers; no browser, no Hermes. */
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { CancellationStatus, QuestDetail } from '@vibe-city/shared';
import { DEPT_ID, company, deptView, detail, fakeBackend, health, inventory, iso, provStatus, summary } from '../../testing/fakeBackend.ts';
import { useStore } from '../store.ts';
import {
  archiveDepartment, cancelQuest, patchInventory, refreshAll, saveDepartmentSettings, stopLive,
} from './live.ts';

class FakeWS {
  static all: FakeWS[] = [];
  url: string; closed = false;
  onopen: (() => void) | null = null; onclose: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null;
  constructor(url: string) { this.url = url; FakeWS.all.push(this); }
  close() { this.closed = true; this.onclose?.(); }
  send() {}
  emit(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
}

const D = `/api/departments/${DEPT_ID}`;
const realFetch = globalThis.fetch;
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const initial = useStore.getState();

function backend() {
  const state = { depts: [deptView()], quests: [summary()], detail: detail(), hermesUp: true };
  const b = fakeBackend()
    .on('GET', '/api/runtime/health', () => ({ body: health(state.hermesUp) }))
    .on('GET', '/api/company', { body: company() })
    .on('GET', '/api/departments', () => ({ body: { departments: state.depts } }))
    .on('GET', D, () => ({ body: state.depts[0] }))
    .on('GET', `${D}/inventory`, { body: inventory() })
    .on('GET', `${D}/provisioning`, () => ({ body: provStatus({ state: state.depts[0]?.state ?? 'ready' }) }))
    .on('GET', `${D}/effective-inventory`, { status: 503, body: { error: 'hermes_unavailable', message: 'x' } })
    .on('GET', `${D}/profiles`, { body: { departmentId: DEPT_ID, reachable: true, chief: { ref: 'c', exists: true, model: 'm', description: null }, worker: { ref: 'w', exists: true, model: null, description: null } } })
    .on('GET', `${D}/quests`, () => ({ body: { quests: state.quests } }))
    .on('GET', `${D}/quests/t_root1`, () => ({ body: state.detail }))
    .on('GET', `${D}/quests/t_root1/activity`, { body: { questId: 't_root1', events: [] } })
    .on('GET', `${D}/quests/t_root1/results`, { body: { questId: 't_root1', status: 'running', chiefSummary: null, tasks: [] } });
  globalThis.fetch = b.fetch;
  return { b, state };
}

beforeEach(() => {
  FakeWS.all = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;
  (globalThis as unknown as { location: unknown }).location = { protocol: 'http:', host: '127.0.0.1:4100' };
  useStore.setState({ ...initial, toasts: [], extra: {}, details: {}, info: {}, busy: {}, quests: [], depts: [] }, true);
});
afterEach(() => { stopLive(); globalThis.fetch = realFetch; mock.timers.reset(); });

test('Hermes going away keeps the last quests; other failures mark data stale; backend loss keeps everything', async () => {
  const { b, state } = backend();
  await refreshAll();
  assert.equal(useStore.getState().quests.length, 1);
  assert.equal(useStore.getState().conn.hermes, true);

  state.hermesUp = false;
  b.on('GET', `${D}/quests`, { status: 503, body: { error: 'hermes_unavailable', message: 'Hermes is unreachable' } });
  await refreshAll();
  let s = useStore.getState();
  assert.equal(s.quests.length, 1, 'quests are not cleared while Hermes is down');
  assert.equal(s.conn.hermes, false);
  assert.equal(s.depts[0]!.state, 'offline');

  b.on('GET', `${D}/quests`, { status: 500, body: { error: 'internal_error' } });
  await refreshAll();
  s = useStore.getState();
  assert.equal(s.stale, true);
  assert.equal(s.quests.length, 1);

  b.setDown(true);
  await refreshAll();
  s = useStore.getState();
  assert.equal(s.conn.backend, false);
  assert.equal(s.stale, true);
  assert.equal(s.depts.length, 1, 'floors stay on screen');
});

test('a burst of live events triggers one quest refresh, not one per event', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { b } = backend();
  await refreshAll();
  await flush();
  assert.equal(FakeWS.all.length, 1);
  assert.match(FakeWS.all[0]!.url, /^ws:\/\/127\.0\.0\.1:4100\/api\/live\?departmentId=/);
  const lists = () => b.calls.filter((c) => c.path === `${D}/quests`).length;
  const before = lists();
  for (let i = 0; i < 25; i++) FakeWS.all[0]!.emit({ type: 'hermes.event', departmentId: DEPT_ID, eventId: i, taskId: 't_root1', kind: 'heartbeat', at: iso });
  mock.timers.tick(100);
  await flush();
  assert.equal(lists(), before, 'nothing yet: still inside the quiet period');
  mock.timers.tick(500);
  await flush();
  // one list fetch (exactly `${D}/quests`) for the whole burst
  assert.equal(lists() - before, 1);
  assert.equal(useStore.getState().log.length, 25, 'every event still reaches the activity feed');
});

test('archiving closes the floor, its socket and pending refreshes, and keeps Hermes resources', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { b, state } = backend();
  await refreshAll();
  await flush();
  useStore.getState().openFloor(DEPT_ID);
  FakeWS.all[0]!.emit({ type: 'resync', departmentId: DEPT_ID }); // a refresh is now pending
  b.on('DELETE', D, () => {
    state.depts = [];
    return { body: { department: deptView({ archivedAt: iso, floorPosition: null }), hermesResourcesRetained: true } };
  });
  const p = archiveDepartment(DEPT_ID);
  await flush();
  assert.equal(await p, null);
  const s = useStore.getState();
  assert.equal(s.depts.length, 0);
  assert.equal(s.ui.floorId, null);
  assert.equal(FakeWS.all[0]!.closed, true);
  assert.match(s.toasts.at(-1)!.text, /board and profiles were kept/);
  const n = b.count('GET', `${D}/quests`);
  mock.timers.tick(5000);
  await flush();
  assert.equal(b.count('GET', `${D}/quests`), n, 'no refresh fires for an archived floor');
});

test('cancellation: a 202 "requested" is polled until Hermes confirms; never shown as cancelled before', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { b, state } = backend();
  await refreshAll();
  useStore.getState().openPanel('quest', { questId: 't_root1' });
  const requested: CancellationStatus = { state: 'requested', requestedAt: iso, confirmedAt: null, remaining: [{ taskId: 't_root1', status: 'running' }], archivedTaskIds: [], alreadyFinishedTaskIds: [] };
  const confirmed: CancellationStatus = { ...requested, state: 'confirmed', confirmedAt: iso, remaining: [], archivedTaskIds: ['t_root1'] };
  let polls = 0;
  b.on('POST', `${D}/quests/t_root1/cancel`, { status: 202, body: requested });
  b.on('GET', `${D}/quests/t_root1/cancellation`, () => ({ body: ++polls >= 2 ? confirmed : requested }));
  state.detail = detail({ status: 'cancelling', cancellation: requested } as Partial<QuestDetail>);

  const p = cancelQuest(DEPT_ID, 't_root1');
  await flush();
  await p;
  let x = useStore.getState().extra.t_root1!;
  assert.equal(x.cancellation?.state, 'requested');
  assert.equal(x.poll, 'polling');
  assert.match(useStore.getState().toasts.map((t) => t.text).join('|'), /Cancellation requested/);
  assert.doesNotMatch(useStore.getState().toasts.map((t) => t.text).join('|'), /Quest cancelled/);

  mock.timers.tick(1000); await flush();
  assert.equal(useStore.getState().extra.t_root1!.cancellation?.state, 'requested');
  mock.timers.tick(2000); await flush();
  x = useStore.getState().extra.t_root1!;
  assert.equal(x.cancellation?.state, 'confirmed');
  assert.equal(x.poll, 'idle');
  assert.equal(polls, 2);
  // a late detail response that still says "requested" must not undo the confirmation
  mock.timers.tick(10_000); await flush();
  assert.equal(useStore.getState().extra.t_root1!.cancellation?.state, 'confirmed');
});

test('cancellation polling stops when Hermes goes away and when the view closes', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { b } = backend();
  await refreshAll();
  const requested: CancellationStatus = { state: 'requested', requestedAt: iso, confirmedAt: null, remaining: [], archivedTaskIds: [], alreadyFinishedTaskIds: [] };
  b.on('POST', `${D}/quests/t_root1/cancel`, { status: 202, body: requested });
  b.on('GET', `${D}/quests/t_root1/cancellation`, { status: 503, body: { error: 'hermes_unavailable', message: 'down' } });
  useStore.getState().openPanel('quest', { questId: 't_root1' });
  const p = cancelQuest(DEPT_ID, 't_root1'); await flush(); await p;
  mock.timers.tick(1000); await flush();
  assert.equal(useStore.getState().extra.t_root1!.poll, 'hermes_down');

  b.on('GET', `${D}/quests/t_root1/cancellation`, { body: requested });
  const p2 = cancelQuest(DEPT_ID, 't_root1'); await flush(); await p2;
  useStore.getState().openPanel('board', { questId: null });
  const n = b.count('GET', `${D}/quests/t_root1/cancellation`);
  mock.timers.tick(60_000); await flush();
  assert.equal(useStore.getState().extra.t_root1!.poll, 'idle');
  assert.equal(b.count('GET', `${D}/quests/t_root1/cancellation`), n, 'no request after the view closed');
});

test('a failed settings save keeps the last good state and returns the field error', async () => {
  const { b } = backend();
  await refreshAll();
  b.on('PATCH', D, { status: 409, body: { error: 'conflict', message: 'a department with this name already exists' } });
  const err = await saveDepartmentSettings(DEPT_ID, { name: 'Taken' });
  assert.equal(err?.status, 409);
  assert.match(err!.message, /already exists/);
  assert.equal(useStore.getState().depts[0]!.name, 'Research');
  assert.equal(useStore.getState().busy[`settings:${DEPT_ID}`], undefined);
});

test('a successful settings save refreshes this department and says when it must be provisioned again', async () => {
  const { b, state } = backend();
  await refreshAll();
  b.on('PATCH', D, () => { state.depts = [deptView({ name: 'Research 2', state: 'unconfigured' })]; return { body: state.depts[0] }; });
  const n = b.count('GET', '/api/company');
  assert.equal(await saveDepartmentSettings(DEPT_ID, { name: 'Research 2' }), null);
  const s = useStore.getState();
  assert.equal(s.depts[0]!.name, 'Research 2');
  assert.equal(s.depts[0]!.provisioning, 'unconfigured');
  assert.match(s.toasts.at(-1)!.text, /provisioned again/);
  assert.equal(b.count('GET', '/api/company'), n, 'only the affected department was refetched');
});

test('saving the inventory of a provisioned department warns that it needs provisioning again', async () => {
  const { b, state } = backend();
  await refreshAll();
  b.on('PATCH', `${D}/inventory`, () => { state.depts = [deptView({ state: 'unconfigured' })]; return { body: { ...inventory(), sharedContextRefs: ['wiki:handbook'] } }; });
  await patchInventory(DEPT_ID, { sharedContextRefs: ['wiki:handbook'] });
  assert.deepEqual(b.calls.find((c) => c.method === 'PATCH')!.body, { sharedContextRefs: ['wiki:handbook'] });
  const t = useStore.getState().toasts.at(-1)!;
  assert.equal(t.tone, 'warn');
  assert.match(t.text, /provisioning again/);
});
