import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, type DepartmentView } from '@vibe-city/shared';
import { deriveGame, type GameInput } from './domain/game.ts';
import { EMPTY_WALLET } from './domain/walletService.ts';
import { memApp } from './testUtils.ts';

const dept = (id: string, state: DepartmentView['state'] = 'ready') => ({ id, name: id, state }) as DepartmentView;
const base = (): GameInput => ({
  settings: { nearAiApiKeySet: false, nearAiCreditsLoadedCents: null, outlayerWalletId: null, outlayerAccountId: null, marketAgentHandle: null, marketVerifiedAt: null, hyperliquidConnectedAt: null, polymarketConnectedAt: null, chiefOfStaffModel: null },
  wallet: EMPTY_WALLET, departments: [], templateOf: {}, templates: TEMPLATES,
  usage: { byDepartment: [], companyTodayCents: 0, companySevenDayAvgCents: 0 }, totalMeteredCents: 0,
  questsByDept: {}, results: [], marketEarnedCents: 0, marketJobsPaid: 0, pendingApprovals: [],
});
const nearBal = (n: bigint) => ({ token: 'NEAR', amount: String(n * 10n ** 24n), decimals: 24, source: 'wallet' as const, chain: 'near', usd: null, logo: null });
const done = (i: GameInput, id: string) => deriveGame(i).quests.find((q) => q.id === id)!.done;

// each quest: an input where it is not done, and the change that makes it done
const cases: Array<[string, (i: GameInput) => void]> = [
  ['connect-ai', (i) => { i.settings.nearAiApiKeySet = true; i.settings.chiefOfStaffModel = 'deepseek/deepseek-v4.1-flash'; }],
  ['treasury', (i) => { i.wallet = { ...EMPTY_WALLET, registered: true, binding: { accountId: 'boss.near', status: 'active' } }; }],
  ['hire', (i) => { i.departments = [dept('d1')]; }],
  ['connect-hyperliquid', (i) => { i.settings.hyperliquidConnectedAt = '2026-11-08T10:00:00Z'; }],
  ['connect-polymarket', (i) => { i.settings.polymarketConnectedAt = '2026-11-08T10:00:00Z'; }],
  ['market', (i) => { i.settings.marketVerifiedAt = '2026-11-08T10:00:00Z'; }],
  ['first-job', (i) => { i.marketJobsPaid = 1; }], // a 0 USD test hire counts
  ['dao-funds', (i) => { i.wallet = { ...EMPTY_WALLET, registered: true, balances: [nearBal(6n)] }; }],
  ['ipo', (i) => { i.templateOf = { tops: 'treasury-ops' }; i.results = [{ departmentId: 'tops', questId: 'q', text: 'Vault live. [dao account=acme.sputnik-dao.near]' }]; }],
];
for (const [id, make] of cases) test(`CEO quest ${id}: not done, then done`, () => {
  const i = base();
  assert.equal(done(i, id), false);
  make(i);
  assert.equal(done(i, id), true);
});

test('the DAO vault needs enough NEAR, and only Treasury Ops can launch it', () => {
  const i = base();
  i.wallet = { ...EMPTY_WALLET, registered: true, balances: [nearBal(5n)] };
  assert.equal(done(i, 'dao-funds'), false, '5 NEAR is short');
  i.templateOf = { mk: 'marketplace-agency' };
  i.results = [{ departmentId: 'mk', questId: 'q', text: '[dao account=acme.sputnik-dao.near]' }];
  assert.equal(done(i, 'ipo'), false);
});

test('the main line is set up, earn, go public; the connector quests are side quests', () => {
  const g = deriveGame(base());
  assert.deepEqual(g.quests.filter((q) => !q.side).map((q) => q.id), ['connect-ai', 'treasury', 'hire', 'market', 'first-job', 'dao-funds', 'ipo']);
  assert.deepEqual(g.quests.filter((q) => q.side).map((q) => q.id), ['connect-hyperliquid', 'connect-polymarket']);
  const i = base();
  i.marketJobsPaid = 1;
  assert.equal(deriveGame(i).ipoUnlocked, false, 'a job alone does not fund the vault');
  i.wallet = { ...EMPTY_WALLET, registered: true, balances: [nearBal(6n)] };
  assert.equal(deriveGame(i).ipoUnlocked, true);
});

test('templates lock until the Chief of Staff is set up (key and model) and their own quest is done', () => {
  const i = base();
  assert.ok(Object.values(deriveGame(i).locked).every(Boolean), 'nothing before NEAR AI');
  i.settings.nearAiApiKeySet = true;
  assert.ok(Object.values(deriveGame(i).locked).every(Boolean), 'a key alone is not enough: the Chief of Staff needs a model');
  i.settings.chiefOfStaffModel = 'deepseek/deepseek-v4.1-flash';
  let l = deriveGame(i).locked;
  assert.equal(l['marketplace-agency'], true);
  i.settings.marketVerifiedAt = '2026-11-08T10:00:00Z';
  l = deriveGame(i).locked;
  assert.equal(l['marketplace-agency'], false);
  assert.equal(l['trading-desk'], true);
});

test('a funded treasury opens Treasury Ops; perps and prediction markets wait for their connector policy', () => {
  const i = base();
  i.settings.nearAiApiKeySet = true; i.settings.chiefOfStaffModel = 'deepseek/deepseek-v4.1-flash';
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
  assert.equal(g.quests.length, 9);
  assert.ok(!g.quests.some((q: any) => ['first-ship', 'connect-github'].includes(q.id)));
  assert.ok(!g.quests.some((q: any) => q.id === 'policy'), 'no self-confirmed policy quest');
  assert.equal(g.quests.find((q: any) => q.id === 'connect-hyperliquid').unlocks, 'Trading Desk');
  assert.equal(g.quests.find((q: any) => q.id === 'connect-polymarket').unlocks, 'Prediction Desk');
  const tl = (await app.inject('/api/templates')).json();
  assert.equal(tl.find((t: any) => t.id === 'trading-desk').locked, true);
  assert.ok(!tl.some((t: any) => ['software', 'red-team', 'blue-team', 'token-treasury'].includes(t.id)));
});
