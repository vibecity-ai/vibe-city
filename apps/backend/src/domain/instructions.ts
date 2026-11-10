import type { Inventory } from '@vibe-city/shared';

/** The one sanctioned way to involve another department (the Vibe City MCP server, feature spec 2.4). */
const CROSS_DEPT = 'If part of the work belongs to another department, ask it with the Vibe City tool request_quest (see list_departments first), then check_request for the result. Never create tasks on another department\'s board yourself.';

/** The CEO watches the office: each agent's latest note shows over its head while it works. */
const PROGRESS_NOTES = 'While you work on a task, call kanban_heartbeat with a note every few steps: one line of at most 12 words, in the first person, saying what you are doing right now (for example "Comparing the three vendors\' prices"). The CEO sees it over your head in the office.';

const clean = (s: string) => s.replace(/<!--|-->/g, '').trim();

const beginMarker = (deptId: string, agentKey: string) => `<!-- vibe-city:begin dept=${deptId} agent=${agentKey} -->`;
const END = '<!-- vibe-city:end -->';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * How to run a quest, in the same words in SOUL.md and in each quest's body. The lead plans and hands out by default:
 * left optional, it did whole quests alone while teammates sat idle. Child tasks wait for the quest task (parent links
 * are dependencies), so it completes with the plan and a compile task joins the results.
 */
export function delegationRules(self: string, teammates: string[]): string[] {
  if (!teammates.length) return ['You have no teammates: do the work yourself.', 'Do not create Kanban tasks for any other profile.'];
  return [
    `You are the Hermes profile "${self}". Your teammates are the Hermes profiles ${teammates.map((t) => `"${t}"`).join(', ')}. Each is an agent like you and works in parallel with the others.`,
    'When you own a quest (a task with no parent), you lead it: plan the work and hand it out rather than doing it all yourself.',
    '1. Split the quest into parts that can run in parallel. For each part create one child Kanban task with parents set to the quest task, assigned to a teammate or to yourself. Give every teammate a part before taking a second one yourself.',
    '2. When the parts must come together into one deliverable, also create a final compile task with parents set to every part task, assigned to a teammate or yourself. It starts once all the parts are done and sees their results; say in it exactly what to deliver.',
    '3. Then complete the quest task with the plan: each child task id and what it covers. The child tasks start only after the quest task is complete, so do not wait for them.',
    'Each child task must be self-contained: its assignee cannot see the quest, so put every instruction and input it needs in the task.',
    'Do a quest alone only when it is a single step that cannot be split.',
    'When a task was handed to you (it has a parent), do it yourself and do not split it further.',
    'Never assign tasks to a profile other than yourself and your teammates.',
  ];
}

/**
 * The managed block written into an agent profile's SOUL.md. Everything outside the markers is left untouched.
 * Every agent gets the same rules; `lead` only says that new quests arrive with this agent. `teammates` are the other
 * agents' profile names: with `self`, the only profiles this agent may hand tasks to.
 */
export function buildBlock(opts: {
  deptId: string; deptName: string; purpose: string; agentKey: string; lead: boolean; self: string; teammates: string[]; inv: Inventory;
}): string {
  const { deptId, deptName, purpose, agentKey, lead, self, teammates, inv } = opts;
  const lines = [
    beginMarker(deptId, agentKey),
    `# Department: ${clean(deptName)}`,
    purpose ? `Purpose: ${clean(purpose)}` : '',
    '',
    [
      `You are an agent of this department (seat ${agentKey}).${lead ? ' New quests for the department are assigned to you.' : ''}`,
      ...delegationRules(self, teammates),
      'Complete every task with a summary of what you did (and which child tasks you created) and attach any output files.',
      PROGRESS_NOTES,
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
