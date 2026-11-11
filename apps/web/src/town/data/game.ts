/* The game loop's view logic (brief 05), pure so it can be tested without a DOM: which CEO quest is next, where its
   button goes, and where a decision's href leads. */
import type { CeoQuest, GameState, IpoState } from '@vibe-city/shared';

export type QuestTarget =
  | { kind: 'safe' } | { kind: 'hire' } | { kind: 'connector'; name: 'hyperliquid' | 'polymarket' } | { kind: 'quest-board' }
  | { kind: 'market' } | { kind: 'cos' } | { kind: 'note'; text: string };

/** The next main quest; side quests never are. */
export const nextQuest = (g: GameState): CeoQuest | null => g.quests.find((q) => !q.done && !q.side) ?? null;

export function questTarget(id: string): QuestTarget | null {
  switch (id) {
    case 'treasury': case 'dao-funds': case 'ipo': return { kind: 'safe' };
    case 'hire': return { kind: 'hire' };
    case 'connect-hyperliquid': return { kind: 'connector', name: 'hyperliquid' };
    case 'connect-polymarket': return { kind: 'connector', name: 'polymarket' };
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
  { title: 'Earn', blurb: 'Win your first job and put enough NEAR in the treasury for the IPO.', ids: ['first-job', 'dao-funds'] },
  { title: 'Go public', blurb: 'Press IPO: the company wallet creates the Sputnik DAO and the city token. Then you share revenue by DAO vote.', ids: ['ipo'] },
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

/** The IPO form's symbol suggestion: the company name's initials, uppercase, 2 to 8 characters (IPO_SYMBOL_RE).
    A one-word name gives its first letters instead. */
export function ipoSymbol(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(' ').filter(Boolean);
  while (words.length && !/^[A-Z]/.test(words[0]!)) words.shift();
  const initials = words.map((w) => w[0]).join('');
  const s = (initials.length >= 2 ? initials : words.join('')).slice(0, 8);
  return s.length >= 2 ? s : 'VCT';
}

export type IpoStepStatus = 'done' | 'working' | 'approval' | 'failed' | 'todo';
export interface IpoStep { id: 'dao' | 'register' | 'token'; label: string; detail: string; status: IpoStepStatus }

/** The IPO's three on-chain steps and where each stands. `busy`: a launch request is in flight (the server is working
    even before its state says so). The server names the call waiting in OutLayer (`awaiting`); that tells the step. */
export function ipoSteps(ipo: Pick<IpoState, 'state' | 'awaiting' | 'daoAccountId' | 'tokenAccountId' | 'symbol'> & { offer?: IpoState['offer']; error?: string | null }, busy: boolean): IpoStep[] {
  const steps: Omit<IpoStep, 'status'>[] = [
    { id: 'dao', label: 'Create the Sputnik DAO', detail: ipo.daoAccountId ?? 'You approve its proposals; the company wallet can only propose.' },
    { id: 'register', label: 'Open the DAO to revenue', detail: 'Registers it on USDC and wNEAR so earnings can be sent to it.' },
    { id: 'token', label: 'Mint the shares and open the offering', detail: ipo.tokenAccountId ?? (ipo.offer
      ? `${ipo.offer.supply.toLocaleString()} ${ipo.symbol ?? 'tokens'}: 60% to the DAO, 40% offered at ${ipo.offer.priceNear} NEAR`
      : `${ipo.symbol ?? 'City tokens'}: 60% to the DAO, 40% offered for sale.`) },
  ];
  if (ipo.state === 'done') return steps.map((s) => ({ ...s, status: 'done' }));
  // the call waiting in OutLayer, or the one an error names, tells the step
  const call = ipo.awaiting ?? (ipo.state === 'error' ? ipo.error ?? '' : '');
  const at = !ipo.daoAccountId ? 0 : call.includes(' create_token') ? 2 : call.includes(' storage_deposit') ? 1 : ipo.tokenAccountId ? 3 : 1;
  const started = busy || ipo.state === 'running' || ipo.state === 'awaiting_approval' || ipo.state === 'error';
  const now: IpoStepStatus = ipo.state === 'awaiting_approval' ? 'approval' : ipo.state === 'error' && !busy ? 'failed' : 'working';
  return steps.map((s, i) => ({ ...s, status: i < at ? 'done' : i === at && started ? now : 'todo' }));
}

/** The IPO completed while the player watched: it was in another state a moment ago (never on the first load). */
export const ipoRang = (was: IpoState['state'] | null, now: IpoState['state']) => was !== null && was !== 'done' && now === 'done';
