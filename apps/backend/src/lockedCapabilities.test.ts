import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileNameForAgent } from '@vibe-city/shared';
import { provApp } from './testUtils.ts';

test('every agent gets kanban, skills and terminal, even on a floor that picked only web', async () => {
  const t = provApp();
  const d = await t.create('Markets Intel', { inventory: { allowedToolsets: ['web'] } });
  assert.equal((await t.provision(d.id)).json().state, 'ready');
  const on = t.hermes.profiles.get(profileNameForAgent(d.id, 'chief'))!.toolsets;
  assert.deepEqual(['kanban', 'skills', 'terminal', 'web'].filter((x) => on[x]), ['kanban', 'skills', 'terminal', 'web']);
  assert.equal(on.file, false, 'only the required ones are added');
});

test('a wallet floor keeps agent-custody and the listed floor keeps marketplace-worker, whatever the CEO unticks', async () => {
  const t = provApp();
  const inv = async (id: string) => (await t.app.inject(`/api/departments/${id}/inventory`)).json().allowedSkillIds as string[];
  const treasury = await t.create('Treasury', { template: 'treasury-ops' });
  await t.app.inject({ method: 'PATCH', url: `/api/departments/${treasury.id}/inventory`, payload: { allowedSkillIds: ['defillama'] } });
  assert.deepEqual((await inv(treasury.id)).sort(), ['agent-custody', 'defillama']);

  const intel = await t.create('Markets Intel', { inventory: { allowedSkillIds: ['pdf'] } });
  assert.deepEqual(await inv(intel.id), ['pdf'], 'not listed: nothing locked');
  t.db.prepare("INSERT INTO market_agent (department_id, handle, token, created_at) VALUES (?, 'acme-intel', 'aat_x', datetime('now'))").run(intel.id);
  await t.app.inject({ method: 'PATCH', url: `/api/departments/${intel.id}/inventory`, payload: { allowedSkillIds: ['pdf'] } });
  assert.deepEqual((await inv(intel.id)).sort(), ['marketplace-worker', 'pdf']);
});
