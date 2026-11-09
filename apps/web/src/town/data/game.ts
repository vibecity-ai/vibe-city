/* The game loop's view logic (brief 05), pure so it can be tested without a DOM: which CEO quest is next, where its
   button goes, and where a decision's href leads. */
import type { CeoQuest, GameState } from '@vibe-city/shared';

export type QuestTarget =
  | { kind: 'safe' } | { kind: 'hire' } | { kind: 'connector'; name: 'hyperliquid' | 'polymarket' } | { kind: 'quest-board' }
  | { kind: 'market' } | { kind: 'cos' } | { kind: 'note'; text: string };

/** The next main quest; side quests never are. */
export const nextQuest = (g: GameState): CeoQuest | null => g.quests.find((q) => !q.done && !q.side) ?? null;

export function questTarget(id: string): QuestTarget | null {
  switch (id) {
    case 'treasury': case 'dao-funds': return { kind: 'safe' };
    case 'hire': return { kind: 'hire' };
    case 'connect-hyperliquid': return { kind: 'connector', name: 'hyperliquid' };
    case 'connect-polymarket': return { kind: 'connector', name: 'polymarket' };
    case 'ipo': return { kind: 'quest-board' };
    case 'connect-ai': return { kind: 'cos' };
    case 'market': case 'first-job': return { kind: 'market' };
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

/** The main line's three acts, in order. Side quests are listed apart (sideQuests). */
export const ACTS: readonly { title: string; blurb: string; ids: readonly string[] }[] = [
  { title: 'Set up the company', blurb: 'Your Chief of Staff, the treasury, your first floor, and a listing on the Agent Market.', ids: ['connect-ai', 'treasury', 'hire', 'market'] },
  { title: 'Earn', blurb: 'Win your first job and put enough in the treasury for the DAO vault.', ids: ['first-job', 'dao-funds'] },
  { title: 'Go public', blurb: 'Treasury Ops launches the Sputnik DAO vault. Then you ring the bell.', ids: ['ipo'] },
];

export function acts(g: GameState) {
  const byId = new Map(g.quests.map((q) => [q.id, q]));
  const known = new Set(ACTS.flatMap((a) => a.ids));
  const out = ACTS.map((a) => ({ ...a, quests: a.ids.map((id) => byId.get(id)).filter((q): q is CeoQuest => !!q) }));
  // main quests the backend adds later still show, at the end of the first act
  const extra = g.quests.filter((q) => !q.side && !known.has(q.id));
  if (extra.length) out[0] = { ...out[0]!, quests: [...out[0]!.quests, ...extra] };
  return out;
}

export const sideQuests = (g: GameState) => g.quests.filter((q) => q.side);

/** The phrase a progress counter shows, e.g. "2 of 7 done": the main line only (quests can be done out of order, so no position). */
export const progressLabel = (g: GameState) => {
  const main = g.quests.filter((q) => !q.side), done = main.filter((q) => q.done).length;
  return done === main.length ? `All ${done} quests done` : `${done} of ${main.length} done`;
};
