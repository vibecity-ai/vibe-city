import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Character } from '@vibe-city/shared';
import { agentLabel } from './views.ts';

test('agents are shown by persona name, else by role, never by seat key', () => {
  assert.equal(agentLabel('W-02', { name: 'Ada' } as Character), 'Ada');
  assert.equal(agentLabel('chief'), 'Lead');
  assert.equal(agentLabel('W-02'), 'Teammate 2');
  assert.equal(agentLabel(null), 'Someone outside the floor');
});
