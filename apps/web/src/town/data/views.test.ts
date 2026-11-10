import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Character } from '@vibe-city/shared';
import { GREETINGS, agentLabel, bubbleText, envNameProblem, farewellLine, greetingLine, handoffLines, nameProfiles, pickFiles } from './views.ts';

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

test('floor env names are UPPER_SNAKE and never one Vibe City or Hermes sets', () => {
  assert.equal(envNameProblem(''), null);
  assert.equal(envNameProblem('SERPAPI_API_KEY'), null);
  for (const n of ['lower', 'A', '9LIVES', 'WITH-DASH']) assert.match(envNameProblem(n)!, /capitals/, n);
  for (const n of ['NEAR_AI_API_KEY', 'MARKET_AGENT_TOKEN', 'HERMES_HOME', 'PATH']) assert.match(envNameProblem(n)!, /itself/, n);
});

test('speech bubbles: the agent\'s own fresh note first, a short recap after, nothing when idle', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const ago = (m: number) => new Date(now - m * 60_000).toISOString();
  const s = (o: object) => ({ title: 'Scrape vendor pricing pages', state: 'running' as const, note: null, summary: null, doneAt: null, ...o });
  assert.equal(bubbleText(null, now), null);
  assert.equal(bubbleText(s({}), now), 'On “Scrape vendor pricing pages”');
  assert.equal(bubbleText(s({ note: { text: 'Reading the pricing pages', at: ago(2) } }), now), 'Reading the pricing pages');
  assert.equal(bubbleText(s({ note: { text: 'old', at: ago(45) } }), now), 'On “Scrape vendor pricing pages”', 'a stale note gives way');
  assert.equal(bubbleText(s({ state: 'done', summary: 'Compared 12 vendors. Full table attached.', doneAt: ago(1) }), now), 'Done! Compared 12 vendors.');
  assert.equal(bubbleText(s({ state: 'done', summary: 'Done.', doneAt: ago(1) }), now), 'Done with “Scrape vendor pricing pages”');
  assert.equal(bubbleText(s({ state: 'done', summary: 'x', doneAt: ago(30) }), now), null, 'the recap fades');
  assert.match(bubbleText(s({ state: 'input' }), now)!, /^Waiting on you/);
  assert.equal(bubbleText(s({ state: 'waiting' }), now), null);
});

test('greetings and hand-off lines: short, varied, the task named and clipped', () => {
  assert.equal(greetingLine(0), GREETINGS[0]);
  assert.equal(greetingLine(GREETINGS.length + 1), GREETINGS[1]);
  assert.ok(GREETINGS.every((g) => g.length <= 18));
  assert.deepEqual(handoffLines('Scrape vendor pricing pages', 0), { lead: 'Can you take “Scrape vendor pricing pages”?', mate: 'On it!' });
  assert.equal(handoffLines(null, 1).lead, 'Got a task for you.');
  assert.ok(handoffLines('A very long task title that goes on and on and on', 2).lead.includes('…'));
});

test('chat sign-off: back to the task when there is one, else a goodbye', () => {
  assert.equal(farewellLine({ lead: false, task: 'Scrape vendor pricing pages', n: 0 }), 'Alright, back to “Scrape vendor pricing pages”. Shout if you need me!');
  assert.match(farewellLine({ lead: true, task: null, n: 3 }), /keep the floor moving/);
  assert.ok(!farewellLine({ lead: false, task: null, n: 1 }).includes('“'));
});
