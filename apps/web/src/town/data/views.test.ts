import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Character } from '@vibe-city/shared';
import { agentLabel, nameProfiles, pickFiles } from './views.ts';

test('agents are shown by persona name, else by role, never by seat key', () => {
  assert.equal(agentLabel('W-02', { name: 'Ada' } as Character), 'Ada');
  assert.equal(agentLabel('chief'), 'Lead');
  assert.equal(agentLabel('W-02'), 'Teammate 2');
  assert.equal(agentLabel(null), 'Someone outside the floor');
});

test('dialogue text names teammates instead of their Hermes profile ids', () => {
  const agents = [{ key: 'chief', profileRef: 'vc-0e8bd7b1c040-lead' }, { key: 'W-01', profileRef: 'vc-0e8bd7b1c040-w01' }, { key: 'W-02', profileRef: null }];
  const label = (k: string) => (k === 'W-01' ? 'Theo Moreau' : 'Ines Petrov');
  assert.equal(nameProfiles('Our analyst, vc-0e8bd7b1c040-w01, has two tasks; vc-0e8bd7b1c040-lead reviews.', agents, label),
    'Our analyst, Theo Moreau, has two tasks; Ines Petrov reviews.');
});

test('reference files keep to Hermes limits and say why one was left out', () => {
  const f = (name: string, size = 10) => ({ name, size });
  assert.deepEqual(pickFiles([f('a.csv')], [f('a.csv'), f('b.pdf')]), { files: [f('a.csv'), f('b.pdf')], error: null }, 'same name once');
  const r = pickFiles([], [f('empty.txt', 0), f('huge.mov', 25 * 1024 * 1024 + 1), f('ok.md')]);
  assert.deepEqual(r.files.map((x) => x.name), ['ok.md']);
  assert.equal(r.error, '"empty.txt" is empty; "huge.mov" is over 25 MB.');
  const many = pickFiles(Array.from({ length: 9 }, (_, i) => f(`${i}`)), [f('x'), f('y'), f('z')]);
  assert.equal(many.files.length, 10);
  assert.equal(many.error, 'a job takes at most 10 files.');
});
