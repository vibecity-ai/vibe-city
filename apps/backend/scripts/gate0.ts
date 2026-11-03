// Headless Gate 0 check: needs `hermes dashboard` (with HERMES_DASHBOARD_SESSION_TOKEN) and the gateway running,
// plus existing profiles named by CHIEF / WORKER env vars. Creates a quest for the chief and waits for children.
import { KanbanClient } from '../src/hermes/kanbanClient.ts';

const baseUrl = process.env.HERMES_URL ?? 'http://127.0.0.1:9119';
const sessionToken = process.env.HERMES_DASHBOARD_SESSION_TOKEN;
const chief = process.env.CHIEF ?? 'vc-chief';
const worker = process.env.WORKER ?? 'vc-worker';
if (!sessionToken) throw new Error('set HERMES_DASHBOARD_SESSION_TOKEN');

const k = new KanbanClient({ baseUrl, sessionToken });
const board = `vc-gate0-${Date.now().toString(36)}`;
await k.createBoard(board, 'Gate 0');
const { task, warning } = await k.createTask(board, {
  title: 'Quest: write notes',
  assignee: chief,
  body: `You are the chief. Do not do the work. Create one child task (parents=[this task]) assigned to "${worker}" titled "Write notes" that creates notes.txt containing "notes ok". Then complete with the child id.`,
});
if (warning) console.warn('warning:', warning);
console.log('quest', task.id, 'on', board);
for (let i = 0; i < 120; i++) {
  const { columns } = await k.getBoard(board);
  const all = columns.flatMap((c) => c.tasks);
  console.log(all.map((t) => `${t.id}:${t.status}`).join(' '));
  if (all.length > 1 && all.every((t) => t.status === 'done')) {
    const child = all.find((t) => t.id !== task.id)!;
    const d = await k.getTask(board, child.id);
    console.log('GATE 0 OK. child summary:', d.task.latest_summary);
    console.log('attachments:', JSON.stringify(await k.listAttachments(board, child.id)));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.error('GATE 0 TIMEOUT');
process.exit(1);
