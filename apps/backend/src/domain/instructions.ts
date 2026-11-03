import type { Inventory } from '@vibe-city/shared';

export type Role = 'chief' | 'worker';

const clean = (s: string) => s.replace(/<!--|-->/g, '').trim();

const beginMarker = (deptId: string, role: Role) => `<!-- vibe-city:begin dept=${deptId} role=${role} -->`;
const END = '<!-- vibe-city:end -->';

/**
 * The managed block written into a profile's SOUL.md. Everything outside the markers is left untouched.
 * `counterpart` is the other profile: the worker for a chief (null when the department has no workers), the chief for a worker.
 */
export function buildBlock(opts: {
  deptId: string; deptName: string; purpose: string; role: Role; counterpart: string | null; inv: Inventory;
}): string {
  const { deptId, deptName, purpose, role, counterpart, inv } = opts;
  const lines = [
    beginMarker(deptId, role),
    `# Department: ${clean(deptName)}`,
    purpose ? `Purpose: ${clean(purpose)}` : '',
    '',
    role === 'chief' && counterpart === null
      ? [
        'You are the Chief Agent of this department. The department has no workers: do the work yourself.',
        'Complete your task with a summary of what you did and attach any output files.',
        'Do not create Kanban tasks for any other profile.',
      ].join('\n')
      : role === 'chief'
      ? [
        `You are the Chief Agent of this department. Your worker profile is "${counterpart}".`,
        'Do the work yourself, or split it into child Kanban tasks assigned to the worker profile (parents = your',
        'current task) when parts can run independently. Complete your own task with a summary of what you did and',
        'which child tasks you created. Do not create tasks for any profile other than your worker.',
      ].join('\n')
      : [
        `You are a Worker Agent of this department. Your chief profile is "${counterpart}".`,
        'Do exactly the task you were assigned, using only the tools available to you, then complete it with a short',
        'summary and attach any output files. Do not create new tasks or delegate.',
      ].join('\n'),
    inv.sharedContextRefs.length ? `\nShared context references:\n${inv.sharedContextRefs.map((r) => `- ${clean(r)}`).join('\n')}` : '',
    END,
  ];
  return lines.filter((l) => l !== '').join('\n');
}

const blockRe = (deptId: string, role: Role) =>
  new RegExp(`${beginMarker(deptId, role).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

/** Inserts or replaces this department's block; returns the new full text. */
export function upsertBlock(existing: string | null, block: string, deptId: string, role: Role): string {
  const text = existing ?? '';
  const re = blockRe(deptId, role);
  if (re.test(text)) return text.replace(re, () => block);
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}\n${block}\n`;
}

export function hasBlock(text: string | null, block: string): boolean {
  return text !== null && text.includes(block);
}
