import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GameState, QuestSummary } from '@vibe-city/shared';
import { BELL_S, BELL_STRIKES, bellStrike, bellSwing, fxBetween, questsCompleted } from './fx.ts';
import type { Dept } from './types.ts';

const dept = (id: string, workers: { id: string; status: string; taskId?: string }[] = []) =>
  ({ id, chief: { status: 'idle' }, workers: workers.map((w) => ({ taskId: null, ...w })) }) as unknown as Dept;
const quest = (deptId: string, id: string, status: QuestSummary['status'], title = id) => ({ deptId, summary: { id, title, status } as QuestSummary });

test('a new job, a finished one and one waiting on you each make a moment', () => {
  const d = [dept('a')];
  assert.deepEqual(fxBetween(d, d, [], [quest('a', 'q1', 'queued', 'Write the brief')]), [{ k: 'questStarted', dept: 'a', title: 'Write the brief' }]);
  assert.deepEqual(fxBetween(d, d, [quest('a', 'q1', 'running')], [quest('a', 'q1', 'completed')]), [{ k: 'questDone', dept: 'a', title: 'q1' }]);
  assert.deepEqual(fxBetween(d, d, [quest('a', 'q1', 'running')], [quest('a', 'q1', 'awaiting_input')]), [{ k: 'needsYou', dept: 'a', title: 'q1' }]);
  assert.deepEqual(fxBetween(d, d, [quest('a', 'q1', 'completed')], [quest('a', 'q1', 'completed')]), [], 'nothing changed, nothing said');
  assert.deepEqual(fxBetween(d, d, [], [quest('a', 'old', 'completed')]), [], 'a finished job seen for the first time is history, not news');
});

test('a brand-new floor is one moment, not one per job it arrives with', () => {
  const fx = fxBetween([dept('a')], [dept('a'), dept('b')], [], [quest('b', 'q1', 'queued')]);
  assert.deepEqual(fx, [{ k: 'floorAdded', dept: 'b' }]);
});

test('a new teammate and a task finishing are city events too', () => {
  const before = [dept('a', [{ id: 'W-01', status: 'running', taskId: 't1' }])];
  const after = [dept('a', [{ id: 'W-01', status: 'completed', taskId: 't1' }, { id: 'W-02', status: 'idle' }])];
  assert.deepEqual(fxBetween(before, after, [], []), [{ k: 'taskDone', dept: 'a', worker: 'W-01' }, { k: 'workerJoined', dept: 'a', worker: 'W-02' }]);
});

test('the opening bell hangs still at both ends and is at full swing, on alternating sides, at every strike', () => {
  assert.equal(bellSwing(0), 0);
  assert.equal(bellSwing(BELL_S), 0);
  for (let k = 0; k < BELL_STRIKES; k++) {
    assert.ok(bellStrike(k) < BELL_S);
    assert.ok(Math.abs(bellSwing(bellStrike(k)) - (k % 2 ? -0.42 : 0.42)) < 1e-9, `strike ${k}`);
  }
});

test('a quest-log quest turning done is a moment; the first load and the IPO are not', () => {
  const g = (done: string[]) => ({ quests: ['connect-ai', 'treasury', 'ipo'].map((id) => ({ id, title: id, done: done.includes(id), hint: '', unlocks: id === 'connect-ai' ? 'Hiring' : null, side: false })) }) as unknown as GameState;
  assert.deepEqual(questsCompleted(g([]), g(['connect-ai'])), [{ k: 'questComplete', title: 'connect-ai', unlocks: 'Hiring' }]);
  assert.deepEqual(questsCompleted(null, g(['connect-ai'])), [], 'already done on load: history');
  assert.deepEqual(questsCompleted(g(['connect-ai']), g(['connect-ai'])), [], 'nothing changed');
  assert.deepEqual(questsCompleted(g(['treasury']), g(['treasury', 'ipo'])), [], 'the opening bell has its own banner');
});
