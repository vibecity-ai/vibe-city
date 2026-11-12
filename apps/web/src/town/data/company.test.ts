import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskNode } from '@vibe-city/shared';
import { COLUMNS, RAIL_NAME, age, attentionReason, cardLines, crewOf, lanes, objectiveText, searchSort, tickerItems, ticketStamp, trayQuests, type BoardQuest } from './company.ts';
import type { Dept } from './types.ts';

const q = (title: string, dept: string, createdAt: string): BoardQuest => ({
  deptId: dept, deptName: dept, floor: 'F1',
  summary: { id: title, title, status: 'running', createdAt, completedAt: null, flags: { planningComplete: false, delegated: false, hasFailures: false, hasBlocked: false, idle: false, unauthorizedAssignees: false }, counts: { tasks: 0, done: 0, running: 0, pending: 0, blocked: 0, failed: 0, archived: 0 } },
} as unknown as BoardQuest);

test('board search matches title or department, every word, any order; sort is stable and explicit', () => {
  const list = [q('Weekly metrics recap', 'Growth', '2026-11-03T10:00:00Z'), q('Competitor pricing', 'Research', '2026-11-02T10:00:00Z'), q('Analyst digest', 'Research', '2026-11-01T10:00:00Z')];
  assert.deepEqual(searchSort(list, 'research pric', 'newest').map((x) => x.summary.title), ['Competitor pricing']);
  assert.deepEqual(searchSort(list, '  ', 'newest').length, 3);
  assert.deepEqual(searchSort(list, '', 'oldest').map((x) => x.summary.title), ['Analyst digest', 'Competitor pricing', 'Weekly metrics recap']);
  assert.deepEqual(searchSort(list, '', 'title').map((x) => x.summary.title)[0], 'Analyst digest');
  assert.equal(list[0]!.summary.title, 'Weekly metrics recap', 'input is not mutated');
});

test('card age is compact', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  assert.equal(age('2026-11-03T11:59:40Z', now), 'now');
  assert.equal(age('2026-11-03T11:55:00Z', now), '5m');
  assert.equal(age('2026-11-03T09:00:00Z', now), '3h');
  assert.equal(age('2026-11-01T12:00:00Z', now), '2d');
  assert.equal(age(null, now), '');
});

const t = (o: Partial<TaskNode> & { id: string; title: string }): TaskNode => ({
  agentKey: 'W-01', assignee: null, status: 'todo', parentIds: [], childIds: [], depth: 1, failed: false,
  createdAt: '2026-11-03T10:00:00Z', startedAt: null, completedAt: null, summary: null, error: null, blockReason: null, attachmentCount: 0, runs: [], note: null, ...o,
});

test('card lines: the plan from the lead, then a failure beats running beats done; nothing invented', () => {
  const root = t({ id: 'r', title: 'Quest', agentKey: 'chief', depth: 0, status: 'done', summary: 'Plan: split into 3 tasks' });
  assert.deepEqual(cardLines(undefined), { plan: null, latest: null });
  assert.equal(cardLines([root]).plan, 'split into 3 tasks');
  assert.equal(cardLines([root]).latest, null);
  const done = t({ id: 'a', title: 'Collect', status: 'done', completedAt: '2026-11-03T11:00:00Z' });
  const run = t({ id: 'b', title: 'Compare', status: 'running', startedAt: '2026-11-03T11:10:00Z' });
  const bad = t({ id: 'c', title: 'Scrape', status: 'blocked', failed: true, error: 'HTTP 403' });
  assert.deepEqual(cardLines([root, done]).latest, { k: 'completed', text: 'Last done: Collect' });
  assert.deepEqual(cardLines([root, done, run]).latest, { k: 'running', text: 'Working on: Compare' });
  assert.deepEqual(cardLines([root, done, run, bad]).latest, { k: 'failed', text: 'Scrape: HTTP 403' });
  assert.deepEqual(cardLines([root, t({ id: 'd', title: 'X' }), t({ id: 'e', title: 'Y' })]).latest, { k: 'todo', text: '2 tasks waiting' });
});

