/* The game loop's view logic (brief 05), pure so it can be tested without a DOM: which CEO quest is next, where its
   button goes, and where a decision's href leads. */
import type { CeoQuest, GameState } from '@vibe-city/shared';

export type QuestTarget =
  | { kind: 'safe' } | { kind: 'hire' } | { kind: 'confirm-policy' } | { kind: 'quest-board' } | { kind: 'ipo' }
  | { kind: 'note'; text: string };

export const nextQuest = (g: GameState): CeoQuest | null => g.quests.find((q) => !q.done) ?? null;

export function questTarget(id: string): QuestTarget | null {
  switch (id) {
    case 'treasury': return { kind: 'safe' };
    case 'hire': return { kind: 'hire' };
    case 'policy': return { kind: 'confirm-policy' };
    case 'first-job': case 'first-swap': case 'first-ship': return { kind: 'quest-board' };
    case 'ipo': return { kind: 'ipo' };
    case 'connect-ai': return { kind: 'note', text: 'Set NEAR_AI_API_KEY in .env for now; the settings field comes with the metering work.' };
    case 'connect-github': return { kind: 'note', text: 'Set GITHUB_TOKEN in .env for now; the settings field comes with the metering work.' };
    case 'market': return { kind: 'note', text: 'The Chief of Staff walks you through it once it moves in.' };
    default: return null;
  }
}

export type DecisionTarget = { kind: 'quest'; questId: string } | { kind: 'settings'; deptId: string } | { kind: 'chat'; deptId: string; agentKey: string } | null;

/** href: quest/<dept>/<quest> · settings/<dept> · chat/<dept>/<agent> */
export function decisionTarget(href: string): DecisionTarget {
  const [kind, dept, id] = href.split('/');
  if (kind === 'quest' && id) return { kind: 'quest', questId: id };
  if (kind === 'settings' && dept) return { kind: 'settings', deptId: dept };
  if (kind === 'chat' && dept && id) return { kind: 'chat', deptId: dept, agentKey: id };
  return null;
}
