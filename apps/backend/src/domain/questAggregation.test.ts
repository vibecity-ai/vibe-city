import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateQuest, type AggNode } from './questAggregation.ts';

const n = (id: string, status: AggNode['status'], o: Partial<AggNode> = {}): AggNode => ({
  id, status, failed: false, everStarted: status !== 'ready' && status !== 'todo', activeRun: status === 'running', authorized: true, hasChildren: false, ...o,
});
const agg = (nodes: AggNode[], cancel = false) => aggregateQuest('root', nodes, cancel);

test('a finished chief task is NOT a finished quest: workers still pending -> running (idle)', () => {
  const r = agg([n('root', 'done', { hasChildren: true }), n('w1', 'ready'), n('w2', 'todo')]);
  assert.equal(r.status, 'running');
  assert.equal(r.flags.planningComplete, true);
  assert.equal(r.flags.idle, true);
  assert.deepEqual([r.counts.done, r.counts.pending], [1, 2]);
});

test('completed only when every task in the tree is done', () => {
  assert.equal(agg([n('root', 'done', { hasChildren: true }), n('w1', 'done'), n('w2', 'done')]).status, 'completed');
  assert.equal(agg([n('root', 'done')]).status, 'completed', 'chief finished without delegating');
  assert.equal(agg([n('root', 'done')]).flags.delegated, false);
});

test('nested descendants (grandchildren) count, not just direct children', () => {
  const nodes = [n('root', 'done', { hasChildren: true }), n('c1', 'done', { hasChildren: true }), n('g1', 'running')];
  assert.equal(agg(nodes).status, 'running');
  nodes[2] = n('g1', 'done');
  assert.equal(agg(nodes).status, 'completed');
  nodes[2] = n('g1', 'blocked', { failed: true });
  assert.equal(agg(nodes).status, 'failed');
});

test('queued: nothing has started', () => {
  assert.equal(agg([n('root', 'ready', { everStarted: false })]).status, 'queued');
  assert.equal(agg([n('root', 'triage', { everStarted: false })]).status, 'queued');
});

test('planning: only the chief is running and no worker tasks exist yet', () => {
  assert.equal(agg([n('root', 'running')]).status, 'planning');
  assert.equal(agg([n('root', 'running', { hasChildren: true }), n('w1', 'todo')]).status, 'running', 'children exist -> running');
});

test('failed: a worker blocked after failures; other done work does not hide it', () => {
  const r = agg([n('root', 'done', { hasChildren: true }), n('w1', 'done'), n('w2', 'blocked', { failed: true })]);
  assert.equal(r.status, 'failed');
  assert.equal(r.flags.hasFailures, true);
  assert.equal(r.counts.failed, 1);
});

test('a running task takes precedence over a failure elsewhere (the quest is still active)', () => {
  const r = agg([n('root', 'done', { hasChildren: true }), n('w1', 'running'), n('w2', 'blocked', { failed: true })]);
  assert.equal(r.status, 'running');
  assert.equal(r.flags.hasFailures, true, 'failure is still surfaced as a flag');
});

test('awaiting_input: a deliberate block (not a failure)', () => {
  const r = agg([n('root', 'done', { hasChildren: true }), n('w1', 'blocked'), n('w2', 'done')]);
  assert.equal(r.status, 'awaiting_input');
  assert.equal(r.flags.hasBlocked, true);
  assert.equal(r.flags.hasFailures, false);
});

test('in_review beats awaiting_input; failed beats in_review', () => {
  assert.equal(agg([n('root', 'done', { hasChildren: true }), n('a', 'review'), n('b', 'blocked')]).status, 'in_review');
  assert.equal(agg([n('root', 'done', { hasChildren: true }), n('a', 'review'), n('b', 'blocked', { failed: true })]).status, 'failed');
});

test('cancellation: cancelling while anything is live or running; cancelled once nothing is', () => {
  assert.equal(agg([n('root', 'archived'), n('w1', 'running')], true).status, 'cancelling');
  assert.equal(agg([n('root', 'archived'), n('w1', 'ready')], true).status, 'cancelling');
  assert.equal(agg([n('root', 'archived'), n('w1', 'archived')], true).status, 'cancelled');
  assert.equal(agg([n('root', 'done'), n('w1', 'archived')], true).status, 'cancelled');
  const stillRunProcess = [n('root', 'archived'), n('w1', 'archived', { activeRun: true })];
  assert.equal(agg(stillRunProcess, true).status, 'cancelling', 'archived but the run has not ended yet');
});

test('cancel requested after everything finished: stays completed', () => {
  assert.equal(agg([n('root', 'done'), n('w1', 'done')], true).status, 'completed');
});

test('tasks archived outside Vibe City (no cancel marker) read as cancelled, not completed', () => {
  assert.equal(agg([n('root', 'done', { hasChildren: true }), n('w1', 'archived')]).status, 'cancelled');
});

test('unauthorized assignees are flagged but do not change the status', () => {
  const r = agg([n('root', 'done', { hasChildren: true }), n('w1', 'done', { authorized: false })]);
  assert.equal(r.status, 'completed');
  assert.equal(r.flags.unauthorizedAssignees, true);
});

