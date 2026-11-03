import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { QuestStatus, QuestSummary } from '@vibe-city/shared';
import type { Dept } from './types.ts';
import type { QuestItem } from '../store.ts';
import {
  COLUMNS, attentionCount, columnOf, companyQuests, defaultTarget, filterColumns, filterQuests, missingDepts, questTargets,
} from './company.ts';

const dept = (id: string, name: string, provisioning: Dept['provisioning'] = 'ready'): Dept =>
  ({ id, name, provisioning, chief: provisioning === 'ready' ? { name: `${name} Chief` } : null } as unknown as Dept);
const quest = (deptId: string, id: string, status: QuestStatus, createdAt: string | null = '2026-11-03T10:00:00Z'): QuestItem =>
  ({ deptId, summary: { id, title: id, status, createdAt } as QuestSummary });

// Tower order: index 0 is the top floor.
const depts = [dept('b', 'Research'), dept('a', 'Engineering'), dept('c', 'Design', 'unconfigured')];

test('every quest status lands in exactly one of the four columns', () => {
  const all: QuestStatus[] = ['queued', 'planning', 'running', 'cancelling', 'awaiting_input', 'in_review', 'failed', 'completed', 'cancelled'];
  for (const s of all) assert.equal(COLUMNS.filter((c) => c.has(s)).length, 1, s);
  assert.equal(columnOf('failed'), 'attention');
  assert.equal(columnOf('cancelling'), 'active');
  assert.deepEqual(filterColumns('active').map((c) => c.key), ['queued', 'active']);
});

test('the company board merges departments, labels floors, sorts newest first and drops archived departments', () => {
  const list = companyQuests(depts, [
    quest('a', 'old', 'queued', '2026-11-01T00:00:00Z'),
    quest('b', 'new', 'running', '2026-11-03T00:00:00Z'),
    quest('gone', 'orphan', 'running'),
    quest('a', 'undated', 'queued', null),
  ]);
  assert.deepEqual(list.map((q) => q.summary.id), ['new', 'old', 'undated']);
  assert.deepEqual(list.map((q) => [q.deptName, q.floor]), [['Research', 'F3'], ['Engineering', 'F2'], ['Engineering', 'F2']]);
  assert.deepEqual(filterQuests(list, 'a', 'all').map((q) => q.summary.id), ['old', 'undated']);
  assert.deepEqual(filterQuests(list, null, 'active').map((q) => q.summary.id), ['new', 'old', 'undated']);
  assert.deepEqual(filterQuests(list, null, 'finished'), []);
});

test('a department whose quests never loaded is reported missing, never as zero quests', () => {
  const m = missingDepts(depts, { b: 'ok', a: 'not_loaded', c: 'no_board' }, false);
  assert.equal(m.length, 1);
  assert.equal(m[0]!.sync, 'not_loaded');
  assert.match(m[0]!.text, /missing from this board, not zero/);
  assert.match(m[0]!.text, /Hermes is not reachable/);

  const stale = missingDepts(depts, { b: 'out_of_date', a: 'ok' }, true);
  assert.deepEqual(stale.map((x) => [x.id, x.sync]), [['b', 'out_of_date']]);
  assert.match(stale[0]!.text, /last refresh failed/);
  // filtered to one department: only that department's gap is reported
  assert.deepEqual(missingDepts(depts, { b: 'out_of_date', a: 'not_loaded' }, true, 'a').map((x) => x.id), ['a']);
});

test('only ready departments take quests; the reason is shown for the others', () => {
  const t = questTargets([...depts, dept('d', 'Ops', 'disconnected')], true);
  assert.deepEqual(t.map((o) => [o.id, o.disabled]), [['b', null], ['a', null], ['c', 'not provisioned'], ['d', 'Hermes resources not verified']]);
  assert.equal(t[0]!.label, 'F4 · Research');
  assert.equal(t[0]!.chief, 'Research Chief');
  assert.ok(questTargets(depts, false).every((o) => o.disabled), 'nothing can be created while Hermes is down');
});

test('the composer preselects the requested department only when it can take a quest', () => {
  const t = questTargets(depts, true);
  assert.equal(defaultTarget(t, 'a'), 'a');
  assert.equal(defaultTarget(t, 'c'), null, 'not provisioned: the player must choose');
  assert.equal(defaultTarget(t, null), null, 'two ready departments: no silent default');
  assert.equal(defaultTarget(questTargets([depts[0]!, depts[2]!], true), null), 'b', 'the only ready department');
});

test('the attention badge counts quests in the Needs attention column only', () => {
  assert.equal(attentionCount([quest('a', '1', 'failed'), quest('a', '2', 'awaiting_input'), quest('a', '3', 'running'), quest('a', '4', 'cancelled')]), 2);
});
