import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GameState } from '@vibe-city/shared';
import { decisionTarget, nextQuest, questTarget } from './game.ts';

const fixture: GameState = {
  quests: [
    { id: 'connect-ai', title: 'Connect NEAR AI Cloud', done: true, hint: '', unlocks: 'Hiring' },
    { id: 'connect-github', title: 'Connect GitHub', done: true, hint: '', unlocks: 'Software Department' },
    { id: 'treasury', title: 'Set up the treasury', done: false, hint: 'Create the company wallet…', unlocks: 'Trading Desk' },
    { id: 'hire', title: 'Hire your first department', done: false, hint: '', unlocks: null },
  ],
  decisions: [], runway: { creditsRemainingCents: null, dailyBurnCents: 0, days: null, earnedCents: 0, estimated: true }, ipoUnlocked: false,
};

test('the quest log highlights the first quest not done, and its button opens the right panel', () => {
  const next = nextQuest(fixture)!;
  assert.equal(next.id, 'treasury');
  assert.deepEqual(questTarget(next.id), { kind: 'safe' });
  assert.deepEqual(questTarget('hire'), { kind: 'hire' });
  assert.deepEqual(questTarget('policy'), { kind: 'confirm-policy' });
  assert.equal(questTarget('connect-ai')?.kind, 'note');
  assert.equal(nextQuest({ ...fixture, quests: fixture.quests.map((q) => ({ ...q, done: true })) }), null);
});

test('a decision href leads to its quest, the floor settings or a chat', () => {
  assert.deepEqual(decisionTarget('quest/d1/q9'), { kind: 'quest', questId: 'q9' });
  assert.deepEqual(decisionTarget('settings/d1'), { kind: 'settings', deptId: 'd1' });
  assert.deepEqual(decisionTarget('chat/d1/chief'), { kind: 'chat', deptId: 'd1', agentKey: 'chief' });
  assert.equal(decisionTarget('nonsense'), null);
});
