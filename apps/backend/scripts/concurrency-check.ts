import { KanbanClient } from '../src/hermes/kanbanClient.ts';
const k = new KanbanClient({ baseUrl: 'http://127.0.0.1:9119', sessionToken: process.env.HERMES_DASHBOARD_SESSION_TOKEN! });
const board = `vc-cc-${Date.now().toString(36)}`;
await k.createBoard(board, 'cc');
const body = 'Use the terminal tool to run `sleep 60`, then complete with summary "slept".';
const ids = [] as string[];
for (const n of ['A', 'B', 'C']) ids.push((await k.createTask(board, { title: `long ${n}`, body, assignee: 'vc-p0' })).task.id);
let max = 0;
for (let i = 0; i < 14; i++) {
  const ts = (await k.getBoard(board)).columns.flatMap((c) => c.tasks);
  const r = ts.filter((t) => t.status === 'running').length;
  max = Math.max(max, r);
  console.log(i, ts.map((t) => t.status).join(','));
  await new Promise((r) => setTimeout(r, 10000));
}
console.log('BOARD', board, 'maxRunning', max, ids.join(' '));
