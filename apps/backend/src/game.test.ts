import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, type DepartmentView } from '@vibe-city/shared';
import { deriveGame, type GameInput } from './domain/game.ts';
import { EMPTY_WALLET } from './domain/walletService.ts';
import { memApp } from './testUtils.ts';

const dept = (id: string, state: DepartmentView['state'] = 'ready') => ({ id, name: id, state }) as DepartmentView;
const base = (): GameInput => ({
  settings: { nearAiApiKeySet: false, nearAiCreditsLoadedCents: null, outlayerWalletId: null, outlayerAccountId: null, marketAgentHandle: null, marketVerifiedAt: null, githubConnected: false, githubLogin: null, hyperliquidConnectedAt: null, polymarketConnectedAt: null },
  wallet: EMPTY_WALLET, departments: [], templateOf: {}, templates: TEMPLATES,
  usage: { byDepartment: [], companyTodayCents: 0, companySevenDayAvgCents: 0 }, totalMeteredCents: 0,
  questsByDept: {}, results: [], marketEarnedCents: 0, pendingApprovals: [],
});
const done = (i: GameInput, id: string) => deriveGame(i).quests.find((q) => q.id === id)!.done;

// each quest: an input where it is not done, and the change that makes it done
const cases: Array<[string, (i: GameInput) => void]> = [
  ['connect-ai', (i) => { i.settings.nearAiApiKeySet = true; }],
  ['connect-github', (i) => { i.settings.githubConnected = true; }],
  ['treasury', (i) => { i.wallet = { ...EMPTY_WALLET, registered: true, binding: { accountId: 'boss.near', status: 'active' } }; }],
  ['hire', (i) => { i.departments = [dept('d1')]; }],
  ['connect-hyperliquid', (i) => { i.settings.hyperliquidConnectedAt = '2026-11-08T10:00:00Z'; }],
  ['connect-polymarket', (i) => { i.settings.polymarketConnectedAt = '2026-11-08T10:00:00Z'; }],
  ['market', (i) => { i.settings.marketVerifiedAt = '2026-11-08T10:00:00Z'; }],
  ['first-job', (i) => { i.marketEarnedCents = 1188; }],
  ['first-swap', (i) => { i.templateOf = { td: 'trading-desk' }; i.results = [{ departmentId: 'td', questId: 'q', text: 'Closed ETH long [pnl usd=3.2]' }]; }],
  ['first-ship', (i) => { i.templateOf = { sw: 'software' }; i.results = [{ departmentId: 'sw', questId: 'q', text: 'Opened [pr url=https://github.com/acme/app/pull/7]' }]; }],
  // three ready floors besides the Chief of Staff, and one earning
  ['ipo', (i) => { i.departments = [dept('a'), dept('b'), dept('c'), dept('cos')]; i.templateOf = { cos: 'chief-of-staff' }; i.marketEarnedCents = 95; }],
];
for (const [id, make] of cases) test(`CEO quest ${id}: not done, then done`, () => {
  const i = base();
  assert.equal(done(i, id), false);
  make(i);
  assert.equal(done(i, id), true);
});

test('a loss or a closed trade without profit does not count; a security floor cannot finish first-ship', () => {
  const i = base();
  i.templateOf = { td: 'trading-desk', red: 'red-team' };
  i.results = [{ departmentId: 'td', questId: 'q', text: '[pnl usd=-4] stopped out' }, { departmentId: 'red', questId: 'q', text: 'https://github.com/acme/app/pull/9' }];
  assert.equal(done(i, 'first-swap'), false);
  assert.equal(done(i, 'first-ship'), false);
});

test('templates lock until NEAR AI is connected and their own quest is done', () => {
  const i = base();
  assert.ok(Object.values(deriveGame(i).locked).every(Boolean), 'nothing before NEAR AI');
  i.settings.nearAiApiKeySet = true;
  let l = deriveGame(i).locked;
  assert.equal(l.software, true);
  i.settings.githubConnected = true;
  l = deriveGame(i).locked;
  assert.equal(l.software, false);
  assert.equal(l['trading-desk'], true);
  assert.equal(l['red-team'], true);
});

test('a funded treasury opens Treasury Ops; perps and prediction markets wait for their connector policy', () => {
  const i = base();
  i.settings.nearAiApiKeySet = true;
  assert.equal(deriveGame(i).locked['treasury-ops'], true);
  i.wallet = { ...EMPTY_WALLET, registered: true, balances: [{ token: 'USDC', amount: '5000000', decimals: 6, source: 'intents', chain: 'near', usd: 5, logo: null }] };
  let l = deriveGame(i).locked;
  assert.equal(l['treasury-ops'], false);
  assert.equal(l['trading-desk'], true);
  assert.equal(l['prediction-desk'], true);
  i.settings.hyperliquidConnectedAt = '2026-11-08T10:00:00Z';
  l = deriveGame(i).locked;
  assert.equal(l['trading-desk'], false);
  assert.equal(l['prediction-desk'], true);
  // a Treasury Ops swap that closes in profit is the first profitable trade
  i.templateOf = { ops: 'treasury-ops' };
  i.results = [{ departmentId: 'ops', questId: 'q', text: 'Swapped NEAR to USDC and back [pnl usd=0.40]' }];
  assert.equal(done(i, 'first-swap'), true);
});

test('runway: null without credits, computed from credits loaded, metered spend and the 7-day average', () => {
  const i = base();
  assert.equal(deriveGame(i).runway.creditsRemainingCents, null);
  assert.equal(deriveGame(i).runway.days, null);
  i.settings.nearAiCreditsLoadedCents = 5000;
  i.totalMeteredCents = 1000;
  i.usage = { byDepartment: [], companyTodayCents: 300, companySevenDayAvgCents: 200 };
  const r = deriveGame(i).runway;
  assert.deepEqual([r.creditsRemainingCents, r.dailyBurnCents, r.days, r.estimated], [4000, 200, 20, true]);
});

test('decisions: over budget, awaiting input and staged owner actions', () => {
  const i = base();
  i.departments = [dept('d1')];
  i.usage = { byDepartment: [{ departmentId: 'd1', todayCents: 500, sevenDayCents: 900, budgetCents: 500, overBudget: true }], companyTodayCents: 500, companySevenDayAvgCents: 128 };
  i.questsByDept = { d1: [{ id: 'q1', title: 'Pick a currency', status: 'awaiting_input' } as never] };
  i.results = [{ departmentId: 'd1', questId: 'q2', text: 'Proposal 12 drafted: fund the ads budget. awaiting_owner' }, { departmentId: 'd1', questId: 'q2', text: 'awaiting_owner again' }];
  const d = deriveGame(i).decisions;
  assert.deepEqual(d.map((x) => [x.kind, x.href]), [['owner_confirm', 'quest/d1/q2'], ['answer', 'quest/d1/q1'], ['budget', 'settings/d1']]);
  assert.match(d[0]!.title, /Proposal 12 drafted/);
});

test('GET /api/game answers a game state; the trading floors wait for their connector quests', async () => {
  const { app } = memApp();
  const g = (await app.inject('/api/game')).json();
  assert.equal(g.quests.length, 11);
  assert.ok(!g.quests.some((q: any) => q.id === 'policy'), 'no self-confirmed policy quest');
  assert.equal(g.quests.find((q: any) => q.id === 'connect-hyperliquid').unlocks, 'Trading Desk');
  assert.equal(g.quests.find((q: any) => q.id === 'connect-polymarket').unlocks, 'Prediction Desk');
  const tl = (await app.inject('/api/templates')).json();
  assert.equal(tl.find((t: any) => t.id === 'red-team').locked, true);
});
