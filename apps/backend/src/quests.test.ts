import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HermesUnavailableError } from './hermes/ports.ts';
import { questApp } from './testUtils.ts';

const Q = (dept: string, quest = '') => `/api/departments/${dept}/quests${quest ? `/${quest}` : ''}`;

/** A quest the way Hermes shapes it: chief root + worker children (children wait for the root to be done). */
async function seedQuest(t: ReturnType<typeof questApp>, d: { board: string; chief: string; worker: string }, workers = 2) {
  const root = t.kanban.seedTask(d.board, { title: 'Quest root', assignee: d.chief, body: '# Quest: x\n\n## Objective\nBuild it\n\n## How to execute\n...' });
  const kids = Array.from({ length: workers }, (_, i) => t.kanban.seedTask(d.board, { title: `Worker task ${i + 1}`, assignee: d.worker, parents: [root.id] }));
  return { root, kids };
}

// ---- creation -----------------------------------------------------------------------

test('creating a quest makes a real Hermes task assigned to the chief and returns its id', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const res = await t.create(d.id, { title: 'Ship it', objective: 'Implement X', instructions: 'be careful' });
  assert.equal(res.statusCode, 201);
  const { questId, hermesBoardSlug } = res.json();
  assert.equal(hermesBoardSlug, d.board);
  const raw = await t.kanban.getTask(d.board, questId);
  assert.equal(raw.task.assignee, d.chief, 'assigned to the department chief, server-side');
  assert.equal(raw.task.title, 'Ship it');
  assert.match(raw.task.body!, /Implement X/);
  assert.match(raw.task.body!, /be careful/);
  assert.ok(raw.task.body!.includes(`"${d.worker}"`), 'chief is told which worker profile to delegate to');
  assert.deepEqual(raw.links.parents, []);
});

test('quest creation is idempotent per clientRequestId', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const id = crypto.randomUUID();
  const a = await t.create(d.id, { clientRequestId: id });
  const b = await t.create(d.id, { clientRequestId: id });
  assert.equal(a.json().questId, b.json().questId);
  assert.equal((await t.kanban.listBoardTasks(d.board)).length, 1, 'no duplicate task');
  const c = await t.create(d.id, { clientRequestId: crypto.randomUUID() });
  assert.notEqual(c.json().questId, a.json().questId);
  assert.equal((await t.kanban.listBoardTasks(d.board)).length, 2);
});

test('the same clientRequestId in another department does not collide', async () => {
  const t = questApp();
  const a = await t.readyDept('A');
  const b = await t.readyDept('B');
  const id = crypto.randomUUID();
  const qa = (await t.create(a.id, { clientRequestId: id })).json().questId;
  const qb = (await t.create(b.id, { clientRequestId: id })).json().questId;
  assert.equal((await t.kanban.listBoardTasks(a.board)).length, 1);
  assert.equal((await t.kanban.listBoardTasks(b.board)).length, 1);
  assert.ok(qa && qb);
});

test('creation retried after a transient Hermes failure does not duplicate', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const id = crypto.randomUUID();
  t.kanban.failNext('createTask', new HermesUnavailableError('down'), 1);
  assert.equal((await t.create(d.id, { clientRequestId: id })).statusCode, 503);
  assert.equal((await t.kanban.listBoardTasks(d.board)).length, 0);
  assert.equal((await t.create(d.id, { clientRequestId: id })).statusCode, 201);
  assert.equal((await t.kanban.listBoardTasks(d.board)).length, 1);
});

test('creation requires a ready department and valid input', async () => {
  const t = questApp();
  const { json } = await (await import('./testUtils.ts')).createDept(t.app, { name: 'Raw' });
  assert.equal((await t.create(json.id)).statusCode, 409, 'unprovisioned');
  const d = await t.readyDept('Eng');
  for (const bad of [{ title: '' }, { objective: '  ' }, { clientRequestId: 'nope' }, { title: 'x'.repeat(201) }, { extra: 1 }]) {
    assert.equal((await t.create(d.id, bad)).statusCode, 400, JSON.stringify(bad));
  }
  await t.app.inject({ method: 'PATCH', url: `/api/departments/${d.id}/inventory`, payload: { allowedSkillIds: ['x'] } });
  assert.equal((await t.create(d.id)).statusCode, 409, 'inventory changed -> department must be re-provisioned');
  assert.equal((await t.kanban.listBoardTasks(d.board)).length, 0);
});

