import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HermesRejectedError, HermesUnavailableError } from './hermes/ports.ts';
import { CANCEL_MARKER } from './domain/questService.ts';
import { questApp } from './testUtils.ts';

const Q = (dept: string, quest: string) => `/api/departments/${dept}/quests/${quest}`;
const cancel = (t: ReturnType<typeof questApp>, dept: string, quest: string) => t.app.inject({ method: 'POST', url: `${Q(dept, quest)}/cancel` });

async function runningQuest(t: ReturnType<typeof questApp>, d: { board: string; chief: string; worker: string }, kids = 2) {
  const root = t.kanban.seedTask(d.board, { title: 'Quest', assignee: d.chief });
  t.kanban.startRun(d.board, root.id, d.chief);
  const workers = Array.from({ length: kids }, (_, i) => t.kanban.seedTask(d.board, { title: `W${i + 1}`, assignee: d.worker, parents: [root.id] }));
  t.kanban.complete(d.board, root.id, 'planned'); // children become ready
  t.kanban.startRun(d.board, workers[0]!.id, d.worker); // one running, the rest ready
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

test('cancel never leaves a task that could be redispatched (nothing ready/todo/running afterwards)', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { root } = await runningQuest(t, d, 4);
  await cancel(t, d.id, root.id);
  const statuses = (await t.kanban.listBoardTasks(d.board, { includeArchived: true })).map((x) => x.status);
  assert.ok(statuses.every((s) => s === 'done' || s === 'archived'), statuses.join());
});

test('the running chief is stopped without its not-yet-started children ever becoming runnable first', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const root = t.kanban.seedTask(d.board, { title: 'Quest', assignee: d.chief });
  t.kanban.startRun(d.board, root.id, d.chief);
  const kid = t.kanban.seedTask(d.board, { title: 'W', assignee: d.worker, parents: [root.id] });
  assert.equal(t.kanban.statusOf(d.board, kid.id), 'todo');
  const order: string[] = [];
  t.kanban.beforeArchive = (_b, id) => order.push(id);
  await cancel(t, d.id, root.id);
  assert.deepEqual(order, [root.id, kid.id], 'running task first (stops creation of new tasks), then the rest');
  assert.equal(t.kanban.statusOf(d.board, kid.id), 'archived');
});

test('race (preventable): a task that finishes between the tree read and the archive decision is left done', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { root, workers } = await runningQuest(t, d, 2);
  // 1st read of the task = tree load; 2nd = the fresh status check right before acting
  t.kanban.beforeGetTask = (board, id, nth) => { if (id === workers[0]!.id && nth === 2) t.kanban.complete(board, id, 'finished in the nick of time'); };
  const st = (await cancel(t, d.id, root.id)).json();
  assert.equal(st.state, 'confirmed');
  assert.equal(t.kanban.statusOf(d.board, workers[0]!.id), 'done', 'completed work is not archived');
  assert.ok(!t.kanban.calls.includes(`archiveTask(${d.board},${workers[0]!.id})`), 'archive was never even attempted on the finished task');
  assert.equal(t.kanban.statusOf(d.board, workers[1]!.id), 'archived');
  assert.ok(st.alreadyFinishedTaskIds.includes(workers[0]!.id));
  assert.ok(!st.archivedTaskIds.includes(workers[0]!.id));
});

test('race (irreducible): finishing inside Hermes\' archive call is archived but reported as finished, with its result kept', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { root, workers } = await runningQuest(t, d, 2);
  t.kanban.beforeArchive = (board, id) => { if (id === workers[0]!.id) t.kanban.complete(board, id, 'finished during archive'); };
  const st = (await cancel(t, d.id, root.id)).json();
  assert.equal(st.state, 'confirmed');
  assert.ok(st.alreadyFinishedTaskIds.includes(workers[0]!.id), 'reported as finished, not as cancelled work');
  assert.ok(!st.archivedTaskIds.includes(workers[0]!.id));
  const results = (await t.get(`${Q(d.id, root.id)}/results`)).json();
  assert.equal(results.tasks.find((x: any) => x.taskId === workers[0]!.id).summary, 'finished during archive', 'the result survives');
});

test('race: the chief creates a new task while cancellation is in progress -> a later pass still stops it', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const root = t.kanban.seedTask(d.board, { title: 'Quest', assignee: d.chief });
  t.kanban.startRun(d.board, root.id, d.chief);
  let injected = false;
  t.kanban.beforeArchive = (board) => {
    if (injected) return;
    injected = true;
    t.kanban.seedTask(board, { title: 'late child', assignee: d.worker, parents: [root.id] });
  };
  const st = (await cancel(t, d.id, root.id)).json();
  assert.equal(st.state, 'confirmed');
  const all = await t.kanban.listBoardTasks(d.board, { includeArchived: true });
  assert.equal(all.length, 2);
  assert.ok(all.every((x) => x.status === 'archived'), 'the late child was archived too');
});

test('pending, not confirmed: Hermes still shows an open run after the archive', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { root, workers } = await runningQuest(t, d, 1);
  t.kanban.archiveKeepsRunOpen = true;
  const st = (await cancel(t, d.id, root.id)).json();
  assert.equal(st.state, 'requested', 'must not claim success while a run is still open');
  assert.deepEqual(st.remaining, [{ taskId: workers[0]!.id, status: 'archived' }]);
  const detail = await t.get_(d.id, root.id);
  assert.equal(detail.status, 'cancelling');
  t.kanban.archiveKeepsRunOpen = false;
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

test('an archive refusal for one task does not stop the rest', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { root, workers } = await runningQuest(t, d, 2);
  t.kanban.failNext('archiveTask', new HermesRejectedError('refused'), 1);
  const st = (await cancel(t, d.id, root.id)).json();
  assert.equal(st.state, 'confirmed', 'a second pass archives what the first could not');
  for (const w of workers) assert.equal(t.kanban.statusOf(d.board, w.id), 'archived');
});

test('cancelling a finished quest is a 409 and changes nothing; cancelling twice is safe', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const done = t.kanban.seedTask(d.board, { title: 'Quest', assignee: d.chief });
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

test('concurrent cancel requests are coalesced into one archive pass', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { root, workers } = await runningQuest(t, d, 3);
  const [a, b] = await Promise.all([cancel(t, d.id, root.id), cancel(t, d.id, root.id)]);
  assert.deepEqual([a.statusCode, b.statusCode], [202, 202]);
  assert.equal(t.kanban.calls.filter((c) => c.startsWith('archiveTask')).length, workers.length, 'each task archived exactly once');
});

test('cancellation never uses a hard delete or a bare terminate (the KanbanApi has neither)', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { root } = await runningQuest(t, d, 1);
  await cancel(t, d.id, root.id);
  assert.ok(t.kanban.calls.every((c) => /^(listBoardTasks|getTask|addComment|archiveTask|createTask)\(/.test(c)), t.kanban.calls.join('\n'));
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
