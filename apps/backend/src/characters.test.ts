import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCharacter } from './domain/characters.ts';

test('two agents of one floor never share a generated name', () => {
  const lead = generateCharacter('d1', 'Desk', 'chief');
  assert.equal(generateCharacter('d1', 'Desk', 'chief').name, lead.name, 'deterministic');
  const other = generateCharacter('d1', 'Desk', 'chief', new Set([lead.name]));
  assert.notEqual(other.name, lead.name, 'a taken name is picked again');
});
