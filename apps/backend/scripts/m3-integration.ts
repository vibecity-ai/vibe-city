// Milestone 3 integration test against REAL Hermes (not part of `npm test`).
//
// Requirements: `hermes` on PATH, the Hermes gateway running, model credentials in the default profile.
// Starts its OWN dashboard on port M3_PORT (default 9139) with a random token so it can stop/restart it, provisions a
// throwaway department, runs two real quests (multi-worker, then a long-running one that is cancelled) and removes
// every board/profile it created. It makes real model calls (about 6 agent runs) and takes several minutes.
//
//   npm run m3:integration -w @vibe-city/backend
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import type { LiveMessage } from '@vibe-city/shared';
import { openDb } from '../src/db/db.ts';
import { buildServices } from '../src/app.ts';
import { RealHermesRuntime } from '../src/hermes/realRuntime.ts';
import { KanbanClient } from '../src/hermes/kanbanClient.ts';

const port = Number(process.env.M3_PORT ?? 9139);
const baseUrl = `http://127.0.0.1:${port}`;
const token = randomBytes(24).toString('base64url');
const SLEEP_MARK = `sleep 6${Math.floor(10 + Math.random() * 80)}`; // unique so pgrep cannot match anything else
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hermesCli = (...a: string[]) => execFileSync('hermes', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const pgrep = () => { try { return execFileSync('pgrep', ['-f', SLEEP_MARK], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length; } catch { return 0; } };

let dash = null as ChildProcess | null;
const results: { name: string; ok: boolean }[] = [];
const notes: string[] = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${note ? ` — ${note}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name} — ${(e as Error).message}`);
  }
}
const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

