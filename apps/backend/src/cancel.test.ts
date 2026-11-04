import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HermesUnavailableError } from './hermes/ports.ts';
import { CANCEL_MARKER } from './domain/questService.ts';
import { questApp } from './testUtils.ts';

const Q = (dept: string, quest: string) => `/api/departments/${dept}/quests/${quest}`;
const cancel = (t: ReturnType<typeof questApp>, dept: string, quest: string) => t.app.inject({ method: 'POST', url: `${Q(dept, quest)}/cancel` });

async function runningQuest(t: ReturnType<typeof questApp>, d: { board: string; lead: string; teammate: string }, kids = 2) {
  const root = t.kanban.seedTask(d.board, { title: 'Quest', assignee: d.lead });
  t.kanban.startRun(d.board, root.id, d.lead);
  const workers = Array.from({ length: kids }, (_, i) => t.kanban.seedTask(d.board, { title: `W${i + 1}`, assignee: d.teammate, parents: [root.id] }));
  t.kanban.complete(d.board, root.id, 'planned'); // children become ready
  t.kanban.startRun(d.board, workers[0]!.id, d.teammate); // one running, the rest ready
  return { root, workers };
}

test('cancel: archives every unfinished task, records intent in Hermes, and is confirmed only after re-reading the tree', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { root, workers } = await runningQuest(t, d, 3);
  const res = await cancel(t, d.id, root.id);
  assert.equal(res.statusCode, 202);
  const st = res.json();
  assert.equal(st.state, 'confirmed');
  assert.deepEqual(st.remaining, []);
  assert.deepEqual(st.archivedTaskIds.sort(), workers.map((w) => w.id).sort());
  assert.deepEqual(st.alreadyFinishedTaskIds, [root.id], 'the finished chief task keeps its result');
  assert.equal(t.kanban.statusOf(d.board, root.id), 'done');
  for (const w of workers) assert.equal(t.kanban.statusOf(d.board, w.id), 'archived');
  assert.ok(t.kanban.commentsOf(d.board).some((c) => c.task_id === root.id && c.body.startsWith(CANCEL_MARKER) && c.author === 'vibe-city'), 'durable intent in Hermes');
  assert.equal((await t.get_(d.id, root.id)).status, 'cancelled');
});

test('Hermes goes away mid-cancellation: error is reported, state is not faked, and a retry finishes the job', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { root, workers } = await runningQuest(t, d, 2);
  t.kanban.failNext('archiveTask', new HermesUnavailableError('down'), 1);
  const first = await cancel(t, d.id, root.id);
  assert.equal(first.statusCode, 503);
  // intent was recorded, but nothing is claimed as stopped
  const mid = (await t.app.inject({ method: 'GET', url: `${Q(d.id, root.id)}/cancellation` })).json();
  assert.equal(mid.state, 'requested');
  assert.ok(mid.remaining.length > 0);
  assert.equal((await t.get_(d.id, root.id)).status, 'cancelling');
  const retry = (await cancel(t, d.id, root.id)).json();
  assert.equal(retry.state, 'confirmed');
  for (const w of workers) assert.equal(t.kanban.statusOf(d.board, w.id), 'archived');
  assert.equal(t.kanban.commentsOf(d.board).filter((c) => c.body.startsWith(CANCEL_MARKER)).length, 1, 'the intent comment is written once');
});

test('cancelling a finished quest is a 409 and changes nothing; cancelling twice is safe', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const done = t.kanban.seedTask(d.board, { title: 'Quest', assignee: d.lead });
  t.kanban.complete(d.board, done.id, 'all done');
  const res = await cancel(t, d.id, done.id);
  assert.equal(res.statusCode, 409);
  assert.equal(t.kanban.commentsOf(d.board).length, 0, 'no marker written');
  assert.equal(t.kanban.statusOf(d.board, done.id), 'done');

  const { root } = await runningQuest(t, d, 1);
  assert.equal((await cancel(t, d.id, root.id)).json().state, 'confirmed');
  const again = await cancel(t, d.id, root.id);
  assert.equal(again.statusCode, 202);
  assert.equal(again.json().state, 'confirmed');
  assert.equal(t.kanban.commentsOf(d.board).filter((c) => c.body.startsWith(CANCEL_MARKER)).length, 1);
});

test('cancellation status is derived from Hermes: survives a restart and reflects external changes', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { root, workers } = await runningQuest(t, d, 1);
  assert.equal((await t.app.inject({ method: 'GET', url: `${Q(d.id, root.id)}/cancellation` })).json().state, 'none');
  t.kanban.archiveKeepsRunOpen = true;
  await cancel(t, d.id, root.id);
  t.kanban.archiveKeepsRunOpen = false;
  // a "restarted" backend has no memory: it reads the same truth from Hermes
  const { buildServices } = await import('./app.ts');
  const fresh = buildServices(t.db, t.hermes, { kanban: t.kanban });
  const s1 = (await fresh.app.inject(`${Q(d.id, root.id)}/cancellation`)).json();
  assert.equal(s1.state, 'requested');
  // the open run finally ends in Hermes -> confirmed on the next read, with no action from us
  const run = (await t.kanban.getTask(d.board, workers[0]!.id)).runs[0]!;
  Object.assign(run, { ended_at: 9_999_999_999, status: 'reclaimed', outcome: 'reclaimed' });
  assert.equal((await fresh.app.inject(`${Q(d.id, root.id)}/cancellation`)).json().state, 'confirmed');
});
