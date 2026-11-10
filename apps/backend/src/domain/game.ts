/* The game loop (docs/briefs/05-game-loop.md): CEO quests, decisions and runway, derived from state Vibe City
   already has. Pure: the route assembles the input, this decides. Markers are written by the agents (brief 01's
   template purposes): [pnl usd=<n>] (trading floors), awaiting_owner (an action staged for the CEO). The IPO is the
   backend's (domain/ipoService.ts): `ipoDone` once the DAO and the city token exist. */
import type { AiUsageSummary, CeoQuest, CompanySettings, Decision, DepartmentView, GameState, QuestSummary, Template, WalletState } from '@vibe-city/shared';

/** One finished task's text (its summary), with where it came from. */
export interface ResultLine { departmentId: string; questId: string; text: string }

export interface GameInput {
  settings: CompanySettings;
  wallet: WalletState;
  departments: DepartmentView[];
  /** The template each department was hired from (null = none). */
  templateOf: Record<string, string | null>;
  templates: readonly Template[];
  usage: AiUsageSummary;
  /** Every metered cent so far (for the credits left). */
  totalMeteredCents: number;
  questsByDept: Record<string, QuestSummary[]>;
  /** Task summaries of recent quests, per department. */
  results: ResultLine[];
  /** Agent Market jobs the buyer accepted, after the market's fee (brief 02). */
  marketEarnedCents: number;
  /** How many Agent Market jobs the buyer accepted (any amount). */
  marketJobsPaid: number;
  /** Some listed floor's agents hold its market token (the `market` quest). */
  marketListed: boolean;
  /** Hermes approvals waiting on an agent turn. Only chat approvals are known (Kanban does not expose them). */
  pendingApprovals: Array<{ departmentId: string; agentKey: string; title: string }>;
  /** The IPO's DAO and city token exist (ipoService). */
  ipoDone: boolean;
}

import { CHIEF_OF_STAFF } from '@vibe-city/shared';
export { CHIEF_OF_STAFF };
const usd = (s: string) => Math.round(Number(s) * 100);
const amounts = (lines: string[], tag: 'pnl') =>
  lines.flatMap((t) => [...t.matchAll(new RegExp(`\\[${tag} usd=(-?[0-9]+(?:\\.[0-9]+)?)\\]`, 'g'))].map((m) => usd(m[1]!)));

interface QuestDef { id: string; title: string; hint: string; unlocks: string | null; side?: true; done: (x: Ctx) => boolean }
interface Ctx { i: GameInput; textOf: (templates: string[]) => string[]; earnedCents: number }

const YOCTO = 10n ** 24n;
/** NEAR the company wallet must hold before the IPO: 1 for the DAO, about 2.23 for the city token, registrations and gas.
    ponytail: a fixed estimate; read tkn.near's get_required_deposit if it moves. */
export const DAO_FUND_NEAR = 4;
const nearHeld = (w: WalletState) => w.balances.filter((b) => b.token === 'NEAR' && (b.source === 'wallet' || b.source === 'bound')).reduce((a, b) => a + BigInt(b.amount), 0n);

/** In display order: the main line first, then the side quests. */
export const CEO_QUESTS: readonly QuestDef[] = [
  // First: the Chief of Staff (and every agent after it) thinks with NEAR AI Cloud, so the key comes before anything else.
  { id: 'connect-ai', title: 'Set up your Chief of Staff', unlocks: 'Hiring',
    done: (x) => x.i.settings.nearAiApiKeySet && x.i.settings.chiefOfStaffModel !== null,
    hint: 'Paste your NEAR AI Cloud API key and pick the model your Chief of Staff thinks with. Every agent you hire uses the same key.' },
  { id: 'treasury', title: 'Set up the treasury', unlocks: 'Treasury Ops',
    done: (x) => x.i.wallet.registered && (x.i.wallet.binding.status === 'active' || x.i.wallet.balances.some((b) => Number(b.amount) > 0)),
    hint: 'Create a wallet at app.outlayer.ai/wallet/new, paste its agent key in the safe, and fund it.' },
  { id: 'hire', title: 'Hire your first department', unlocks: null,
    done: (x) => x.i.departments.filter((d) => x.i.templateOf[d.id] !== CHIEF_OF_STAFF).length >= 1,
    hint: 'Pick a team from the templates. Each one comes with its agents and their jobs.' },
  { id: 'market', title: 'List on the Agent Market', unlocks: null, done: (x) => x.i.marketListed,
    hint: 'Ask your Chief of Staff to list one floor as an agent on market.near.ai. Done once that floor\'s agents hold the agent token.' },
  { id: 'first-job', title: 'Win your first job', unlocks: null, done: (x) => x.i.marketJobsPaid > 0,
    hint: 'Go live on market.near.ai; a buyer hires your listed floor and accepts its first delivery.' },
  // the IPO spends these funds, so a public company keeps this quest done
  { id: 'dao-funds', title: 'Fund the IPO', unlocks: 'IPO', done: (x) => x.i.ipoDone || nearHeld(x.i.wallet) >= BigInt(DAO_FUND_NEAR) * YOCTO,
    hint: `Hold at least ${DAO_FUND_NEAR} NEAR in the company wallet: the IPO spends it on the company's Sputnik DAO and city token.` },
  { id: 'ipo', title: 'IPO', unlocks: 'the opening bell', done: (x) => x.i.ipoDone,
    hint: 'Press IPO in the safe: the company wallet creates the Sputnik DAO (you approve) and the city token, all owned by the DAO.' },
  // Side quests: each opens a floor, none blocks the main line.
  // Done only when OutLayer's connector reports the owner's policy (one status call per check): the caps the agents trade under.
  { id: 'connect-hyperliquid', title: 'Connect Hyperliquid', unlocks: 'Trading Desk', side: true, done: (x) => !!x.i.settings.hyperliquidConnectedAt,
    hint: 'At app.outlayer.ai/connect/hyperliquid, store the trading caps (max order, daily volume, leverage) for the company wallet, then check here.' },
  { id: 'connect-polymarket', title: 'Connect Polymarket', unlocks: 'Prediction Desk', side: true, done: (x) => !!x.i.settings.polymarketConnectedAt,
    hint: 'At app.outlayer.ai/connect/polymarket, store the caps (max order, daily volume) for the company wallet, then check here.' },
];

