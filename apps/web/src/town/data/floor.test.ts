import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES } from '@vibe-city/shared';
import { STATIONS, TOOL_INFO, stationFor, toolsReport } from './floor.ts';

test('every template has a station whose tools the template actually gives its floor', () => {
  for (const t of TEMPLATES.filter((x) => !x.hidden)) {
    const st = stationFor(t.id);
    assert.ok(st, `${t.id} has a station`);
    for (const ts of st!.toolsets) assert.ok(t.inventory.allowedToolsets.includes(ts), `${t.id}: ${ts} is in the template`);
    for (const sk of st!.skills) assert.ok(t.inventory.allowedSkillIds.includes(sk), `${t.id}: ${sk} is in the template`);
    assert.equal(st!.wallet, t.wallet === 'company', `${t.id}: wallet badge matches the template`);
    // a fresh hire from the template needs nothing it does not have
    const r = toolsReport(t.id, t.inventory);
    assert.ok(r.needed.every((x) => x.on), `${t.id}: nothing missing`);
  }
  assert.equal(stationFor(null), null);
  assert.equal(stationFor('no-such-template'), null);
  assert.equal(Object.keys(STATIONS).length, 4);
});

test('the tools report flags missing needs and risky extras, and stays neutral for floors without a template', () => {
  const r = toolsReport('trading-desk', { allowedToolsets: ['file', 'web', 'browser', 'memory', 'kanban', 'image_gen'], allowedSkillIds: [] });
  assert.deepEqual(r.needed.filter((x) => !x.on).map((x) => x.id), ['terminal'], 'the Trading Desk cannot trade without it');
  assert.deepEqual(r.extra.map((x) => x.id), ['browser', 'file', 'image_gen'], 'extras, risky first; base tools are never listed');
  assert.equal(r.extra[0]!.risky, true);
  const plain = toolsReport(undefined, { allowedToolsets: ['web', 'memory', 'terminal'], allowedSkillIds: [] });
  assert.equal(plain.plain, true);
  assert.deepEqual(plain.extra.map((x) => x.id), ['web', 'terminal']);
  // an empty skill allowance means Hermes' defaults: a needed skill is not reported missing
  assert.ok(toolsReport('trading-desk', { allowedToolsets: ['web', 'terminal'], allowedSkillIds: [] }).skills.every((s) => s.on));
  assert.deepEqual(toolsReport('trading-desk', { allowedToolsets: ['web', 'terminal'], allowedSkillIds: ['agent-custody'] }).skills, [{ id: 'agent-custody', on: true }, { id: 'hyperliquid-connector', on: false }]);
  for (const k of ['terminal', 'browser', 'code_execution', 'computer_use']) assert.equal(TOOL_INFO[k as keyof typeof TOOL_INFO]?.risky, true, k);
});
