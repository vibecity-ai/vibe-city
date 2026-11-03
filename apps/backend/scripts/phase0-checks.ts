// Phase 0 runtime checks: WS events, concurrency cap, cancellation, file-tool denial, offline behavior.
// Requires: dashboard running with HERMES_DASHBOARD_SESSION_TOKEN, gateway running,
// profile $PROFILE (terminal enabled, file disabled), kanban.max_in_progress_per_profile=1.
import { KanbanClient } from '../src/hermes/kanbanClient.ts';

const base = process.env.HERMES_URL ?? 'http://127.0.0.1:9119';
const token = process.env.HERMES_DASHBOARD_SESSION_TOKEN!;
const profile = process.env.PROFILE ?? 'vc-p0';
const k = new KanbanClient({ baseUrl: base, sessionToken: token });
const board = `vc-p0-${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(...a);

await k.createBoard(board, 'Phase0 checks');

// 1. WebSocket events
const events: { id: number; kind: string; task_id?: string }[] = [];
const wsUrl = new URL(`/api/plugins/kanban/events?since=0&board=${board}&token=${token}`, base.replace('http', 'ws'));
const ws = new WebSocket(wsUrl);
let wsOpen = false;
ws.onopen = () => (wsOpen = true);
ws.onmessage = (m) => { try { const j = JSON.parse(String(m.data)); events.push(j); } catch { /* ignore */ } };
ws.onerror = () => log('ws error');

// 2. concurrency: two long tasks, same profile, cap=1
const mk = (title: string, body: string) => k.createTask(board, { title, body, assignee: profile }).then((r) => r.task.id);
const t1 = await mk('long A', 'Use the terminal tool to run `sleep 90`, then complete with summary "slept".');
const t2 = await mk('long B', 'Use the terminal tool to run `sleep 90`, then complete with summary "slept".');
const status = async () => Object.fromEntries((await k.getBoard(board)).columns.flatMap((c) => c.tasks.map((t) => [t.id, t.status])));
let maxRunning = 0;
for (let i = 0; i < 40; i++) {
  const s = await status();
  const running = Object.values(s).filter((v) => v === 'running').length;
  maxRunning = Math.max(maxRunning, running);
  if (Object.values(s).includes('running')) break;
  await sleep(5000);
}
await sleep(15000);
const s2 = await status();
maxRunning = Math.max(maxRunning, Object.values(s2).filter((v) => v === 'running').length);
log('CONCURRENCY statuses', s2, 'maxRunning', maxRunning);

// 3. cancellation
const runningId = Object.entries(s2).find(([, v]) => v === 'running')?.[0];
if (runningId) {
  const runs = await fetch(new URL(`/api/plugins/kanban/workers/active?board=${board}`, base), { headers: { 'X-Hermes-Session-Token': token } }).then((r) => r.json());
  log('ACTIVE', JSON.stringify(runs).slice(0, 400));
  const runId = (runs.workers ?? runs.runs ?? runs)[0]?.run_id ?? (runs.workers ?? runs.runs ?? runs)[0]?.id;
  const res = await fetch(new URL(`/api/plugins/kanban/runs/${runId}/terminate?board=${board}`, base), {
    method: 'POST', headers: { 'X-Hermes-Session-Token': token, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'phase0 cancel' }),
  });
  log('TERMINATE', res.status, await res.text());
  await sleep(10000);
  log('AFTER CANCEL', await status());
}

// 4. file-tool denial
const t3 = await k.createTask(board, { title: 'file probe', assignee: profile, body: 'Try to write a file notes.txt with a file-writing tool (not terminal). Report in your completion summary whether a file tool was available.' });
for (let i = 0; i < 60; i++) { const s = await status(); if (s[t3.task.id] === 'done' || s[t3.task.id] === 'blocked') break; await sleep(5000); }
log('FILEPROBE', (await k.getTask(board, t3.task.id)).task.status, JSON.stringify(await k.getTask(board, t3.task.id)).slice(0, 0));

log('WS open', wsOpen, 'events', events.length, 'kinds', [...new Set(events.map((e) => e.kind))].join(','), 'sample', JSON.stringify(events[0]));
ws.close();
log('BOARD', board, 'tasks', t1, t2, t3.task.id);
