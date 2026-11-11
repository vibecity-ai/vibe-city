import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCharacter } from './domain/characters.ts';
import { memApp } from './testUtils.ts';

test('no two agents in the company share a name: template seats, blank floors and across floors', async () => {
  const { app } = memApp();
  // ~70 agents from 672 possible names: without a company-wide check a collision is near certain
  for (const payload of [{ name: 'Treasury', template: 'treasury-ops' }, { name: 'Trading', template: 'trading-desk' }, { name: 'Predictions', template: 'prediction-desk' },
    ...Array.from({ length: 10 }, (_, i) => ({ name: `Floor ${i}`, teammates: 5 }))]) {
    const r = await app.inject({ method: 'POST', url: '/api/departments', payload });
    assert.equal(r.statusCode, 201, r.body);
  }
  const depts = (await app.inject('/api/departments')).json().departments as { id: string; agents: { key: string }[] }[];
  const names: string[] = [];
  for (const d of depts) for (const a of d.agents) names.push((await app.inject(`/api/departments/${d.id}/characters/${a.key}`)).json().name);
  assert.equal(new Set(names).size, names.length, `duplicate in ${names.join(', ')}`);
});

test('two agents of one floor never share a generated name', () => {
  const lead = generateCharacter('d1', 'Desk', 'chief');
  assert.equal(generateCharacter('d1', 'Desk', 'chief').name, lead.name, 'deterministic');
  const other = generateCharacter('d1', 'Desk', 'chief', new Set([lead.name]));
  assert.notEqual(other.name, lead.name, 'a taken name is picked again');
});
