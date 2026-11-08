import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { TEMPLATES } from '@vibe-city/shared';
import { STATIONS } from './floor.ts';
import { schoolOf, rarityOf, skillLabel, skillMeta, skillState, toggleAllowance, templateSkills } from './skills.ts';

test('skills get a school, a rarity and a label', () => {
  assert.equal(schoolOf('agent-custody'), 'wallet');
  assert.equal(schoolOf('hyperliquid-connector'), 'markets');
  assert.equal(schoolOf('github'), 'code');
  assert.equal(schoolOf('arxiv'), 'research');
  assert.equal(schoolOf('pdf'), 'docs');
  assert.equal(schoolOf('omarchy'), 'ops');
  assert.equal(schoolOf('anything', true), 'core', 'an essential skill is core');
  assert.equal(rarityOf('hermes-agent'), 'core');
  assert.equal(rarityOf('pdf'), 'standard');
  assert.equal(skillLabel('near-cli-rs'), 'NEAR CLI RS');
  assert.equal(skillMeta('agent-custody').wallet, true);
  assert.equal(skillMeta('github').wallet, false);
  assert.match(skillMeta('some-unknown-skill').blurb, /installed in Hermes/, 'unknown skills are not described by guesswork');
});

test('signature is the few skills a floor is built around, not everything a template names', () => {
  for (const st of Object.values(STATIONS)) for (const k of st.skills) assert.equal(rarityOf(k), 'signature', k);
  const named = templateSkills();
  assert.ok(named.includes('agent-custody'));
  assert.ok(named.filter((n) => rarityOf(n) === 'signature').length <= 8, 'signature stays rare');
  assert.equal(schoolOf('gh-fix-ci'), 'code');
  assert.equal(schoolOf('near-smart-contracts'), 'code');
  assert.equal(schoolOf('near-contract-audit'), 'security');
  assert.equal(schoolOf('near-intents'), 'wallet');
  assert.equal(schoolOf('coingecko'), 'markets');
  assert.equal(schoolOf('backtest-expert'), 'markets');
});

test('every skill the repo installs in Hermes has a line on its card', () => {
  const root = new URL('../../../../../docker/skills/', import.meta.url);
  const vendored = readdirSync(root).filter((d) => existsSync(new URL(`${d}/SKILL.md`, root)));
  const optional = readFileSync(new URL('HERMES_OPTIONAL', root), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().split('/').pop()!);
  assert.ok(vendored.length > 10);
  for (const n of [...vendored, ...optional, ...templateSkills()]) assert.doesNotMatch(skillMeta(n).blurb, /installed in Hermes/, `${n} needs a line in KNOWN (data/skills.ts)`);
});

test('a skill state compares the saved loadout with what Hermes reports', () => {
  const hermes = [{ name: 'pdf', enabled: true, essential: false }, { name: 'arxiv', enabled: false, essential: false }, { name: 'hermes-agent', enabled: true, essential: true }];
  assert.equal(skillState('pdf', ['pdf'], [], hermes), 'active');
  assert.equal(skillState('arxiv', ['pdf', 'arxiv'], [], hermes), 'pending-on');
  assert.equal(skillState('pdf', ['arxiv'], [], hermes), 'pending-off');
  assert.equal(skillState('arxiv', ['pdf'], [], hermes), 'off');
  assert.equal(skillState('hermes-agent', [], [], hermes), 'active', 'essential is always on');
  assert.equal(skillState('agent-custody', ['agent-custody'], [], hermes), 'missing', 'allowed but Hermes does not have it');
  assert.equal(skillState('pdf', [], ['pdf'], hermes), 'active', 'empty allowance = Hermes defaults');
  assert.equal(skillState('pdf', ['pdf'], [], null), 'pending-on', 'no read-back yet');
});

test('equipping on a floor that uses Hermes defaults keeps the defaults', () => {
  assert.deepEqual(toggleAllowance([], ['pdf', 'arxiv'], 'github', true), ['pdf', 'arxiv', 'github']);
  assert.deepEqual(toggleAllowance([], ['pdf', 'arxiv'], 'pdf', false), ['arxiv']);
  assert.deepEqual(toggleAllowance(['pdf'], ['arxiv'], 'pdf', true), ['pdf']);
});