test('attention cards say why; crew is lead first, from the task tree; lanes keep floor order and skip empty floors', () => {
  const c = { blocked: 0, failed: 0 };
  assert.equal(attentionReason({ status: 'awaiting_input', counts: c }), 'An agent is waiting for your answer');
  assert.equal(attentionReason({ status: 'failed', counts: { blocked: 0, failed: 2 } }), '2 tasks failed');
  assert.equal(attentionReason({ status: 'running', counts: c }), null);
  assert.deepEqual(crewOf(undefined), ['chief']);
  const t = (agentKey: string | null, depth: number) => ({ agentKey, depth } as unknown as TaskNode);
  assert.deepEqual(crewOf([t('W-02', 1), t('chief', 0), t('W-01', 1), t('W-02', 1), t(null, 1)]), ['chief', 'W-02', 'W-01']);
  const depts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as unknown as Dept[];
  const list = [{ ...q('x', 'c', ''), deptId: 'c' }, { ...q('y', 'a', ''), deptId: 'a' }] as BoardQuest[];
  assert.deepEqual(lanes(depts, list).map((l) => [l.dept.id, l.floor, l.quests.length]), [['a', 'F3', 1], ['c', 'F1', 1]]);
});

test('the ticker leads with what needs the CEO, then floors at work, then the last three finished quests', () => {
  const quest = (title: string, dept: string, status: string, completedAt: string | null = null) =>
    ({ deptId: dept, summary: { ...q(title, dept, '2026-11-01T00:00:00Z').summary, status, completedAt } }) as unknown as BoardQuest;
  const depts = [
    { id: 'a', name: 'Growth', chief: { status: 'running' }, workers: [{ status: 'running' }, { status: 'idle' }] },
    { id: 'b', name: 'Research', chief: { status: 'idle' }, workers: [] },
  ] as unknown as Dept[];
  const items = tickerItems(depts, [
    quest('Old', 'b', 'completed', '2026-11-01T00:00:00Z'), quest('Newer', 'a', 'completed', '2026-11-03T00:00:00Z'),
    quest('Mid', 'b', 'completed', '2026-11-02T00:00:00Z'), quest('Oldest', 'a', 'completed', '2026-10-01T00:00:00Z'),
    quest('Stuck', 'b', 'failed'), quest('Busy', 'a', 'running'),
  ]);
  assert.deepEqual(items, [
    { tone: 'bad', text: 'Stuck: Research needs you' },
    { tone: 'run', text: 'Growth · 2 agents at work' },
    { tone: 'ok', text: 'Newer · done by Growth' }, { tone: 'ok', text: 'Mid · done by Research' }, { tone: 'ok', text: 'Old · done by Research' },
  ]);
  assert.deepEqual(tickerItems([], []), []);
});

test('every quest that needs the CEO or has ended carries a stamp; fresh and running tickets do not', () => {
  const all = ['queued', 'planning', 'running', 'cancelling', 'awaiting_input', 'in_review', 'failed', 'completed', 'cancelled'] as const;
  for (const s of all) {
    const col = COLUMNS.find((c) => c.has(s))!.key;
    assert.equal(!!ticketStamp(s), col === 'attention' || col === 'finished', s);
  }
  assert.equal(ticketStamp('failed')!.tone, 'bad');
  assert.deepEqual(Object.keys(RAIL_NAME).sort(), COLUMNS.map((c) => c.key).sort());
});

test('an objective drops a heading that only repeats the title', () => {
  assert.equal(objectiveText('# Quest: Referral programme copy\n\nWrite the emails.', 'Referral programme copy'), 'Write the emails.');
  assert.equal(objectiveText('## Referral programme copy', 'Referral programme copy'), '');
  assert.equal(objectiveText('# Plan the launch\nThen ship it.', 'Something else'), 'Plan the launch\nThen ship it.');
  assert.equal(objectiveText('Plain text.', 'T'), 'Plain text.');
});

test('the in tray drops a quest whose only blocker is a question already there as a decision', () => {
  const waiting = q('t_asked', 'd1', '2026-11-03T10:00:00Z'); waiting.summary.counts.blocked = 1;
  const stuck = q('t_stuck', 'd1', '2026-11-03T10:00:00Z'); stuck.summary.counts.blocked = 1; stuck.summary.counts.failed = 1;
  const other = q('t_other', 'd1', '2026-11-03T10:00:00Z'); other.summary.counts.blocked = 1;
  const decisions = [{ href: 'quest/d1/t_asked' }, { href: 'quest/d1/t_stuck' }];
  assert.deepEqual(trayQuests([waiting, stuck, other], decisions).map((x) => x.summary.id), ['t_stuck', 't_other']);
});
