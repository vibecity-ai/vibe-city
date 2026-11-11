import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GameState } from '@vibe-city/shared';
import { decisionTarget, ipoRang, ipoSteps, ipoSymbol, nextQuest, questTarget } from './game.ts';
import { IPO_SYMBOL_RE } from '@vibe-city/shared';

const fixture: GameState = {
  quests: [
    { id: 'connect-ai', title: 'Set up your Chief of Staff', done: true, hint: '', unlocks: 'Hiring', side: false },
    { id: 'connect-hyperliquid', title: 'Connect Hyperliquid', done: false, hint: '', unlocks: 'Trading Desk', side: true },
    { id: 'treasury', title: 'Set up the treasury', done: false, hint: 'Create the company wallet…', unlocks: 'Treasury Ops', side: false },
    { id: 'hire', title: 'Hire your first department', done: false, hint: '', unlocks: null, side: false },
  ],
  decisions: [], runway: { creditsRemainingCents: null, dailyBurnCents: 0, days: null, earnedCents: 0, estimated: true }, ipoUnlocked: false,
};

test('the quest log highlights the first quest not done, and its button opens the right panel', () => {
  const next = nextQuest(fixture)!;
  assert.equal(next.id, 'treasury', 'an open side quest is never next');
  assert.deepEqual(questTarget(next.id), { kind: 'safe' });
  assert.deepEqual(questTarget('hire'), { kind: 'hire' });
  assert.deepEqual(questTarget('market'), { kind: 'market' });
  assert.deepEqual(questTarget('first-job'), { kind: 'market' }, 'claim, go live and hire the agency');
  assert.deepEqual(questTarget('connect-hyperliquid'), { kind: 'connector', name: 'hyperliquid' });
  assert.equal(questTarget('policy'), null, 'the self-confirmed policy quest is gone');
  assert.equal(questTarget('connect-ai')?.kind, 'cos');
  assert.deepEqual(questTarget('dao-funds'), { kind: 'safe' });
  assert.deepEqual(questTarget('ipo'), { kind: 'safe' }, 'the IPO card sits in the safe');
  assert.equal(nextQuest({ ...fixture, quests: fixture.quests.map((q) => ({ ...q, done: !q.side })) }), null);
});

test('a decision href leads to its quest, the floor settings or a chat', () => {
  assert.deepEqual(decisionTarget('quest/d1/q9'), { kind: 'quest', questId: 'q9' });
  assert.deepEqual(decisionTarget('settings/d1'), { kind: 'settings', deptId: 'd1' });
  assert.deepEqual(decisionTarget('chat/d1/chief'), { kind: 'chat', deptId: 'd1', agentKey: 'chief' });
  assert.equal(decisionTarget('nonsense'), null);
});

test('the quest log groups quests into three acts in order, and counts progress', async () => {
  const { acts, progressLabel } = await import('./game.ts');
  const { sideQuests } = await import('./game.ts');
  const g = { ...fixture, quests: [...fixture.quests, { id: 'ipo', title: 'IPO', done: false, hint: '', unlocks: 'the opening bell', side: false }, { id: 'new-quest', title: 'New', done: false, hint: '', unlocks: null, side: false }] };
  const a = acts(g);
  assert.deepEqual(a.map((x) => x.title), ['Set up the company', 'Earn', 'Go public']);
  assert.deepEqual(a[0]!.quests.map((q) => q.id), ['connect-ai', 'treasury', 'hire', 'new-quest']);
  assert.deepEqual(a[2]!.quests.map((q) => q.id), ['ipo']);
  assert.deepEqual(sideQuests(g).map((q) => q.id), ['connect-hyperliquid']);
  assert.equal(progressLabel(g), '1 of 5 done', 'side quests do not count');
});

test('the IPO symbol is the company initials, 2 to 8 capitals, always a valid symbol', () => {
  assert.equal(ipoSymbol('Vibe City Labs'), 'VCL');
  assert.equal(ipoSymbol('acme'), 'ACME');
  assert.equal(ipoSymbol('Acme Robotics & Co.'), 'ARC');
  assert.equal(ipoSymbol('42 Widgets'), 'WIDGETS');
  assert.equal(ipoSymbol('Supercalifragilistic'), 'SUPERCAL');
  assert.equal(ipoSymbol(''), 'VCT');
  assert.equal(ipoSymbol('x'), 'VCT');
  for (const n of ['Vibe City Labs', 'acme', '42 Widgets', '', 'a b c d e f g h i j']) assert.match(ipoSymbol(n), IPO_SYMBOL_RE);
});

test('IPO steps: preview, working, waiting for OutLayer approval on the right step, failed, done', () => {
  const base = { state: 'ready' as const, awaiting: null, daoAccountId: null, tokenAccountId: null, symbol: 'ACME' };
  const st = (x: Partial<typeof base> | Record<string, unknown>, busy = false) => ipoSteps({ ...base, ...x } as Parameters<typeof ipoSteps>[0], busy).map((s) => s.status);
  assert.deepEqual(st({}), ['todo', 'todo', 'todo'], 'a preview before the CEO presses IPO');
  assert.deepEqual(st({}, true), ['working', 'todo', 'todo']);
  assert.deepEqual(st({ state: 'awaiting_approval', awaiting: 'sputnik-dao.near create' }), ['approval', 'todo', 'todo']);
  assert.deepEqual(st({ state: 'awaiting_approval', awaiting: 'wrap.near storage_deposit', daoAccountId: 'a.sputnik-dao.near' }), ['done', 'approval', 'todo']);
  assert.deepEqual(st({ state: 'awaiting_approval', awaiting: 'tokens.vibecity.near create_token', daoAccountId: 'a.sputnik-dao.near' }), ['done', 'done', 'approval']);
  assert.deepEqual(st({ state: 'error', daoAccountId: 'a.sputnik-dao.near' }), ['done', 'failed', 'todo']);
  assert.deepEqual(st({ state: 'error', daoAccountId: 'a.sputnik-dao.near', error: "The wallet's call to tokens.vibecity.near create_token did not succeed: failed" }), ['done', 'done', 'failed'], 'the step the error names');
  assert.deepEqual(st({ state: 'error', daoAccountId: 'a.sputnik-dao.near' }, true), ['done', 'working', 'todo'], 'a retry in flight');
  assert.deepEqual(st({ state: 'done', daoAccountId: 'a', tokenAccountId: 't' }), ['done', 'done', 'done']);
});

test('the bell rings when the IPO completes in front of the player, never for one that was already done', () => {
  assert.equal(ipoRang('running', 'done'), true);
  assert.equal(ipoRang('awaiting_approval', 'done'), true);
  assert.equal(ipoRang(null, 'done'), false); // first load of a listed company
  assert.equal(ipoRang('done', 'done'), false);
  assert.equal(ipoRang('ready', 'running'), false);
});
