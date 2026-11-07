/* The Vibe City MCP server (feature spec 2.4). Hermes department agents reach it over Streamable HTTP (JSON responses) with a
   per-department bearer token, which is how Vibe City knows who is asking. It exposes three narrow tools instead of
   Hermes' delegation toolset, so every cross-department request goes through Vibe City's guardrails:
     list_departments   who you can ask, and what they do
     request_quest      ask another department for work (becomes a quest on its board, or waits for the CEO)
     check_request      the state of a request you made, and the result once the other department is done
     list_task_files    the files attached to a task on your own board
     read_task_file     one of those files, as text
   The dialogue-window chat gets only the two file tools, through a second server entry (MCP_CHAT_SERVER_NAME) that its
   platform list names, so chat can read past work but still cannot act.
   JSON-RPC methods: initialize, notifications/*, ping, tools/list, tools/call. */
import type { FastifyInstance } from 'fastify';
import type { QuestDetail } from '@vibe-city/shared';
import type { QuestRequestService } from '../domain/questRequests.ts';
import type { QuestService } from '../domain/questService.ts';

export const MCP_SERVER_NAME = 'vibecity';
export const MCP_TOOLS = ['list_departments', 'request_quest', 'check_request'] as const;
export const MCP_CHAT_SERVER_NAME = 'vibecity-chat';
export const MCP_FILE_TOOLS = ['list_task_files', 'read_task_file'] as const;
const READ_MAX_CHARS = 40_000;
const PROTOCOL = '2025-06-18';

