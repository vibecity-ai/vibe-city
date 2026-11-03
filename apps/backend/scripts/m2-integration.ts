// Milestone 2 integration test against REAL Hermes (not part of `npm test`).
//
// Requirements: `hermes` on PATH, the Hermes gateway running (`hermes gateway status`), and model credentials
// configured in the default profile (profiles are cloned from it). The script starts its OWN dashboard on
// port M2_PORT (default 9129) with a random session token so it can stop/restart it, and removes every board and
// profile it creates. It makes real model calls (one chief run and two worker runs).
//
//   npm run m2:integration -w @vibe-city/backend
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db.ts';
import { buildServices } from '../src/app.ts';
import { RealHermesRuntime } from '../src/hermes/realRuntime.ts';
import { KanbanClient } from '../src/hermes/kanbanClient.ts';
import { RunTracker } from '../src/domain/runTracker.ts';
import { DepartmentService } from '../src/domain/departmentService.ts';

const port = Number(process.env.M2_PORT ?? 9129);
const baseUrl = `http://127.0.0.1:${port}`;
const token = randomBytes(24).toString('base64url');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hermesCli = (...a: string[]) => execFileSync('hermes', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let dash = null as ChildProcess | null;
const results: { name: string; ok: boolean; note?: string }[] = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note || undefined });
    console.log(`PASS  ${name}${note ? ` — ${note}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, note: (e as Error).message });
    console.log(`FAIL  ${name} — ${(e as Error).message}`);
  }
}
const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

