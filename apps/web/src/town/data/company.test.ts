import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskNode } from '@vibe-city/shared';
import { age, cardLines, searchSort, type BoardQuest } from './company.ts';

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
  createdAt: '2026-11-03T10:00:00Z', startedAt: null, completedAt: null, summary: null, error: null, attachmentCount: 0, runs: [], ...o,
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