async function startDashboard() {
  dash = spawn('hermes', ['dashboard', '--no-open', '--port', String(port)], { env: { ...process.env, HERMES_DASHBOARD_SESSION_TOKEN: token }, stdio: 'ignore', cwd: '/tmp' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error('dashboard did not start');
}
async function stopDashboard() {
  dash?.kill('SIGTERM');
  for (let i = 0; i < 30; i++) {
    try { await fetch(`${baseUrl}/api/health`); await sleep(500); } catch { return; }
  }
  throw new Error('dashboard did not stop');
}

const created = { boards: new Set<string>(), profiles: new Set<string>() };

try {
  await startDashboard();
  const db = openDb(':memory:');
  const hermes = new RealHermesRuntime({ baseUrl, sessionToken: token, log: (m) => console.log('  [hermes]', m) });
  const kanban = new KanbanClient({ baseUrl, sessionToken: token });
  const { app, hub } = buildServices(db, hermes, {
    kanban,
    live: { wsBaseUrl: baseUrl.replace(/^http/, 'ws'), sessionToken: token, minBackoffMs: 300, maxBackoffMs: 2000, healthIntervalMs: 2000 },
  });
  const j = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => {
    const r = await app.inject({ method, url, payload });
    return { code: r.statusCode, body: r.json() as any, raw: r.body, headers: r.headers };
  };

  // ---- department ----
  const dept = (await j('POST', '/api/departments', {
    name: 'M3 Live', purpose: 'Milestone 3 integration',
    inventory: { allowedToolsets: ['file', 'terminal'], limits: { maxConcurrentWorkers: 3 } },
  })).body;
  created.boards.add(dept.hermesBoardSlug);
  let chief = '', worker = '';
  await check('department provisioned and ready (worker may use file + terminal)', async () => {
    const r = await j('POST', `/api/departments/${dept.id}/provision`);
    assert(r.body.state === 'ready', JSON.stringify(r.body.error));
    chief = r.body.chief.ref; worker = r.body.worker.ref;
    created.profiles.add(chief); created.profiles.add(worker);
  });
  if (!chief) throw new Error('provisioning failed; cannot continue');

  // live subscription (through the same hub the browser route uses)
  const live: LiveMessage[] = [];
  const unsubscribe = hub!.subscribe(dept.id, dept.hermesBoardSlug, (m) => live.push(m));

  // ---- quest 1: chief delegates multiple workers ----
  const clientRequestId = randomUUID();
  const Q = (id: string) => `/api/departments/${dept.id}/quests/${id}`;
  let q1 = '';
  const statusTrail: string[] = [];
  let sawChiefDoneButNotComplete = false;

  await check('quest 1: creating a quest makes a real Hermes task for the chief; retry is idempotent', async () => {
    const body = {
      clientRequestId, title: 'Three files',
      objective: 'Produce three independent text files: alpha.txt containing the word alpha, beta.txt containing the word beta, and gamma.txt containing the word gamma. Each file must be produced by its own separate worker task.',
    };
    const r1 = await j('POST', `/api/departments/${dept.id}/quests`, body);
    assert(r1.code === 201 && /^t_/.test(r1.body.questId), r1.raw);
    q1 = r1.body.questId;
    const r2 = await j('POST', `/api/departments/${dept.id}/quests`, body);
    assert(r2.body.questId === q1, 'retry with the same clientRequestId created a different task');
    const board = await kanban.listBoardTasks(dept.hermesBoardSlug, { includeArchived: true });
    assert(board.filter((t) => t.title === 'Three files').length === 1, 'duplicate task on the Hermes board');
    const raw = await kanban.getTask(dept.hermesBoardSlug, q1);
    assert(raw.task.assignee === chief, `assigned to ${raw.task.assignee}`);
    return `Hermes task ${q1}`;
  });

  await check('quest 1: runs to completion; quest status comes from the whole tree', async () => {
    const deadline = Date.now() + 10 * 60_000;
    let last: any = null;
    while (Date.now() < deadline) {
      last = (await j('GET', Q(q1))).body;
      if (statusTrail.at(-1) !== last.status) statusTrail.push(last.status);
      const root = last.tasks.find((t: any) => t.role === 'chief');
      if (root?.status === 'done' && last.status !== 'completed') sawChiefDoneButNotComplete = true;
      if (last.status === 'completed' || last.status === 'failed') break;
      await sleep(3000);
    }
    assert(last.status === 'completed', `final status ${last.status}; trail ${statusTrail.join('>')}`);
    const workers = last.tasks.filter((t: any) => t.role === 'worker');
    assert(workers.length >= 3, `expected >=3 worker tasks, got ${workers.length}`);
    assert(workers.every((t: any) => t.assignee === worker && t.status === 'done'), 'worker tasks not all done/assigned to the department worker');
    assert(last.violations.length === 0, last.violations.join('; '));
    assert(!last.flags.hasFailures, 'unexpected failures');
    if (!sawChiefDoneButNotComplete) notes.push('NOTE: never observed "chief done, quest not complete" (workers finished between polls)');
    return `trail ${statusTrail.join(' > ')}; ${workers.length} worker tasks; chief-done-but-incomplete observed: ${sawChiefDoneButNotComplete}`;
  });

  await check('quest 1: run references match the department chief/worker profiles', async () => {
    const detail = (await j('GET', Q(q1))).body;
    for (const t of detail.tasks) {
      const want = t.role === 'chief' ? chief : worker;
      assert(t.runs.length > 0, `task ${t.id} has no run`);
      assert(t.runs.every((r: any) => r.profile === want), `task ${t.id} ran as ${t.runs.map((r: any) => r.profile)}, expected ${want}`);
      assert(t.runs.every((r: any) => r.state === 'completed'), `task ${t.id} run states ${t.runs.map((r: any) => r.state)}`);
    }
  });

  await check('quest 1: results include summaries and attachments; downloads work through the backend; no host paths leak', async () => {
    const res = await j('GET', `${Q(q1)}/results`);
    assert(res.body.chiefSummary, 'no chief summary');
    const files = res.body.tasks.flatMap((t: any) => t.attachments);
    const names = files.map((f: any) => f.filename).sort();
    assert(['alpha.txt', 'beta.txt', 'gamma.txt'].every((n) => names.includes(n)), `attachments: ${names}`);
    const everything = JSON.stringify([res.body, (await j('GET', Q(q1))).body, (await j('GET', `${Q(q1)}/activity`)).body]);
    assert(!/\/home\/|\.hermes|stored_path/.test(everything), 'a host path or stored_path leaked into API output');
    const alpha = files.find((f: any) => f.filename === 'alpha.txt');
    const dl = await app.inject({ method: 'GET', url: alpha.downloadUrl });
    assert(dl.statusCode === 200 && dl.body.toLowerCase().includes('alpha'), `download: ${dl.statusCode} ${dl.body.slice(0, 40)}`);
    assert(dl.headers['content-type'] === 'application/octet-stream' && dl.headers['x-content-type-options'] === 'nosniff', 'unsafe download headers');
    return `${names.join(', ')}; downloaded alpha.txt (${dl.body.length} bytes)`;
  });

  await check('quest 1: activity timeline has real events; live bridge delivered deduplicated events', async () => {
    const { body } = await j('GET', `${Q(q1)}/activity`);
    assert(body.events.length >= 6, `only ${body.events.length} activity events`);
    const ids = live.filter((m): m is Extract<LiveMessage, { type: 'hermes.event' }> => m.type === 'hermes.event').map((m) => m.eventId);
    assert(ids.length > 0, 'no live events were relayed');
    assert(new Set(ids).size === ids.length, 'duplicate event ids relayed');
    assert(ids.every((id, i) => i === 0 || id > ids[i - 1]!), 'event ids not increasing');
    assert(!JSON.stringify(live).includes(token), 'Hermes token present in relayed messages');
    return `${body.events.length} activity events, ${ids.length} live events, states: ${[...new Set(live.filter((m) => m.type === 'connection').map((m: any) => m.state))].join(',')}`;
  });

  // ---- quest 2: cancellation of a controllable long-running task ----
  let q2 = '';
  await check('quest 2: a long-running worker task is started (controllable: sleeps)', async () => {
    const r = await j('POST', `/api/departments/${dept.id}/quests`, {
      clientRequestId: randomUUID(), title: 'Long job',
      objective: `Create exactly ONE worker task that uses the terminal tool to run the exact shell command \`${SLEEP_MARK}\` and waits for it to finish, then completes with the summary "slept".`,
    });
    assert(r.code === 201, r.raw);
    q2 = r.body.questId;
    const deadline = Date.now() + 6 * 60_000;
    while (Date.now() < deadline) {
      const d = (await j('GET', Q(q2))).body;
      if (d.tasks.some((t: any) => t.role === 'worker' && t.status === 'running') && pgrep() > 0) return `worker running; ${pgrep()} "${SLEEP_MARK}" process(es)`;
      if (d.status === 'failed') throw new Error('quest 2 failed before it could be cancelled');
      await sleep(3000);
    }
    throw new Error('worker never started the sleep command');
  });

  let claimedBefore = 0;
  await check('quest 2: cancellation is requested, then CONFIRMED from Hermes state (not from the API response)', async () => {
    const countClaims = async () => (await Promise.all((await j('GET', Q(q2))).body.tasks.map((t: any) => kanban.getTask(dept.hermesBoardSlug, t.id))))
      .flatMap((d: any) => d.events).filter((e: any) => e.kind === 'claimed').length;
    const res = await j('POST', `${Q(q2)}/cancel`);
    assert(res.code === 202, res.raw);
    claimedBefore = await countClaims();
    const deadline = Date.now() + 90_000;
    let st = res.body;
    while (st.state !== 'confirmed' && Date.now() < deadline) { await sleep(2000); st = (await j('GET', `${Q(q2)}/cancellation`)).body; }
    assert(st.state === 'confirmed', `cancellation state ${st.state}, remaining ${JSON.stringify(st.remaining)}`);
    // independent verification straight from Hermes
    const all = await kanban.listBoardTasks(dept.hermesBoardSlug, { includeArchived: true });
    const tree = (await j('GET', Q(q2))).body.tasks.map((t: any) => t.id);
    for (const id of tree) {
      const d = await kanban.getTask(dept.hermesBoardSlug, id);
      assert(['done', 'archived'].includes(d.task.status), `task ${id} is ${d.task.status}`);
      assert(d.runs.every((r) => r.ended_at !== null), `task ${id} still has an open run`);
    }
    assert(all.length > 0, 'board unexpectedly empty');
    assert((await j('GET', Q(q2))).body.status === 'cancelled', `quest status ${(await j('GET', Q(q2))).body.status}`);
    return `archived ${st.archivedTaskIds.length}, already finished ${st.alreadyFinishedTaskIds.length}`;
  });

  await check('quest 2: nothing is redispatched after cancellation (waiting past several dispatcher ticks)', async () => {
    await sleep(75_000);
    const d = (await j('GET', Q(q2))).body;
    const claims = (await Promise.all(d.tasks.map((t: any) => kanban.getTask(dept.hermesBoardSlug, t.id)))).flatMap((x: any) => x.events).filter((e: any) => e.kind === 'claimed').length;
    assert(claims === claimedBefore, `claimed events went from ${claimedBefore} to ${claims}: a task was redispatched`);
    assert(d.status === 'cancelled' && d.tasks.every((t: any) => t.status === 'done' || t.status === 'archived'), `status ${d.status}`);
  });

  await check('quest 2: the worker\'s shell command was terminated with it (no orphaned process)', async () => {
    await sleep(2000);
    const left = pgrep();
    if (left > 0) {
      notes.push(`FINDING: ${left} "${SLEEP_MARK}" process(es) survived task archive; Hermes terminated the worker but not its child command. Killing it during cleanup.`);
      throw new Error(`${left} orphaned process(es) after cancellation`);
    }
  });

  // ---- offline / reconnect ----
  await check('Hermes offline: quest APIs answer 503 (no fabricated data), live state says dashboard_offline; recovery restores real data', async () => {
    await stopDashboard();
    const list = await j('GET', `/api/departments/${dept.id}/quests`);
    assert(list.code === 503 && list.body.error === 'hermes_unavailable', list.raw);
    assert((await j('GET', Q(q1))).code === 503, 'detail should be 503');
    assert((await j('POST', `/api/departments/${dept.id}/quests`, { clientRequestId: randomUUID(), title: 'x', objective: 'y' })).code === 503, 'create should be 503');
    const deadline = Date.now() + 20_000;
    while (!live.some((m) => m.type === 'connection' && m.state === 'dashboard_offline') && Date.now() < deadline) await sleep(500);
    assert(live.some((m) => m.type === 'connection' && m.state === 'dashboard_offline'), 'live stream never reported dashboard_offline');
    const resyncsBefore = live.filter((m) => m.type === 'resync').length;
    await startDashboard();
    const d2 = Date.now() + 30_000;
    while (live.filter((m) => m.type === 'resync').length <= resyncsBefore && Date.now() < d2) await sleep(500);
    assert(live.filter((m) => m.type === 'resync').length > resyncsBefore, 'no resync after reconnect');
    const back = await j('GET', `/api/departments/${dept.id}/quests`);
    assert(back.code === 200 && back.body.quests.length === 2, `after reconnect: ${back.code} ${back.raw.slice(0, 120)}`);
    assert(back.body.quests.find((q: any) => q.id === q1).status === 'completed', 'quest 1 should still read completed');
  });

  await check('isolation: another department cannot see these quests or their attachments', async () => {
    const other = (await j('POST', '/api/departments', { name: 'M3 Other' })).body;
    const r = await j('GET', `/api/departments/${other.id}/quests/${q1}`);
    assert(r.code === 409 || r.code === 404, `other (unprovisioned) department answered ${r.code}`);
    assert((await j('GET', `/api/departments/${dept.id}/quests/t_doesnotexist`)).code === 404, 'unknown quest should be 404');
  });

  unsubscribe();
} finally {
  // cleanup: only resources created by this run
  try { await stopDashboard(); } catch { /* ignore */ }
  try { execFileSync('pkill', ['-f', SLEEP_MARK]); } catch { /* none left */ }
  for (const b of created.boards) { try { hermesCli('kanban', 'boards', 'rm', b, '--delete'); } catch { /* may not exist */ } }
  for (const p of created.profiles) { try { hermesCli('profile', 'delete', p, '-y'); } catch { /* may not exist */ } }
  dash?.kill('SIGKILL');
}

for (const n of notes) console.log(n);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
