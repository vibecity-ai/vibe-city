import type { Inventory } from '@vibe-city/shared';

/** The one sanctioned way to involve another department (the Vibe City MCP server, feature spec 2.4). */
const CROSS_DEPT = 'If part of the work belongs to another department, ask it with the Vibe City tool request_quest (see list_departments first), then check_request for the result. Never create tasks on another department\'s board yourself.';

const clean = (s: string) => s.replace(/<!--|-->/g, '').trim();

const beginMarker = (deptId: string, agentKey: string) => `<!-- vibe-city:begin dept=${deptId} agent=${agentKey} -->`;
const END = '<!-- vibe-city:end -->';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The managed block written into an agent profile's SOUL.md. Everything outside the markers is left untouched.
 * Every agent gets the same rules; `lead` only says that new quests arrive with this agent. `teammates` are the other
 * agents' profile names: the only profiles this agent may hand tasks to.
 */
export function buildBlock(opts: {
  deptId: string; deptName: string; purpose: string; agentKey: string; lead: boolean; teammates: string[]; inv: Inventory;
}): string {
  const { deptId, deptName, purpose, agentKey, lead, teammates, inv } = opts;
  const lines = [
    beginMarker(deptId, agentKey),
    `# Department: ${clean(deptName)}`,
    purpose ? `Purpose: ${clean(purpose)}` : '',
    '',
    [
      `You are an agent of this department (seat ${agentKey}).${lead ? ' New quests for the department are assigned to you.' : ''}`,
      teammates.length
        ? `Your teammates are the Hermes profiles ${teammates.map((t) => `"${t}"`).join(', ')}. Each is an agent like you and works in parallel with the others.`
        : 'You have no teammates: do the work yourself.',
      ...(teammates.length
        ? [
          'When you own a quest (a task with no parent) and parts of it can run independently, create one child Kanban task',
          'per part, assigned to a teammate, with parents set to your task. Each child task must be self-contained: the',
          'teammate cannot see your task, so put every instruction and input it needs in the child task. Spread the parts',
          'across teammates. When a task was handed to you (it has a parent), do it yourself and do not split it further.',
          'Never assign tasks to a profile that is not one of your teammates.',
        ]
        : ['Do not create Kanban tasks for any other profile.']),
      'Complete every task with a summary of what you did (and which child tasks you created) and attach any output files.',
      CROSS_DEPT,
    ].join('\n'),
    inv.sharedContextRefs.length ? `\nShared context references:\n${inv.sharedContextRefs.map((r) => `- ${clean(r)}`).join('\n')}` : '',
    END,
  ];
  return lines.filter((l) => l !== '').join('\n');
}

const blockRe = (deptId: string, agentKey: string) => new RegExp(`${esc(beginMarker(deptId, agentKey))}[\\s\\S]*?${esc(END)}`);
/** Blocks written before every agent had its own profile were keyed by role (chief/worker). */
const legacyRe = (deptId: string) => new RegExp(`\\n*${esc(`<!-- vibe-city:begin dept=${deptId} role=`)}(?:chief|worker) -->[\\s\\S]*?${esc(END)}\\n?`, 'g');

/** Inserts or replaces this agent's block (dropping this department's legacy role blocks); returns the new full text. */
export function upsertBlock(existing: string | null, block: string, deptId: string, agentKey: string): string {
  const text = (existing ?? '').replace(legacyRe(deptId), '\n');
  const re = blockRe(deptId, agentKey);
  if (re.test(text)) return text.replace(re, () => block);
  const base = text.trim() === '' ? '' : text;
  return `${base}${base === '' || base.endsWith('\n') ? '' : '\n'}\n${block}\n`;
}

export function hasBlock(text: string | null, block: string): boolean {
  return text !== null && text.includes(block);
}