test('the department runtime cap is passed to Hermes as max_runtime_seconds; the Hermes warning is surfaced', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng', { limits: { maxTaskRuntimeSeconds: 900 } });
  t.kanban.gatewayWarning = 'No gateway is running — the task will sit in ready. Run: hermes gateway start';
  const res = (await t.create(d.id)).json();
  assert.equal(t.kanban.created.at(-1)!.max_runtime_seconds, 900);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /gateway/i);
});

// ---- listing / isolation ----------------------------------------------------------------

test('list shows only chief-assigned top-level tasks of THIS department board', async () => {
  const t = questApp();
  const a = await t.readyDept('A');
  const b = await t.readyDept('B');
  const qa = await seedQuest(t, a);
  await seedQuest(t, b);
  t.kanban.seedTask(a.board, { title: 'stray top-level for someone else', assignee: 'somebody' });
  const list = (await t.get(Q(a.id))).json().quests;
  assert.deepEqual(list.map((q: any) => q.id), [qa.root.id], 'worker tasks, foreign assignees and other boards are not quests');
});

test('quest ids from another department, worker tasks, and malformed ids are all 404', async () => {
  const t = questApp();
  const a = await t.readyDept('A');
  const b = await t.readyDept('B');
  const qa = await seedQuest(t, a);
  const qb = await seedQuest(t, b);
  for (const suffix of ['', '/tasks', '/activity', '/results', '/cancellation']) {
    assert.equal((await t.get(Q(a.id, qb.root.id) + suffix)).statusCode, 404, `cross-department ${suffix}`);
    assert.equal((await t.get(Q(a.id, qa.kids[0]!.id) + suffix)).statusCode, 404, `worker task as quest ${suffix}`);
    assert.equal((await t.get(Q(a.id, '..%2f..%2fetc') + suffix)).statusCode, 404, `malformed ${suffix}`);
  }
  assert.equal((await t.app.inject({ method: 'POST', url: Q(a.id, qb.root.id) + '/cancel' })).statusCode, 404);
  assert.equal(t.kanban.statusOf(b.board, qb.root.id), 'ready', 'the other department was not touched');
  assert.equal((await t.get(Q('00000000-0000-4000-8000-000000000000'))).statusCode, 404);
});

// ---- tree / status ---------------------------------------------------------------------

test('quest lifecycle: queued -> planning -> running -> completed, derived from the whole tree', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const questId = (await t.create(d.id)).json().questId;
  const status = async () => (await t.get(Q(d.id, questId))).json();

  assert.equal((await status()).status, 'queued');

  t.kanban.startRun(d.board, questId, d.chief);
  assert.equal((await status()).status, 'planning', 'chief running, no workers yet');

  const w1 = t.kanban.seedTask(d.board, { title: 'W1', assignee: d.worker, parents: [questId] });
  const w2 = t.kanban.seedTask(d.board, { title: 'W2', assignee: d.worker, parents: [questId] });
  assert.equal((await status()).status, 'running');

  t.kanban.complete(d.board, questId, 'created W1 and W2');
  let s = await status();
  assert.equal(s.status, 'running', 'chief done but workers have not finished');
  assert.equal(s.flags.planningComplete, true);
  assert.equal(s.flags.delegated, true);
  assert.equal(s.completedAt, null);

  t.kanban.startRun(d.board, w1.id, d.worker);
  t.kanban.complete(d.board, w1.id, 'w1 done');
  assert.equal((await status()).status, 'running');
  assert.deepEqual([(await status()).counts.done, (await status()).counts.tasks], [2, 3]);

  t.kanban.startRun(d.board, w2.id, d.worker);
  t.kanban.complete(d.board, w2.id, 'w2 done');
  s = await status();
  assert.equal(s.status, 'completed');
  assert.ok(s.completedAt);
  assert.ok(!/percent|progress/i.test(JSON.stringify(s)));
});