async function startDashboard() {
  dash = spawn('hermes', ['dashboard', '--no-open', '--port', String(port)], {
    env: { ...process.env, HERMES_DASHBOARD_SESSION_TOKEN: token }, stdio: 'ignore', cwd: '/tmp',
  });
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
  const { app, provisioning } = buildServices(db, hermes);
  const kanban = new KanbanClient({ baseUrl, sessionToken: token });
  const j = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => {
    const r = await app.inject({ method, url, payload });
    return { code: r.statusCode, body: r.json() as any };
  };

  await check('health: dashboard up, token accepted, gateway running', async () => {
    const { body } = await j('GET', '/api/runtime/health');
    assert(body.hermes.dashboard === 'up' && body.hermes.auth === 'ok', JSON.stringify(body));
    assert(body.hermes.gateway === 'running', 'the Hermes gateway is not running: start it with `hermes gateway run` (workers need it)');
    return `Hermes ${body.hermes.version}`;
  });

  // Department: workers may use the file toolset but never terminal/web.
  const dept = (await j('POST', '/api/departments', {
    name: 'M2 Integration', purpose: 'Integration test department',
    inventory: { allowedToolsets: ['file'], allowedSkillIds: [], limits: { maxConcurrentWorkers: 1 } },
  })).body;
  const names = { board: dept.hermesBoardSlug as string };
  created.boards.add(names.board);

  let chief = '', worker = '';
  await check('provision: department becomes ready with verified board + chief + worker', async () => {
    const r = await j('POST', `/api/departments/${dept.id}/provision`);
    assert(r.code === 200 && r.body.state === 'ready', JSON.stringify(r.body));
    chief = r.body.chief.ref; worker = r.body.worker.ref;
    created.profiles.add(chief); created.profiles.add(worker);
    assert([r.body.board, r.body.chief, r.body.worker].every((x: any) => x.verified), 'unverified resource');
    assert(chief !== worker, 'chief and worker must differ');
  });

  await check('Hermes really contains the board and both profiles (independent check)', async () => {
    const boards = hermesCli('kanban', 'boards', 'list');
    assert(boards.includes(names.board), 'board missing in `hermes kanban boards list`');
    const profiles = hermesCli('profile', 'list');
    assert(profiles.includes(chief) && profiles.includes(worker), 'profiles missing in `hermes profile list`');
  });

  await check('inventory applied: worker has file+kanban only; chief has kanban only; only the essential Hermes skill', async () => {
    const enabled = (p: string) => Object.entries(parseTools(hermesCli('-p', p, 'tools', 'list'))).filter(([, v]) => v).map(([k]) => k).sort();
    const w = enabled(worker), c = enabled(chief);
    assert(JSON.stringify(w) === JSON.stringify(['file', 'kanban']), `worker toolsets: ${w}`);
    assert(JSON.stringify(c) === JSON.stringify(['kanban']), `chief toolsets: ${c}`);
    const skills = execFileSync('hermes', ['-p', worker, 'skills', 'list', '--enabled-only'], { encoding: 'utf8', env: { ...process.env, COLUMNS: '250', NO_COLOR: '1' } });
    const enabledSkills = skills.split('\n').filter((l) => l.trimStart().startsWith('│')).map((l) => l.split('│')[1]!.trim());
    assert(JSON.stringify(enabledSkills) === JSON.stringify(['hermes-agent']), `worker enabled skills: ${enabledSkills}`);
    const soul = readFileSync(join(homedir(), '.hermes', 'profiles', worker, 'SOUL.md'), 'utf8');
    assert(soul.includes('vibe-city:begin') && soul.includes('Worker Agent'), 'instruction block missing');
    return `worker=${w.join(',')} chief=${c.join(',')}`;
  });

  await check('effective inventory reports enforced toolsets and unsupported gaps', async () => {
    const { body } = await j('GET', `/api/departments/${dept.id}/effective-inventory`);
    const tool = body.worker.entries.find((e: any) => e.capability === 'toolsets.behavior-tested');
    assert(tool.status === 'enforced' && JSON.stringify(tool.effective) === JSON.stringify(['file']), JSON.stringify(tool));
    assert(body.departmentWide.find((e: any) => e.capability === 'files.isolation').status === 'unsupported', 'isolation overclaimed');
    const conc = body.departmentWide.find((e: any) => e.capability === 'limits.maxConcurrentWorkers');
    return `concurrency: ${conc.status} (host cap ${conc.effective})`;
  });

  await check('provisioning is idempotent against real Hermes (no duplicate board/profiles)', async () => {
    const before = [hermesCli('kanban', 'boards', 'list').split(names.board).length, hermesCli('profile', 'list').split('vc-').length];
    const r = await j('POST', `/api/departments/${dept.id}/provision`);
    assert(r.body.state === 'ready', JSON.stringify(r.body.error));
    const after = [hermesCli('kanban', 'boards', 'list').split(names.board).length, hermesCli('profile', 'list').split('vc-').length];
    assert(JSON.stringify(before) === JSON.stringify(after), `resource counts changed ${before} -> ${after}`);
  });

  // ---- chief -> worker delegation (real model runs) ----
  let questId = '';
  await check('chief delegates: quest -> chief creates worker tasks -> worker executes -> result retrievable', async () => {
    const body = [
      `You are the department chief. Do NOT do the work yourself. Create exactly TWO child tasks with your kanban create tool,`,
      `each assigned to the profile "${worker}" with parents set to this task's id:`,
      `1. Title "Write result": use the file tool to create result.txt in your task workspace containing the text "m2 ok", then complete with a one-line summary.`,
      `2. Title "Boundary probe": try to run the shell command 'echo x' with a terminal tool. Complete with a summary that contains the exact token TERMINAL=available or TERMINAL=unavailable.`,
      `Then complete your own task with a summary listing the child task ids.`,
    ].join('\n');
    const { task } = await kanban.createTask(dept.hermesBoardSlug, { title: 'Quest: integration', body, assignee: chief, idempotency_key: `m2-${dept.id}` });
    questId = task.id;
    const deadline = Date.now() + 9 * 60_000;
    let all: any[] = [];
    while (Date.now() < deadline) {
      all = (await kanban.getBoard(dept.hermesBoardSlug)).columns.flatMap((c) => c.tasks);
      if (all.length >= 3 && all.every((t) => t.status === 'done' || t.status === 'blocked')) break;
      await sleep(5000);
    }
    assert(all.length === 3, `expected quest + 2 children, got ${all.length}`);
    assert(all.every((t) => t.status === 'done'), `statuses: ${all.map((t) => `${t.title}:${t.status}`).join(', ')}`);
    return all.map((t) => `${t.title}:${t.status}`).join(', ');
  });

  await check('run references: real task/run ids recorded; chief and worker profiles match the department', async () => {
    const tracker = new RunTracker(db, new DepartmentService(db, (db.prepare('SELECT id FROM company').get() as { id: string }).id));
    const { recorded, violations } = await tracker.observe(dept.id, kanban, questId);
    assert(violations.length === 0, violations.join('; '));
    const chiefRuns = recorded.filter((r) => r.role === 'chief'), workerRuns = recorded.filter((r) => r.role === 'worker');
    assert(chiefRuns.length >= 1 && workerRuns.length >= 2, `runs: chief=${chiefRuns.length} worker=${workerRuns.length}`);
    assert(chiefRuns.every((r) => r.profileRef === chief) && workerRuns.every((r) => r.profileRef === worker), 'profile mismatch');
    assert(recorded.every((r) => r.hermesRunRef && r.state === 'completed'), JSON.stringify(recorded.map((r) => r.state)));
    return recorded.map((r) => `${r.role}:task ${r.hermesTaskRef}/run ${r.hermesRunRef}`).join(' | ');
  });

  await check('restriction held: worker reported TERMINAL=unavailable; file result retrieved', async () => {
    const q = await kanban.getTask(dept.hermesBoardSlug, questId);
    const kids = await Promise.all(q.links.children.map((id) => kanban.getTask(dept.hermesBoardSlug, id)));
    const probe = kids.find((k) => k.task.title === 'Boundary probe')!;
    const write = kids.find((k) => k.task.title === 'Write result')!;
    const summary = String(probe.task.latest_summary ?? probe.runs.at(-1)?.summary ?? '');
    assert(/TERMINAL=unavailable/.test(summary), `probe summary: ${summary}`);
    assert(write.attachments.some((a) => a.filename === 'result.txt'), `attachments: ${JSON.stringify(write.attachments)}`);
    return `probe: ${summary.slice(0, 80)}`;
  });

  // ---- offline / reconnect ----
  await check('Hermes offline -> department disconnected (not failed); reconnect -> ready with data intact', async () => {
    await stopDashboard();
    await provisioning.reconcile(dept.id);
    const off = await j('GET', `/api/departments/${dept.id}/provisioning`);
    assert(off.body.state === 'disconnected' && off.body.error.code === 'hermes_unreachable', JSON.stringify(off.body));
    const h = await j('GET', '/api/runtime/health');
    assert(h.body.hermes.dashboard === 'down', 'health should report down');
    const prof = await j('GET', `/api/departments/${dept.id}/profiles`);
    assert(prof.body.reachable === false && prof.body.chief.ref === chief, 'stored refs must remain visible offline');
    await startDashboard();
    await provisioning.reconcile(dept.id);
    const on = await j('GET', `/api/departments/${dept.id}/provisioning`);
    assert(on.body.state === 'ready' && on.body.error === null, JSON.stringify(on.body));
    const q = await kanban.getTask(dept.hermesBoardSlug, questId);
    assert(q.task.status === 'done', 'task data should be recovered from Hermes');
  });

  await check('reconcile heals a deleted Vibe City-created profile', async () => {
    hermesCli('profile', 'delete', worker, '-y');
    await provisioning.reconcile(dept.id);
    const st = (await j('GET', `/api/departments/${dept.id}/provisioning`)).body;
    assert(st.state === 'ready' && st.worker.verified, JSON.stringify(st));
    assert(hermesCli('profile', 'list').includes(worker), 'worker profile not recreated');
  });

  await check('safeguard: an existing profile is left untouched until the user confirms (real Hermes)', async () => {
    const existing = `vc-m2-existing-${randomBytes(3).toString('hex')}`;
    hermesCli('profile', 'create', existing, '--clone', '--no-alias');
    created.profiles.add(existing);
    const snap = () => hermesCli('-p', existing, 'tools', 'list') + readFileSync(join(homedir(), '.hermes', 'profiles', existing, 'SOUL.md'), 'utf8');
    const before = snap();
    const d3 = (await j('POST', '/api/departments', { name: 'M2 Consent', inventory: { allowedToolsets: [] } })).body;
    created.boards.add(d3.hermesBoardSlug);
    await j('PATCH', `/api/departments/${d3.id}`, { workerProfileRef: existing });
    const refused = (await j('POST', `/api/departments/${d3.id}/provision`)).body;
    assert(refused.state === 'error' && refused.error.code === 'confirmation_required', JSON.stringify(refused.error));
    assert(snap() === before, 'existing profile was modified without consent');
    assert(!hermesCli('kanban', 'boards', 'list').includes(d3.hermesBoardSlug), 'a board was created before consent');
    await j('PATCH', `/api/departments/${d3.id}`, { confirmModifyProfiles: [existing] });
    const ok = (await j('POST', `/api/departments/${d3.id}/provision`)).body;
    created.profiles.add(ok.chief.ref); // managed chief created by this provisioning: remove it in cleanup
    assert(ok.state === 'ready' && ok.worker.origin === 'associated' && ok.worker.modificationConfirmed === true, JSON.stringify(ok));
    assert(snap() !== before, 'confirmed profile should now carry the department restrictions');
  });

  await check('an invalid association is reported as an error, not as unavailability', async () => {
    const d2 = (await j('POST', '/api/departments', { name: 'M2 Bad Profile' })).body;
    created.boards.add(d2.hermesBoardSlug);
    await j('PATCH', `/api/departments/${d2.id}`, { chiefProfileRef: 'vc-does-not-exist' });
    const r = await j('POST', `/api/departments/${d2.id}/provision`);
    assert(r.body.state === 'error' && r.body.error.code === 'profile_not_found' && r.body.error.retryable === false, JSON.stringify(r.body));
  });
} finally {
  // cleanup: only resources created by this run
  try { await stopDashboard(); } catch { /* ignore */ }
  for (const b of created.boards) { try { hermesCli('kanban', 'boards', 'rm', b, '--delete'); } catch { /* may not exist */ } }
  for (const p of created.profiles) { try { hermesCli('profile', 'delete', p, '-y'); } catch { /* may not exist */ } }
  dash?.kill('SIGKILL');
}

function parseTools(out: string): Record<string, boolean> {
  const res: Record<string, boolean> = {};
  for (const line of out.split('\n')) {
    const m = /^\s*[✓✗]\s+(enabled|disabled)\s+([a-z0-9_]+)\b/.exec(line);
    if (m) res[m[2]!] = m[1] === 'enabled';
  }
  return res;
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
