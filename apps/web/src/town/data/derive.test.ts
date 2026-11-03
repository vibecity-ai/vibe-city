import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DepartmentView, QuestDetail, TaskNode } from '@vibe-city/shared';
import { assignSlots, deriveDept, workerStatus, type DeriveInput } from './derive.ts';

const dept = (o: Partial<DepartmentView> = {}): DepartmentView => ({
  id: '11111111-1111-4111-8111-111111111111', name: 'Research', purpose: 'p', floorOrder: 1, floorPosition: 1, state: 'ready',
  workspace: { configured: false, label: null, isolation: 'unverified' }, chiefProfileRef: 'vc-chief', workerProfileRef: 'vc-worker',
  hermesBoardSlug: 'vc-x', hermesBoardRef: 'vc-x', boardSyncState: 'synced', archivedAt: null, createdAt: '2026-11-03T10:00:00Z', updatedAt: '2026-11-03T10:00:00Z', ...o,
});
const task = (o: Partial<TaskNode>): TaskNode => ({
  id: 't_aaaa', title: 'task', role: 'worker', assignee: 'vc-worker', status: 'todo', parentIds: [], childIds: [], depth: 1, failed: false,
  createdAt: '2026-11-03T10:00:00Z', startedAt: null, completedAt: null, summary: null, error: null, attachmentCount: 0, runs: [], ...o,
});
const quest = (tasks: TaskNode[], o: Partial<QuestDetail> = {}): QuestDetail => ({
  id: 't_root', title: 'Quest', status: 'running',
  flags: { planningComplete: false, delegated: true, hasFailures: false, hasBlocked: false, idle: false, unauthorizedAssignees: false },
  counts: { tasks: tasks.length, done: 0, running: 0, pending: 0, blocked: 0, failed: 0, archived: 0 },
  createdAt: null, completedAt: null, departmentId: dept().id, objective: 'o', tasks, violations: [],
  cancellation: { state: 'none', requestedAt: null, confirmedAt: null, remaining: [], archivedTaskIds: [], alreadyFinishedTaskIds: [] },
  warnings: [], truncated: false, ...o,
});
const input = (o: Partial<DeriveInput> = {}): DeriveInput => ({
  dept: dept(), provisioning: null, liveQuests: [], maxWorkers: 2, chiefModel: null, slots: new Map(), hermesUp: true, ...o,
});

test('worker status mirrors the Kanban task, never invents progress', () => {
  assert.equal(workerStatus({ status: 'running', failed: false }), 'running');
  assert.equal(workerStatus({ status: 'done', failed: false }), 'completed');
  assert.equal(workerStatus({ status: 'blocked', failed: true }), 'failed');
  assert.equal(workerStatus({ status: 'blocked', failed: false }), 'idle');
  assert.equal(workerStatus({ status: 'review', failed: false }), 'idle');
  assert.equal(workerStatus({ status: 'todo', failed: false }), 'idle');
});

test('slots are stable, lowest-free, and capped', () => {
  const a = assignSlots(new Map(), [{ id: 'a', status: 'running' }, { id: 'b', status: 'running' }]);
  assert.deepEqual([...a], [['a', 0], ['b', 1]]);
  // a leaves, c arrives: b keeps its desk, c takes the freed one
  const b = assignSlots(a, [{ id: 'b', status: 'running' }, { id: 'c', status: 'running' }]);
  assert.equal(b.get('b'), 1);
  assert.equal(b.get('c'), 0);
  const many = assignSlots(new Map(), Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, status: 'idle' as const })));
  assert.equal(many.size, 6);
});

test('a running task outranks finished ones when desks run out', () => {
  const tasks = [...Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, status: 'completed' as const })), { id: 'r', status: 'running' as const }];
  assert.ok(assignSlots(new Map(), tasks).has('r'));
});

test('unprovisioned department has no chief and is unconfigured', () => {
  const { dept: d } = deriveDept(input({ dept: dept({ state: 'unconfigured' }) }));
  assert.equal(d.state, 'unconfigured');
  assert.equal(d.chief, null);
  assert.deepEqual(d.workers, []);
});

test('provisioning error needs attention and carries the backend message', () => {
  const prov = { error: { message: 'token rejected' } } as never;
  const { dept: d } = deriveDept(input({ dept: dept({ state: 'error' }), provisioning: prov }));
  assert.equal(d.state, 'attention');
  assert.equal(d.attention, 'token rejected');
});

test('ready department with no quests is idle and has no workers', () => {
  const { dept: d } = deriveDept(input());
  assert.equal(d.state, 'idle');
  assert.equal(d.chief?.status, 'idle');
  assert.equal(d.workers.length, 0);
});

test('workers appear only for real worker tasks; chief runs while its task runs', () => {
  const q = quest([
    task({ id: 't_root', role: 'chief', depth: 0, status: 'running', startedAt: '2026-11-03T10:05:00Z' }),
    task({ id: 't_w1', title: 'Scrape', status: 'running', startedAt: '2026-11-03T10:06:00Z' }),
    task({ id: 't_other', role: 'other', status: 'running' }),
    task({ id: 't_old', status: 'archived' }),
  ], { status: 'planning' });
  const { dept: d } = deriveDept(input({ liveQuests: [q] }));
  assert.equal(d.state, 'active');
  assert.equal(d.chief?.status, 'running');
  assert.match(d.chief!.activity, /Planning/);
  assert.deepEqual(d.workers.map((w) => [w.id, w.taskId, w.status]), [['W-01', 't_w1', 'running']]);
});

test('a failed worker task puts the floor in attention', () => {
  const q = quest([task({ id: 't_w1', status: 'blocked', failed: true, title: 'Review DPA' })]);
  const { dept: d } = deriveDept(input({ liveQuests: [q] }));
  assert.equal(d.state, 'attention');
  assert.equal(d.workers[0]?.status, 'failed');
  assert.match(d.attention!, /Review DPA/);
});

test('chief finishing planning is not shown as completion', () => {
  const q = quest([task({ id: 't_root', role: 'chief', depth: 0, status: 'done', completedAt: '2026-11-03T10:07:00Z' }), task({ id: 't_w1', status: 'todo' })], { flags: { ...quest([]).flags, planningComplete: true } });
  const { dept: d } = deriveDept(input({ liveQuests: [q] }));
  assert.equal(d.chief?.status, 'idle');
  assert.match(d.chief!.activity, /Planning finished/);
});

test('Hermes down turns a ready floor offline and every agent disconnected', () => {
  const q = quest([task({ id: 't_w1', status: 'running' })]);
  const { dept: d } = deriveDept(input({ liveQuests: [q], hermesUp: false }));
  assert.equal(d.state, 'offline');
  assert.equal(d.chief?.status, 'disconnected');
  assert.equal(d.workers[0]?.status, 'disconnected');
});