export function deriveGame(i: GameInput): GameState & { locked: Record<string, boolean> } {
  const tplByDept = i.templateOf;
  const textOf = (templates: string[]) => i.results.filter((r) => templates.includes(tplByDept[r.departmentId] ?? '')).map((r) => r.text);
  const earned = i.marketEarnedCents;
  const pnl = amounts(textOf(['treasury-ops', 'trading-desk', 'prediction-desk']), 'pnl').reduce((a, n) => a + n, 0);
  const earnedCents = earned + pnl;
  const x: Ctx = { i, textOf, earnedCents: Math.max(0, earnedCents) };
  const quests: CeoQuest[] = CEO_QUESTS.map((q) => ({ id: q.id, title: q.title, done: q.done(x), hint: q.hint, unlocks: q.unlocks, side: !!q.side }));
  const done = new Set(quests.filter((q) => q.done).map((q) => q.id));

  const decisions: Decision[] = [
    ...i.pendingApprovals.map((a, n) => ({ id: `approval:${a.departmentId}:${a.agentKey}:${n}`, kind: 'approval' as const, departmentId: a.departmentId, title: a.title, href: `chat/${a.departmentId}/${a.agentKey}` })),
    ...i.results.filter((r) => /awaiting_owner/.test(r.text)).map((r) => ({
      id: `owner:${r.departmentId}:${r.questId}`, kind: 'owner_confirm' as const, departmentId: r.departmentId,
      title: firstLine(r.text.replace(/awaiting_owner/g, '').trim()) || 'An action waits for your OK', href: `quest/${r.departmentId}/${r.questId}`,
    })),
    ...Object.entries(i.questsByDept).flatMap(([deptId, qs]) => qs.filter((q) => q.status === 'awaiting_input').map((q) => ({
      id: `answer:${deptId}:${q.id}`, kind: 'answer' as const, departmentId: deptId, title: q.title, href: `quest/${deptId}/${q.id}`,
    }))),
    ...i.usage.byDepartment.filter((u) => u.overBudget).map((u) => ({
      id: `budget:${u.departmentId}`, kind: 'budget' as const, departmentId: u.departmentId,
      title: `${i.departments.find((d) => d.id === u.departmentId)?.name ?? 'A department'} reached its daily budget`, href: `settings/${u.departmentId}`,
    })),
  ];
  // dedupe owner confirmations per quest
  const seen = new Set<string>();
  const uniq = decisions.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));

  const remaining = i.settings.nearAiCreditsLoadedCents === null ? null : i.settings.nearAiCreditsLoadedCents - i.totalMeteredCents;
  const burn = i.usage.companySevenDayAvgCents;
  const locked = Object.fromEntries(i.templates.map((t) => [t.id, !done.has('connect-ai') || (t.unlock !== null && !done.has(t.unlock))]));
  return {
    quests, decisions: uniq,
    runway: { creditsRemainingCents: remaining, dailyBurnCents: burn, days: remaining !== null && burn > 0 ? Math.max(0, Math.floor(remaining / burn)) : null, earnedCents: x.earnedCents, estimated: true },
    ipoUnlocked: done.has('first-job') && done.has('dao-funds'),
    locked,
  };
}

const firstLine = (t: string) => t.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 160) ?? '';