test('detail returns the real hierarchy: roles, depth, parent/child ids, nested descendants', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { root, kids } = await seedQuest(t, d, 2);
  const grand = t.kanban.seedTask(d.board, { title: 'Grandchild', assignee: d.worker, parents: [kids[0]!.id] });
  const detail = (await t.get(Q(d.id, root.id))).json();
  const byId = Object.fromEntries(detail.tasks.map((n: any) => [n.id, n]));
  assert.equal(detail.tasks.length, 4);
  assert.deepEqual([byId[root.id].role, byId[root.id].depth], ['chief', 0]);
  assert.deepEqual([byId[kids[0]!.id].role, byId[kids[0]!.id].depth], ['worker', 1]);
  assert.deepEqual([byId[grand.id].role, byId[grand.id].depth], ['worker', 2]);
  assert.deepEqual(byId[grand.id].parentIds, [kids[0]!.id]);
  assert.deepEqual(byId[root.id].childIds.sort(), kids.map((k) => k.id).sort());
  assert.equal(detail.objective, 'Build it');
  const tasks = (await t.get(Q(d.id, root.id) + '/tasks')).json();
  assert.equal(tasks.tasks.length, 4);
});

test('a grandchild that is still running keeps the quest running even if chief and children are done', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { root, kids } = await seedQuest(t, d, 1);
  const grand = t.kanban.seedTask(d.board, { title: 'G', assignee: d.worker, parents: [kids[0]!.id] });
  t.kanban.complete(d.board, root.id, 'planned');
  t.kanban.complete(d.board, kids[0]!.id, 'child done');
  t.kanban.startRun(d.board, grand.id, d.worker);
  assert.equal((await t.get(Q(d.id, root.id))).json().status, 'running');
  t.kanban.complete(d.board, grand.id, 'done');
  assert.equal((await t.get(Q(d.id, root.id))).json().status, 'completed');
});

test('failed worker -> quest failed with the error shown; foreign assignees are reported as violations', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { root, kids } = await seedQuest(t, d, 2);
  t.kanban.seedTask(d.board, { title: 'Sneaky', assignee: 'some-other-profile', parents: [root.id] });
  t.kanban.complete(d.board, root.id, 'planned');
  t.kanban.startRun(d.board, kids[0]!.id, d.worker);
  t.kanban.fail(d.board, kids[0]!.id, 'crashed while reading /home/urataps/.hermes/kanban/boards/x/secret.txt');
  t.kanban.complete(d.board, kids[1]!.id, 'ok');
  const detail = (await t.get(Q(d.id, root.id))).json();
  assert.equal(detail.flags.hasFailures, true);
  assert.equal(detail.violations.length, 1);
  assert.match(detail.violations[0], /some-other-profile/);
  assert.equal(detail.flags.unauthorizedAssignees, true);
  const failed = detail.tasks.find((n: any) => n.id === kids[0]!.id);
  assert.equal(failed.failed, true);
  assert.ok(!failed.error.includes('/home/'), 'host path scrubbed from errors');
  assert.match(failed.error, /<path>\/secret\.txt/);
});

// ---- results / attachments / activity ----------------------------------------------------

test('results include the chief summary, worker summaries, errors and attachments, without any host path', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { root, kids } = await seedQuest(t, d, 2);
  t.kanban.complete(d.board, root.id, 'Created two tasks');
  t.kanban.complete(d.board, kids[0]!.id, 'Wrote /home/urataps/.hermes/kanban/boards/x/workspaces/t_1/result.txt');
  t.kanban.attach(d.board, kids[0]!.id, 'result.txt', 'hello');
  const res = await t.get(Q(d.id, root.id) + '/results');
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('/home/'), 'no absolute host path anywhere');
  assert.ok(!res.body.includes('stored_path'));
  const body = res.json();
  assert.equal(body.chiefSummary, 'Created two tasks');
  const w = body.tasks.find((x: any) => x.taskId === kids[0]!.id);
  assert.match(w.summary, /<path>\/result\.txt/);
  assert.equal(w.attachments[0].filename, 'result.txt');
  assert.equal(w.attachments[0].downloadUrl, `/api/departments/${d.id}/quests/${root.id}/attachments/${w.attachments[0].id}`);
});

