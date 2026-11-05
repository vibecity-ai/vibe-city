/* What an agent did on a task, from its Kanban run's Hermes session: every tool call in plain words, and what the
   agent wrote along the way. Tool arguments and results are never forwarded raw: one short, path-scrubbed detail. */
import type { TaskStep } from '@vibe-city/shared';
import type { SessionMessage } from '../hermes/ports.ts';
import { scrub } from './scrub.ts';

const VERBS: [RegExp, string][] = [
  [/^web_search$/, 'Searched the web'],
  [/^(web_extract|web_fetch|browser_navigate|browser_open)$/, 'Read a web page'],
  [/^browser_/, 'Used the browser'],
  [/^terminal$/, 'Ran a command'],
  [/^execute_code$/, 'Ran code'],
  [/^read_file$/, 'Read a file'],
  [/^write_file$/, 'Wrote a file'],
  [/^(patch|edit_file)$/, 'Edited a file'],
  [/^search_files$/, 'Searched files'],
  [/^kanban_show$/, 'Read the task'],
  [/^kanban_list$/, 'Checked the board'],
  [/^kanban_create$/, 'Handed out a task'],
  [/^kanban_complete$/, 'Finished the task'],
  [/^kanban_comment$/, 'Commented on the task'],
  [/^kanban_block$/, 'Blocked the task'],
  [/^kanban_attachments$/, 'Checked the attachments'],
  [/^kanban_attach/, 'Attached a file'],
  [/^kanban_/, 'Updated the board'],
  [/^tool_(search|describe)$/, 'Looked for tools'],
  [/^skills?_(list|view)$/, 'Checked its skills'],
  [/^skill/, 'Changed its skills'],
  [/^memory$/, 'Updated its memory'],
  [/^todo$/, 'Updated its plan'],
  [/^delegate_task$/, 'Delegated work'],
  [/^vision_analyze$/, 'Looked at an image'],
];
const DETAIL_KEYS = ['query', 'queries', 'url', 'urls', 'command', 'path', 'title', 'summary', 'reason', 'body', 'pattern', 'name'];

const verb = (name: string) => VERBS.find(([re]) => re.test(name))?.[1] ?? `Used ${name.replace(/^mcp_+[a-z0-9]+_+/, '').replace(/_/g, ' ')}`;

/** `tool_call` runs other tools (`{"calls": [{"name": …}]}`): name those instead. */
function callsOf(c: { name: string; args: string }): { name: string; args: string }[] {
  if (c.name !== 'tool_call') return [c];
  try {
    const inner = (JSON.parse(c.args) as { calls?: { name?: unknown; arguments?: unknown }[] }).calls ?? [];
    const out = inner.filter((x) => typeof x.name === 'string').map((x) => ({ name: x.name as string, args: JSON.stringify(x.arguments ?? {}) }));
    return out.length ? out : [c];
  } catch { return [c]; }
}

function detailOf(args: string): string | null {
  let a: unknown;
  try { a = JSON.parse(args); } catch { return null; }
  if (!a || typeof a !== 'object') return null;
  for (const k of DETAIL_KEYS) {
    const v = (a as Record<string, unknown>)[k];
    const text = typeof v === 'string' ? v : Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(' · ') : null;
    if (text?.trim()) return scrub(text.trim().replace(/\s+/g, ' '), 160);
  }
  return null;
}

/** A tool result that reports a failure (Hermes tools answer JSON with `status: error`, an `error`, or a non-zero exit). */
function failed(content: string): boolean {
  if (/^\s*(BLOCKED|Error)\b/.test(content)) return true;
  try {
    const r = JSON.parse(content) as Record<string, unknown>;
    return r.status === 'error' || r.success === false || (typeof r.error === 'string' && r.error !== '') || (typeof r.exit_code === 'number' && r.exit_code !== 0);
  } catch { return false; }
}

export function buildSteps(messages: SessionMessage[]): TaskStep[] {
  const bad = new Set(messages.filter((m) => m.role === 'tool' && m.toolCallId && failed(m.content)).map((m) => m.toolCallId));
  const out: TaskStep[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue; // the user message is the task prompt; tool messages are results
    const said = scrub(m.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim(), 300);
    if (said) out.push({ at: m.at, kind: 'note', text: said, detail: null });
    for (const c of m.calls) for (const x of callsOf(c)) out.push({ at: m.at, kind: bad.has(c.id) ? 'failed' : 'tool', text: verb(x.name), detail: detailOf(x.args) });
  }
  return out;
}
