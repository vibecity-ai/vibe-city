import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES } from '@vibe-city/shared';
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

test('every skill a template names is a signature skill', () => {
  for (const t of TEMPLATES) for (const s of [...t.inventory.allowedSkillIds, ...t.seats.flatMap((x) => x.skills)]) assert.equal(rarityOf(s), 'signature', `${t.id}: ${s}`);
  assert.ok(templateSkills().includes('agent-custody'));
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
