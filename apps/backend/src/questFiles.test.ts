import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questApp } from './testUtils.ts';

const upload = (t: ReturnType<typeof questApp>, dept: string, quest: string, name: string, body: Buffer | string, type = 'text/csv') =>
  t.app.inject({
    method: 'POST', url: `/api/departments/${dept}/quests/${quest}/files`, payload: Buffer.from(body),
    headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name), 'x-content-type': type },
  });

test('a job brief lists the CEO\'s reference files and tells the lead to read them first', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { questId } = (await t.create(d.id, { files: ['prices.csv', 'brief notes.md'] })).json();
  const body = (await t.kanban.getTask(d.board, questId)).task.body!;
  assert.match(body, /## Reference files from the CEO\n- prices\.csv\n- brief notes\.md\n/);
  assert.match(body, /kanban_attachments/);
  assert.ok(body.indexOf('Reference files') < body.indexOf('## How to execute'), 'read before the workflow');
  const plain = (await t.kanban.getTask(d.board, (await t.create(d.id)).json().questId)).task.body!;
  assert.doesNotMatch(plain, /Reference files/, 'no section without files');
  assert.equal((await t.create(d.id, { files: Array.from({ length: 11 }, (_, i) => `f${i}`) })).statusCode, 400, 'at most 10');
});

test('uploading attaches the file to the quest root in Hermes, marked as the CEO\'s', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { questId } = (await t.create(d.id, { files: ['prices.csv'] })).json();
  const res = await upload(t, d.id, questId, 'prices.csv', 'sku,price\nA,1\n');
  assert.equal(res.statusCode, 201, res.body);
  const { attachment } = res.json();
  assert.equal(attachment.filename, 'prices.csv');
  assert.equal(attachment.fromCeo, true);
  assert.equal(attachment.contentType, 'text/csv');
  assert.ok(!JSON.stringify(res.json()).includes('/home/'), 'no host path');
  const raw = await t.kanban.getTask(d.board, questId);
  assert.equal(raw.attachments.length, 1);
  assert.equal(raw.comments.length, 0, 'announced in the brief: no extra comment');
  const results = (await t.get(`/api/departments/${d.id}/quests/${questId}/results`)).json();
  assert.equal(results.tasks[0].attachments[0].fromCeo, true);
  const dl = await t.get(attachment.downloadUrl);
  assert.equal(dl.body, 'sku,price\nA,1\n', 'the file round-trips');
});

test('a file the brief did not announce reaches the lead as a comment too', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const { questId } = (await t.create(d.id)).json();
  assert.equal((await upload(t, d.id, questId, '../../etc/later.pdf', '%PDF-1.4', 'application/pdf')).statusCode, 201);
  const raw = await t.kanban.getTask(d.board, questId);
  assert.equal(raw.attachments[0]!.filename, 'later.pdf', 'path parts are dropped');
  assert.match(raw.comments[0]!.body, /"later\.pdf"/);
});

test('uploads are refused for foreign, finished or bad requests', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const other = await t.readyDept('Ops');
  const { questId } = (await t.create(d.id)).json();
  assert.equal((await upload(t, other.id, questId, 'a.txt', 'x')).statusCode, 404, 'another department\'s job');
  const child = t.kanban.seedTask(d.board, { title: 'sub', assignee: d.teammate, parents: [questId] });
  assert.equal((await upload(t, d.id, child.id, 'a.txt', 'x')).statusCode, 404, 'only a quest root');
  assert.equal((await upload(t, d.id, questId, 'a.txt', '')).statusCode, 400, 'empty');
  assert.equal((await upload(t, d.id, questId, '', 'x')).statusCode, 400, 'no name');
  assert.equal((await upload(t, d.id, questId, 'big.bin', Buffer.alloc(25 * 1024 * 1024 + 1))).statusCode, 413, 'over the Hermes cap');
  const json = await t.app.inject({ method: 'POST', url: `/api/departments/${d.id}/quests/${questId}/files`, payload: { a: 1 } });
  assert.equal(json.statusCode, 400, 'JSON is not a file');
  t.kanban.complete(d.board, questId, 'done');
  assert.equal((await upload(t, d.id, questId, 'a.txt', 'x')).statusCode, 409, 'finished job');
  assert.equal((await t.kanban.getTask(d.board, questId)).attachments.length, 0);
});

test('the file archive lists every file on the floor\'s jobs, newest first, with who made it', async () => {
  const t = questApp();
  const d = await t.readyDept('Eng');
  const other = await t.readyDept('Ops');
  const { questId } = (await t.create(d.id, { title: 'Pricing' })).json();
  await upload(t, d.id, questId, 'brief.md', '# brief');
  const kid = t.kanban.seedTask(d.board, { title: 'Scrape', assignee: d.teammate, parents: [questId] });
  t.kanban.attach(d.board, kid.id, 'prices.csv', 'a,b');
  const res = await t.get(`/api/departments/${d.id}/files`);
  assert.equal(res.statusCode, 200, res.body);
  const { files, truncated } = res.json();
  assert.equal(truncated, false);
  assert.deepEqual(files.map((f: { filename: string; taskTitle: string; questTitle: string; agentKey: string | null; fromCeo: boolean }) => [f.filename, f.questTitle, f.taskTitle, f.agentKey, f.fromCeo]),
    [['prices.csv', 'Pricing', 'Scrape', 'W-01', false], ['brief.md', 'Pricing', 'Pricing', null, true]]);
  assert.ok(!res.body.includes('/home/'), 'no host path');
  assert.equal((await t.get(files[0].downloadUrl)).body, 'a,b', 'downloads through the job route');
  assert.deepEqual((await t.get(`/api/departments/${other.id}/files`)).json().files, [], 'only this floor\'s jobs');
});
