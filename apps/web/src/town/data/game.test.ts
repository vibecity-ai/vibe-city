import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GameState } from '@vibe-city/shared';
import { decisionTarget, nextQuest, questTarget } from './game.ts';

const fixture: GameState = {
  quests: [
    { id: 'connect-ai', title: 'Connect NEAR AI Cloud', done: true, hint: '', unlocks: 'Hiring' },
    { id: 'connect-github', title: 'Connect GitHub', done: true, hint: '', unlocks: 'Software Department' },
    { id: 'treasury', title: 'Set up the treasury', done: false, hint: 'Create the company wallet…', unlocks: 'Treasury Ops' },
    { id: 'hire', title: 'Hire your first department', done: false, hint: '', unlocks: null },
  ],
  decisions: [], runway: { creditsRemainingCents: null, dailyBurnCents: 0, days: null, earnedCents: 0, estimated: true }, ipoUnlocked: false,
};

test('the quest log highlights the first quest not done, and its button opens the right panel', () => {
  const next = nextQuest(fixture)!;
  assert.equal(next.id, 'treasury');
  assert.deepEqual(questTarget(next.id), { kind: 'safe' });
  assert.deepEqual(questTarget('hire'), { kind: 'hire' });
  assert.deepEqual(questTarget('market'), { kind: 'market' });
  assert.deepEqual(questTarget('first-job'), { kind: 'market' }, 'claim, go live and hire the agency');
  assert.deepEqual(questTarget('connect-hyperliquid'), { kind: 'connector', name: 'hyperliquid' });
  assert.equal(questTarget('policy'), null, 'the self-confirmed policy quest is gone');
  assert.equal(questTarget('connect-ai')?.kind, 'note');
  assert.equal(nextQuest({ ...fixture, quests: fixture.quests.map((q) => ({ ...q, done: true })) }), null);
});

test('a decision href leads to its quest, the floor settings or a chat', () => {
  assert.deepEqual(decisionTarget('quest/d1/q9'), { kind: 'quest', questId: 'q9' });
  assert.deepEqual(decisionTarget('settings/d1'), { kind: 'settings', deptId: 'd1' });
  assert.deepEqual(decisionTarget('chat/d1/chief'), { kind: 'chat', deptId: 'd1', agentKey: 'chief' });
  assert.equal(decisionTarget('nonsense'), null);
});

test('the quest log groups quests into three acts in order, and counts progress', async () => {
  const { acts, progressLabel } = await import('./game.ts');
  const g = { ...fixture, quests: [...fixture.quests, { id: 'ipo', title: 'IPO', done: false, hint: '', unlocks: 'IPO button' }, { id: 'new-quest', title: 'New', done: false, hint: '', unlocks: null }] };
  const a = acts(g);
  assert.deepEqual(a.map((x) => x.title), ['Set up the company', 'Earn', 'Go public']);
  assert.deepEqual(a[0]!.quests.map((q) => q.id), ['connect-ai', 'connect-github', 'treasury', 'hire', 'new-quest']);
  assert.deepEqual(a[2]!.quests.map((q) => q.id), ['ipo']);
  assert.equal(progressLabel(g), '2 of 6 done');
});