const TOOLS = [
  {
    name: 'list_departments',
    description: 'List the other departments of this company, what they do, and whether they accept work from your department. Use it before request_quest.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'request_quest',
    description: 'Ask another department to do a piece of work. It becomes a quest on that department\'s board, assigned to its lead agent. Use it only for work that belongs to the other department; plan your own work on your own board. Returns a request id: check it later with check_request. Some requests wait for the CEO\'s approval.',
    inputSchema: {
      type: 'object',
      properties: {
        department: { type: 'string', description: 'Name of the department to ask (see list_departments).' },
        title: { type: 'string', description: 'Short quest title, under 80 characters.' },
        objective: { type: 'string', description: 'What you need, in 1-4 sentences, with what "done" looks like.' },
        reason: { type: 'string', description: 'Why your department needs it (shown to the CEO and the other department).' },
      },
      required: ['department', 'title', 'objective'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_request',
    description: 'Check a request you made with request_quest: whether it was created, is waiting for approval or was declined, the quest status, and the result summaries once it is done.',
    inputSchema: { type: 'object', properties: { request_id: { type: 'string' } }, required: ['request_id'], additionalProperties: false },
  },
  {
    name: 'list_task_files',
    description: 'List the files attached to a task on your department\'s Kanban board (reports, data, notes the agents produced). Use a task id from the board, like t_1a2b3c4d.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false },
  },
  {
    name: 'read_task_file',
    description: `Read a text file attached to a task on your department's board (see list_task_files). Long files are cut at ${READ_MAX_CHARS} characters; binary files cannot be read.`,
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, filename: { type: 'string' } }, required: ['task_id', 'filename'], additionalProperties: false },
  },
];

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export function registerMcp(app: FastifyInstance, deps: {
  requests: QuestRequestService;
  questDetail: (departmentId: string, questId: string) => Promise<QuestDetail>;
  files: Pick<QuestService, 'taskFiles' | 'readTaskFile'>;
}) {
  const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

  async function call(dept: string, name: string, args: Record<string, unknown>) {
    const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() : '');
    if (name === 'list_departments') {
      const list = deps.requests.targets(dept);
      if (!list.length) return text('There are no other departments yet.');
      return text(list.map((d) => `- ${d.name}${d.ready ? '' : ' (not ready)'}${d.accepts ? '' : ' (does not accept work from you)'}: ${d.purpose || 'no purpose written'}`).join('\n'));
    }
    if (name === 'request_quest') {
      if (!str('department') || !str('title') || !str('objective')) return text('department, title and objective are required.', true);
      const r = await deps.requests.request({ fromDepartmentId: dept, department: str('department'), title: str('title').slice(0, 200), objective: str('objective').slice(0, 8000), reason: str('reason').slice(0, 1000) });
      if (r.state === 'created') return text(`Request ${r.id} created: "${r.title}" is now a quest on ${r.toName}'s board. Check it later with check_request.`);
      if (r.state === 'pending_approval') return text(`Request ${r.id} is waiting for the CEO's approval: ${r.note}`);
      return text(`Request ${r.state}: ${r.note ?? 'unknown reason'}`, true);
    }
    if (name === 'check_request') {
      const r = deps.requests.get(str('request_id'), dept);
      if (r.state !== 'created' || !r.questId || !r.toDepartmentId) return text(`Request ${r.id}: ${r.state.replace('_', ' ')}${r.note ? `. ${r.note}` : ''}`);
      const q = await deps.questDetail(r.toDepartmentId, r.questId);
      const results = q.tasks.filter((t) => t.status === 'done' && t.summary).map((t) => `- ${t.title}: ${t.summary}`).join('\n').slice(0, 3000);
      return text(`Request ${r.id}: quest "${q.title}" on ${r.toName}'s board is ${q.status.replace('_', ' ')} (${q.counts.done}/${q.counts.tasks} tasks done).${results ? `\nResults so far:\n${results}` : ''}`);
    }
    if (name === 'list_task_files') {
      const t = await deps.files.taskFiles(dept, str('task_id'));
      if (!t.files.length) return text(`Task ${str('task_id')} ("${t.title}") has no files attached.`);
      return text(`Files on task ${str('task_id')} ("${t.title}"):\n${t.files.map((f) => `- ${f.filename} (${f.size} bytes${f.content_type ? `, ${f.content_type}` : ''})`).join('\n')}`);
    }
    if (name === 'read_task_file') {
      if (!str('task_id') || !str('filename')) return text('task_id and filename are required.', true);
      const f = await deps.files.readTaskFile(dept, str('task_id'), str('filename'), READ_MAX_CHARS);
      return text(f.truncated ? `${f.text}\n\n[cut at ${READ_MAX_CHARS} characters of ${f.size} bytes]` : f.text);
    }
    return null;
  }

  app.get('/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: 'method_not_allowed' }));
  app.post('/mcp', async (req, reply) => {
    const auth = String(req.headers.authorization ?? '');
    const dept = auth.startsWith('Bearer ') ? deps.requests.departmentForToken(auth.slice(7).trim()) : null;
    if (!dept) return reply.code(401).send({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } });
    const handle = async (m: Rpc) => {
      const id = m.id ?? null;
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
      const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
      if (!m.method) return fail(-32600, 'invalid request');
      if (m.method.startsWith('notifications/')) return null;
      switch (m.method) {
        case 'initialize': return ok({ protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'vibe-city', version: '0.1.0' } });
        case 'ping': return ok({});
        case 'tools/list': return ok({ tools: TOOLS });
        case 'tools/call': {
          const name = String(m.params?.name ?? '');
          try {
            const res = await call(dept, name, (m.params?.arguments ?? {}) as Record<string, unknown>);
            return res ? ok(res) : fail(-32602, `unknown tool: ${name}`);
          } catch (e) { return ok(text(`Error: ${(e as Error).message}`, true)); }
        }
        default: return fail(-32601, `method not found: ${m.method}`);
      }
    };
    const body = req.body as Rpc | Rpc[];
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handle))).filter(Boolean);
      return out.length ? reply.send(out) : reply.code(202).send();
    }
    const res = await handle(body ?? {});
    return res ? reply.send(res) : reply.code(202).send();
  });
}
