/* The game loop (docs/briefs/05-game-loop.md): CEO quests, decisions and runway, derived from state Vibe City
   already has. Pure: the route assembles the input, this decides. Markers are written by the agents (brief 01's
   template purposes): [earned usd=<n>] (Chief of Staff), [pnl usd=<n>] (trading floors), [pr url=<github url>]
   (Software), awaiting_owner (an action staged for the CEO). */
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
  /** Hermes approvals waiting on an agent turn. Only chat approvals are known (Kanban does not expose them). */
  pendingApprovals: Array<{ departmentId: string; agentKey: string; title: string }>;
}

export const CHIEF_OF_STAFF = 'chief-of-staff';
const usd = (s: string) => Math.round(Number(s) * 100);
const amounts = (lines: string[], tag: 'earned' | 'pnl') =>
  lines.flatMap((t) => [...t.matchAll(new RegExp(`\\[${tag} usd=(-?[0-9]+(?:\\.[0-9]+)?)\\]`, 'g'))].map((m) => usd(m[1]!)));
const PR = /\[pr url=https:\/\/github\.com\/[^\]\s]+\]|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

interface QuestDef { id: string; title: string; hint: string; unlocks: string | null; done: (x: Ctx) => boolean }
interface Ctx { i: GameInput; textOf: (templates: string[]) => string[]; earnedCents: number; ready: number }

/** In display order. first-swap and first-ship are parallel: each needs a different floor. */
export const CEO_QUESTS: readonly QuestDef[] = [
  { id: 'connect-ai', title: 'Connect NEAR AI Cloud', unlocks: 'Hiring', done: (x) => x.i.settings.nearAiApiKeySet,
    hint: 'Your agents think with NEAR AI Cloud models. Add your NEAR AI API key and the credits you loaded.' },
  { id: 'connect-github', title: 'Connect GitHub', unlocks: 'Software Department', done: (x) => x.i.settings.githubConnected,
    hint: 'Give the Software Department a GitHub token (a fine-grained personal access token) so its agents can push and open pull requests.' },
  { id: 'treasury', title: 'Set up the treasury', unlocks: 'Trading Desk',
    done: (x) => x.i.wallet.registered && (x.i.wallet.binding.status === 'active' || x.i.wallet.balances.some((b) => Number(b.amount) > 0)),
    hint: 'Create the company wallet and fund it, or connect a NEAR wallet you already have and sign the binding.' },
  { id: 'hire', title: 'Hire your first department', unlocks: null,
    done: (x) => x.i.departments.filter((d) => x.i.templateOf[d.id] !== CHIEF_OF_STAFF).length >= 1,
    hint: 'Pick a team from the templates. Each one comes with its agents and their jobs.' },
  { id: 'policy', title: 'Set the spend policy', unlocks: null, done: (x) => !!x.i.settings.policyConfirmedAt,
    hint: 'Set the wallet\'s limits and allowed actions in OutLayer, then confirm here. Vibe City cannot read the policy back.' },
  { id: 'market', title: 'Set up the Agent Market', unlocks: null, done: (x) => !!x.i.settings.marketVerifiedAt,
    hint: 'List the company on market.near.ai with the Chief of Staff, then paste the agent token here so it can take jobs.' },
  { id: 'first-job', title: 'Win your first job', unlocks: 'Token & Treasury', done: (x) => amounts(x.textOf([CHIEF_OF_STAFF]), 'earned').length > 0,
    hint: 'When a buyer accepts a job the Chief of Staff handled, the payout is recorded here.' },
  { id: 'first-swap', title: 'First profitable trade', unlocks: 'Prediction Desk', done: (x) => amounts(x.textOf(['trading-desk']), 'pnl').some((n) => n > 0),
    hint: 'The Trading Desk closes a trade with a realized profit.' },
  { id: 'first-ship', title: 'First code shipped', unlocks: 'Red Team, Blue Team', done: (x) => x.textOf(['software']).some((t) => PR.test(t)),
    hint: 'The Software Department opens a pull request on GitHub.' },
  { id: 'ipo', title: 'IPO', unlocks: 'IPO button', done: (x) => x.earnedCents > 0 && x.ready >= 3,
    hint: 'Earn at least once and have three departments ready. Then the IPO button lights up.' },
];

export function deriveGame(i: GameInput): GameState & { locked: Record<string, boolean> } {
  const tplByDept = i.templateOf;
  const textOf = (templates: string[]) => i.results.filter((r) => templates.includes(tplByDept[r.departmentId] ?? '')).map((r) => r.text);
  const earned = amounts(textOf([CHIEF_OF_STAFF]), 'earned').reduce((a, n) => a + n, 0);
  const pnl = amounts(textOf(['trading-desk', 'prediction-desk']), 'pnl').reduce((a, n) => a + n, 0);
  const earnedCents = earned + pnl;
  const ready = i.departments.filter((d) => d.state === 'ready' && tplByDept[d.id] !== CHIEF_OF_STAFF).length;
  const x: Ctx = { i, textOf, earnedCents: Math.max(0, earnedCents), ready };
  // `ipo` counts any earning, trading profit included
  const quests: CeoQuest[] = CEO_QUESTS.map((q) => ({ id: q.id, title: q.title, done: q.done(x), hint: q.hint, unlocks: q.unlocks }));
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
    ipoUnlocked: done.has('ipo'),
    locked,
  };
}

const firstLine = (t: string) => t.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 160) ?? '';