test('attachment download is proxied, authorized against the quest tree, and served as a safe download', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const mine = await seedQuest(t, d, 1);
  const other = await seedQuest(t, d, 1);
  const a = t.kanban.attach(d.board, mine.kids[0]!.id, '../../evil".html', '<script>alert(1)</script>');
  const b = t.kanban.attach(d.board, other.kids[0]!.id, 'other.txt', 'not yours');

  const ok = await t.get(`${Q(d.id, mine.root.id)}/attachments/${a.id}`);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body, '<script>alert(1)</script>');
  assert.equal(ok.headers['content-type'], 'application/octet-stream');
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.match(String(ok.headers['content-disposition']), /^attachment; filename="[^"/\\]*"/);
  assert.ok(!String(ok.headers['content-disposition']).includes('..'), 'no path traversal in the file name');
  assert.ok(!String(ok.headers['content-disposition']).includes('/'));

  // an attachment of a different quest on the same board, a bogus id, and a path-like id are all refused
  for (const id of [b.id, 999, 'abc', '1%2f..%2f2', '-1', '1.5']) {
    assert.equal((await t.get(`${Q(d.id, mine.root.id)}/attachments/${id}`)).statusCode, 404, String(id));
  }
});

test('an attachment of another department is not reachable through this one', async () => {
  const t = questApp();
  const a = await t.readyDept('A');
  const b = await t.readyDept('B');
  const qa = await seedQuest(t, a, 1);
  const qb = await seedQuest(t, b, 1);
  const att = t.kanban.attach(b.board, qb.kids[0]!.id, 'secret.txt', 'B only');
  assert.equal((await t.get(`${Q(a.id, qa.root.id)}/attachments/${att.id}`)).statusCode, 404);
  assert.equal((await t.get(`${Q(a.id, qb.root.id)}/attachments/${att.id}`)).statusCode, 404);
});

test('activity is ordered, drops Hermes plumbing events, and never forwards raw payloads or paths', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { root, kids } = await seedQuest(t, d, 1);
  t.kanban.startRun(d.board, root.id, d.chief);
  t.kanban.complete(d.board, root.id, 'planned in /home/urataps/work/dir/plan.md');
  t.kanban.attach(d.board, kids[0]!.id, 'out.txt', 'x');
  const { events } = (await t.get(Q(d.id, root.id) + '/activity')).json();
  const kinds = events.map((e: any) => e.kind);
  assert.ok(kinds.includes('created') && kinds.includes('completed') && kinds.includes('attached'));
  assert.deepEqual([...events].map((e: any) => e.at), [...events].map((e: any) => e.at).sort());
  const done = events.find((e: any) => e.kind === 'completed');
  assert.match(done.detail, /<path>\/plan\.md/);
  assert.ok(!JSON.stringify(events).includes('/home/'));
  assert.ok(events.every((e: any) => Object.keys(e).sort().join() === 'at,detail,id,kind,label,taskId,taskTitle'));
});

// ---- Hermes offline ---------------------------------------------------------------------

test('Hermes offline: quest reads answer 503 and nothing is fabricated', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { root } = await seedQuest(t, d, 1);
  t.kanban.online = false;
  for (const url of [Q(d.id), Q(d.id, root.id), Q(d.id, root.id) + '/activity', Q(d.id, root.id) + '/results', Q(d.id, root.id) + '/cancellation']) {
    const res = await t.get(url);
    assert.equal(res.statusCode, 503, url);
    assert.equal(res.json().error, 'hermes_unavailable');
  }
  assert.equal((await t.create(d.id)).statusCode, 503);
  assert.equal((await t.app.inject({ method: 'POST', url: Q(d.id, root.id) + '/cancel' })).statusCode, 503);
  t.kanban.online = true;
  assert.equal((await t.get(Q(d.id))).json().quests.length, 1, 'real data is back after reconnect');
});

test('without a Kanban integration configured the quest routes answer 503', async () => {
  const { buildServices } = await import('./app.ts');
  const { openDb } = await import('./db/db.ts');
  const { FakeHermes } = await import('./testing/fakeHermes.ts');
  const { app } = buildServices(openDb(':memory:'), new FakeHermes());
  const dept = (await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'A' } })).json();
  assert.equal((await app.inject(Q(dept.id))).statusCode, 409, 'unprovisioned department');
});
