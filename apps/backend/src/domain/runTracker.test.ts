import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runState } from './runTracker.ts';

test('runState maps Hermes statuses without guessing', () => {
  assert.equal(runState({ status: 'running', outcome: null, ended_at: null }), 'running');
  assert.equal(runState({ status: 'done', outcome: 'completed', ended_at: 5 }), 'completed');
  assert.equal(runState({ status: 'crashed', outcome: 'crashed', ended_at: 5 }), 'failed');
  assert.equal(runState({ status: 'reclaimed', outcome: 'reclaimed', ended_at: 5 }), 'cancelled');
  assert.equal(runState({ status: 'weird', outcome: null, ended_at: 5 }), 'unknown');
});
