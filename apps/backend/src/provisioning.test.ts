import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileNameForAgent } from '@vibe-city/shared';
import { HermesRejectedError } from './hermes/ports.ts';
import { FakeHermes } from './testing/fakeHermes.ts';
import { provApp } from './testUtils.ts';

const count = (h: FakeHermes, prefix: string) => h.calls.filter((c) => c.startsWith(prefix)).length;
/** Managed profile names of the lead and the first teammate (provApp departments have one teammate). */
const profiles = (id: string) => ({ chief: profileNameForAgent(id, 'chief'), worker: profileNameForAgent(id, 'W-01') });

// ---- happy path -------------------------------------------------------------

test('provisioning creates the board and one profile per agent, applies the inventory, and marks ready', async () => {
  const t = provApp();
  const d = await t.create('Engineering', { purpose: 'build things', inventory: { allowedToolsets: ['file', 'terminal'], allowedSkillIds: ['pdf'], sharedContextRefs: ['docs/style.md'] } });
  assert.equal((await t.dept(d.id)).state, 'unconfigured');

  const res = await t.provision(d.id);
  assert.equal(res.statusCode, 200);
  const st = res.json();
  assert.equal(st.state, 'ready');
  assert.equal(st.error, null);
  assert.equal(st.attempts, 1);

  const names = profiles(d.id);
  assert.deepEqual([st.board.ref, st.agents[0].ref, st.agents[1].ref], [d.hermesBoardSlug, names.chief, names.worker]);
  assert.deepEqual(st.agents.map((a: any) => a.key), ['chief', 'W-01']);
  assert.ok([st.board, ...st.agents].every((r: any) => r.verified && r.verifiedAt));
  assert.deepEqual([st.agents[0].origin, st.agents[1].origin], ['created', 'created']);
  assert.ok(st.inventory.applied && st.inventory.inSync);

  // Hermes really contains them, and Vibe City stores the verified refs
  assert.ok(t.hermes.boards.has(d.hermesBoardSlug));
  assert.ok(t.hermes.profiles.has(names.chief) && t.hermes.profiles.has(names.worker));
  const dept = await t.dept(d.id);
  assert.equal(dept.state, 'ready');
  assert.equal(dept.hermesBoardRef, d.hermesBoardSlug);
  assert.equal(dept.boardSyncState, 'synced');
  assert.deepEqual(dept.agents.map((a: any) => a.profileRef), [names.chief, names.worker]);
});

test('inventory is applied: toolsets, skills, instructions; other profiles and unrelated config untouched', async () => {
  const t = provApp();
  t.hermes.profiles.get('default')!.soul = '# default soul\n';
  const d = await t.create('Eng', { purpose: 'p', inventory: { allowedToolsets: ['file', 'terminal', 'delegation', 'todo'], allowedSkillIds: ['pdf'] } });
  await t.provision(d.id);
  const { chief, worker } = profiles(d.id);
  const w = t.hermes.profiles.get(worker)!;
  const c = t.hermes.profiles.get(chief)!;
  const on = (p: typeof w) => Object.entries(p.toolsets).filter(([, v]) => v).map(([k]) => k).sort();
  assert.deepEqual(on(w), ['file', 'kanban', 'terminal', 'todo'], 'teammate: allowed minus delegation, plus kanban');
  assert.deepEqual(on(c), ['file', 'kanban', 'terminal', 'todo'], 'lead: the same allowance');
  assert.deepEqual(Object.entries(w.skills).filter(([, v]) => v).map(([k]) => k), ['hermes-agent', 'pdf'], 'allowed + Hermes essential');
  assert.ok(w.soul.startsWith('# Soul\nBe helpful.\n'), 'existing instructions preserved');
  assert.ok(w.soul.includes('You are an agent of this department (seat W-01)') && c.soul.includes('(seat chief). New quests'));
  assert.equal(w.model, 'base-model', 'model untouched when no allowed models are listed');
  const def = t.hermes.profiles.get('default')!;
  assert.equal(def.soul, '# default soul\n');
  assert.ok(Object.values(def.toolsets).every(Boolean), 'default profile is never modified');
  assert.ok(t.hermes.calls.every((c2) => !/\(default[,)]/.test(c2) || c2.startsWith('listProfiles')), 'no profile-scoped call targeted default');
});

test('chosen model: every agent profile gets the provider + model pair, set through Hermes', async () => {
  const t = provApp();
  const d = await t.create('Eng', { inventory: { model: { provider: 'anthropic', id: 'claude-x' } } });
  assert.equal((await t.provision(d.id)).json().state, 'ready');
  const { chief, worker } = profiles(d.id);
  for (const n of [chief, worker]) {
    assert.deepEqual([t.hermes.profiles.get(n)!.provider, t.hermes.profiles.get(n)!.model], ['anthropic', 'claude-x'], n);
  }
  assert.equal(t.hermes.profiles.get('default')!.model, 'base-model', 'default profile untouched');
});

test('model catalog lists Hermes providers and models; legacy allowedModelIds are dropped on read', async () => {
  const t = provApp();
  const cat = (await t.app.inject('/api/runtime/models')).json();
  assert.deepEqual(cat.current, { provider: 'near-ai', model: 'base-model' });
  assert.deepEqual(cat.providers.map((p: any) => p.slug), ['near-ai', 'anthropic']);
  const d = await t.create('Old');
  t.db.prepare('UPDATE department_inventory SET inventory_json = json_set(inventory_json, \'$.allowedModelIds\', json(\'["m"]\')) WHERE department_id = ?').run(d.id);
  const inv = (await t.app.inject(`/api/departments/${d.id}/inventory`)).json();
  assert.equal(inv.model, null);
  assert.ok(!('allowedModelIds' in inv));
});

// ---- idempotency / partial failure -------------------------------------------

test('provisioning is idempotent: a second run creates nothing new', async () => {
  const t = provApp();
  const d = await t.create('Eng');
  await t.provision(d.id);
  const before = { boards: count(t.hermes, 'createBoard'), profiles: count(t.hermes, 'createProfile') };
  assert.deepEqual(before, { boards: 1, profiles: 2 });
  const again = (await t.provision(d.id)).json();
  assert.equal(again.state, 'ready');
  assert.equal(again.attempts, 2);
  assert.equal(count(t.hermes, 'createBoard'), 1);
  assert.equal(count(t.hermes, 'createProfile'), 2);
  assert.equal(t.hermes.boards.size, 1);
});

test('partial failure: board ok, a profile creation fails -> error; retry resumes without duplicates', async () => {
  const t = provApp();
  const d = await t.create('Eng');
  t.hermes.failNext('createProfile', new HermesRejectedError('boom'), 1); // chief
  const first = (await t.provision(d.id)).json();
  assert.equal(first.state, 'error');
  assert.equal(first.error.step, 'agents');
  assert.equal(first.error.code, 'hermes_rejected');
  assert.equal(first.error.retryable, true);
  assert.equal(first.board.verified, true, 'board progress is preserved');
  assert.equal(first.agents[0].verified, false);
  assert.equal((await t.dept(d.id)).state, 'error');

  // second profile fails too, after chief succeeds on retry
  t.hermes.failNext('createProfile', new HermesRejectedError('boom 2'), 0);
  const retry = await t.app.inject({ method: 'POST', url: `/api/departments/${d.id}/provision/retry` });
  assert.equal(retry.json().state, 'ready');
  assert.equal(count(t.hermes, 'createBoard'), 1, 'board not recreated');
  const { chief, worker } = profiles(d.id);
  assert.ok(t.hermes.profiles.has(chief) && t.hermes.profiles.has(worker));
  assert.equal(t.hermes.profiles.size, 3, 'default + exactly one profile per agent');
});

// ---- availability vs invalid configuration -------------------------------------

test('Hermes unreachable -> disconnected (temporary), nothing created; works after it comes back', async () => {
  const t = provApp();
  const d = await t.create('Eng');
  t.hermes.online = false;
  const st = (await t.provision(d.id)).json();
  assert.equal(st.state, 'disconnected');
  assert.equal(st.error.code, 'hermes_unreachable');
  assert.equal(st.error.retryable, true);
  assert.equal(t.hermes.boards.size, 0);
  t.hermes.online = true;
  assert.equal((await t.app.inject({ method: 'POST', url: `/api/departments/${d.id}/provision/retry` })).json().state, 'ready');
});

test('associating a profile that does not exist is an invalid configuration, not an outage', async () => {
  const t = provApp();
  const d = await t.create('Eng');
  await t.app.inject({ method: 'PATCH', url: `/api/departments/${d.id}`, payload: { leadProfileRef: 'my-chief' } });
  const st = (await t.provision(d.id)).json();
  assert.equal(st.state, 'error');
  assert.equal(st.error.code, 'profile_not_found');
  assert.equal(st.error.retryable, false);
  assert.equal(t.hermes.boards.size, 0, 'no resources are created before validation passes');
  // user fixes it on the Hermes side, retry succeeds, the profile is associated (not created)
  t.hermes.addProfile('my-chief');
  await t.app.inject({ method: 'PATCH', url: `/api/departments/${d.id}`, payload: { confirmModifyProfiles: ['my-chief'] } });
  const ok = (await t.app.inject({ method: 'POST', url: `/api/departments/${d.id}/provision` })).json();
  assert.equal(ok.state, 'ready');
  assert.equal(ok.agents[0].origin, 'associated');
  assert.equal(count(t.hermes, 'createProfile(my-chief'), 0);
});

test('profile association rules: not default, not shared, not a teammate\'s profile', async () => {
  const t = provApp();
  const a = await t.create('A');
  const b = await t.create('B');
  await t.provision(b.id);
  const patch = (id: string, payload: object) => t.app.inject({ method: 'PATCH', url: `/api/departments/${id}`, payload });
  assert.equal((await patch(a.id, { leadProfileRef: 'default' })).statusCode, 400);
  assert.equal((await patch(a.id, { leadProfileRef: 'shared' })).statusCode, 200);
  assert.equal((await patch(b.id, { leadProfileRef: 'shared' })).statusCode, 409);
  assert.equal((await patch(a.id, { leadProfileRef: profiles(b.id).worker })).statusCode, 409, 'another department\'s teammate');
  assert.equal((await patch(b.id, { leadProfileRef: profiles(b.id).worker })).statusCode, 400, 'one of its own teammates');
});

test('inventory that Hermes does not reflect -> error, never ready', async () => {
  const t = provApp();
  t.hermes.setToolsets = async () => {}; // Hermes silently ignores the change
  const d = await t.create('Eng', { inventory: { allowedToolsets: ['file'] } });
  const st = (await t.provision(d.id)).json();
  assert.equal(st.state, 'error');
  assert.equal(st.error.code, 'inventory_verification_failed');
  assert.equal(st.error.step, 'inventory');
  assert.notEqual((await t.dept(d.id)).state, 'ready');
  assert.equal(st.inventory.applied, false);
});

// ---- readiness after changes ----------------------------------------------------

test('editing the inventory of a ready department requires re-provisioning', async () => {
  const t = provApp();
  const d = await t.create('Eng', { inventory: { allowedToolsets: ['file'] } });
  await t.provision(d.id);
  await t.app.inject({ method: 'PATCH', url: `/api/departments/${d.id}/inventory`, payload: { allowedToolsets: ['file', 'web'] } });
  const st = await t.status(d.id);
  assert.equal(st.state, 'unconfigured');
  assert.equal(st.inventory.inSync, false);
  assert.equal((await t.app.inject(`/api/departments/${d.id}/effective-inventory`)).json().inSync, false);
  assert.equal((await t.provision(d.id)).json().state, 'ready');
  const { worker } = profiles(d.id);
  assert.equal(t.hermes.profiles.get(worker)!.toolsets.web, true);
  assert.equal(count(t.hermes, 'createProfile'), 2, 'no profile re-creation on re-provision');
});


// ---- reconcile -----------------------------------------------------------------------

test('reconcile: ready -> disconnected while Hermes is down -> ready again, without recreating anything', async () => {
  const t = provApp();
  const d = await t.create('Eng');
  await t.provision(d.id);
  t.hermes.online = false;
  await t.provisioning.reconcile(d.id);
  assert.equal((await t.status(d.id)).state, 'disconnected');
  assert.equal((await t.dept(d.id)).state, 'disconnected');
  t.hermes.online = true;
  await t.provisioning.reconcile(d.id);
  const st = await t.status(d.id);
  assert.equal(st.state, 'ready');
  assert.equal(st.error, null);
  assert.equal(count(t.hermes, 'createProfile'), 2);
  assert.equal(count(t.hermes, 'createBoard'), 1);
});

test('reconcile recreates Vibe City-created resources that vanished from Hermes', async () => {
  const t = provApp();
  const d = await t.create('Eng');
  await t.provision(d.id);
  const { chief } = profiles(d.id);
  t.hermes.boards.delete(d.hermesBoardSlug);
  t.hermes.profiles.delete(chief);
  await t.provisioning.reconcile(d.id);
  assert.equal((await t.status(d.id)).state, 'ready');
  assert.ok(t.hermes.boards.has(d.hermesBoardSlug) && t.hermes.profiles.has(chief));
});

test('reconcile detects capability drift in Hermes and re-applies the inventory', async () => {
  const t = provApp();
  const d = await t.create('Eng', { inventory: { allowedToolsets: ['file'] } });
  await t.provision(d.id);
  const { worker } = profiles(d.id);
  t.hermes.profiles.get(worker)!.toolsets.terminal = true; // someone enabled a tool by hand
  await t.provisioning.reconcile(d.id);
  assert.equal((await t.status(d.id)).state, 'ready');
  assert.equal(t.hermes.profiles.get(worker)!.toolsets.terminal, false, 'restriction restored');
});

// ---- API surface -----------------------------------------------------------------------

test('health route reports dashboard, auth and gateway separately', async () => {
  const t = provApp();
  let h = (await t.app.inject('/api/runtime/health')).json();
  assert.deepEqual([h.hermes.dashboard, h.hermes.auth, h.hermes.gateway], ['up', 'ok', 'running']);
  t.hermes.gatewayRunning = false;
  h = (await t.app.inject('/api/runtime/health')).json();
  assert.equal(h.hermes.gateway, 'stopped');
  t.hermes.authOk = false;
  assert.equal((await t.app.inject('/api/runtime/health')).json().hermes.auth, 'rejected');
  t.hermes.online = false;
  h = (await t.app.inject('/api/runtime/health')).json();
  assert.deepEqual([h.hermes.dashboard, h.hermes.auth], ['down', 'unknown']);
});

test('profiles route returns live profile data, or the stored refs when Hermes is unreachable', async () => {
  const t = provApp();
  const d = await t.create('Eng');
  await t.provision(d.id);
  const live = (await t.app.inject(`/api/departments/${d.id}/profiles`)).json();
  assert.equal(live.reachable, true);
  assert.equal(live.agents[0].exists, true);
  assert.equal(live.agents[1].model, 'base-model');
  t.hermes.online = false;
  const off = (await t.app.inject(`/api/departments/${d.id}/profiles`)).json();
  assert.equal(off.reachable, false);
  assert.equal(off.agents[0].ref, live.agents[0].ref);
  assert.equal(off.agents[0].exists, null);
});

test('effective inventory: honest statuses before and after provisioning', async () => {
  const t = provApp();
  t.hermes.concurrencyCap = 2;
  const d = await t.create('Eng', { inventory: { allowedToolsets: ['terminal'], allowedMcpTools: ['gh:issue'], }, teammates: 4 });
  const find = (r: any, role: 'chief' | 'worker', cap: string) => r.agents[role === 'chief' ? 0 : 1].entries.find((e: any) => e.capability === cap);

  let eff = (await t.app.inject(`/api/departments/${d.id}/effective-inventory`)).json();
  assert.equal(eff.observedAt, null);
  assert.equal(find(eff, 'worker', 'toolsets.behavior-tested').status, 'unverified');

  await t.provision(d.id);
  eff = (await t.app.inject(`/api/departments/${d.id}/effective-inventory`)).json();
  assert.ok(eff.inSync && eff.observedAt);
  assert.equal(find(eff, 'worker', 'toolsets.behavior-tested').status, 'enforced');
  assert.deepEqual(find(eff, 'worker', 'toolsets.behavior-tested').effective, ['terminal']);
  assert.deepEqual(find(eff, 'chief', 'toolsets.behavior-tested').effective, ['terminal'], 'every agent gets the department toolsets');
  assert.equal(find(eff, 'worker', 'mcp.tools').status, 'unverified');
  assert.equal(find(eff, 'worker', 'models.restriction').status, 'unsupported');
  assert.equal(eff.agents.length, 5, 'one report per agent');
  const conc = eff.departmentWide.find((e: any) => e.capability === 'limits.concurrency');
  assert.equal(conc.status, 'configured');
  assert.deepEqual(conc.effective, { agents: 5, perAgentCap: 2, departmentMax: 10 }, 'each agent is its own profile under the host-wide cap');
  assert.equal(eff.departmentWide.find((e: any) => e.capability === 'files.isolation').status, 'unsupported');
});

test('no response ever contains credentials or Hermes internals', async () => {
  const t = provApp();
  const d = await t.create('Eng');
  await t.provision(d.id);
  for (const url of ['/api/company', '/api/departments', `/api/departments/${d.id}`, `/api/departments/${d.id}/provisioning`,
    `/api/departments/${d.id}/profiles`, `/api/departments/${d.id}/effective-inventory`, '/api/runtime/health']) {
    const body = (await t.app.inject(url)).body.toLowerCase();
    assert.ok(!/token|secret|password|api[_-]?key|session-token/.test(body.replace(/"maxtaskruntimeseconds"/g, '')), url);
  }
});

// ---- safeguard: pre-existing profiles are never modified silently ----------------------

const snapshot = (h: FakeHermes, name: string) => JSON.stringify(h.profiles.get(name));

test('an associated profile is NOT modified without explicit confirmation; nothing is created either', async () => {
  const t = provApp();
  t.hermes.addProfile('existing-worker');
  const before = snapshot(t.hermes, 'existing-worker');
  const d = await t.create('Eng', { inventory: { allowedToolsets: ['file'] } });
  await t.app.inject({ method: 'PATCH', url: `/api/departments/${d.id}`, payload: { leadProfileRef: 'existing-worker' } });
  const st = (await t.provision(d.id)).json();
  assert.equal(st.state, 'error');
  assert.equal(st.error.code, 'confirmation_required');
  assert.equal(st.error.step, 'validate');
  assert.equal(st.error.retryable, false);
  assert.equal(st.agents[0].origin, 'associated');
  assert.equal(st.agents[0].modificationConfirmed, false);
  assert.equal(snapshot(t.hermes, 'existing-worker'), before, 'profile untouched');
  assert.equal(t.hermes.boards.size, 0, 'no board created');
  assert.equal(count(t.hermes, 'createProfile'), 0);
  for (const m of ['setToolsets', 'setDisabledSkills', 'setModel', 'writeInstructions']) assert.equal(count(t.hermes, m), 0, m);
});

test('reconcile never modifies an associated profile whose consent is missing', async () => {
  const t = provApp();
  t.hermes.addProfile('mine');
  const d = await t.create('Eng', { inventory: { allowedToolsets: ['file'] } });
  await t.app.inject({ method: 'PATCH', url: `/api/departments/${d.id}`, payload: { leadProfileRef: 'mine', confirmModifyProfiles: ['mine'] } });
  await t.provision(d.id);
  await t.app.inject({ method: 'PATCH', url: `/api/departments/${d.id}`, payload: { confirmModifyProfiles: [] } }); // consent withdrawn
  await t.provision(d.id); // refused
  t.hermes.profiles.get('mine')!.toolsets.terminal = true; // someone re-enabled a tool by hand
  const before = snapshot(t.hermes, 'mine');
  await t.provisioning.reconcile(d.id);
  assert.equal(snapshot(t.hermes, 'mine'), before, 'drift on an unconfirmed associated profile is reported, not silently fixed');
  assert.notEqual((await t.status(d.id)).state, 'ready');
});


test('a background check of an unchanged department only reads: no writes, and it never leaves ready', async () => {
  const t = provApp();
  const d = await t.create('Eng');
  await t.provision(d.id);
  const attempts = (await t.status(d.id)).attempts;
  const before = t.hermes.calls.length;
  const seen: string[] = [];
  const read = t.hermes.getToolsets.bind(t.hermes);
  t.hermes.getToolsets = async (p: string) => { seen.push(t.provisioning.status(d.id).state); return read(p); };
  await t.provisioning.reconcile(d.id);
  assert.deepEqual(t.hermes.calls.slice(before).filter((c) => /^(create|set|write)/.test(c)), []);
  assert.ok(seen.length > 0 && seen.every((s) => s === 'ready'), seen.join());
  const st = await t.status(d.id);
  assert.equal(st.state, 'ready');
  assert.equal(st.attempts, attempts);
});

const check = async (t: ReturnType<typeof provApp>, id: string) => (await t.app.inject({ method: 'POST', url: `/api/departments/${id}/check` })).json();
const writes = (t: ReturnType<typeof provApp>, from: number) => t.hermes.calls.slice(from).filter((c) => /^(create|set|write)/.test(c));

test('check lists drift without fixing it; Sync then fixes it', async () => {
  const t = provApp();
  const d = await t.create('Eng');
  await t.provision(d.id);
  const { chief } = profiles(d.id);
  const prof = t.hermes.profiles.get(chief)!;
  const off = Object.keys(prof.toolsets).find((k) => !prof.toolsets[k])!;
  prof.toolsets[off] = true;
  const before = t.hermes.calls.length;
  const r = await check(t, d.id);
  assert.equal(r.inSync, false);
  assert.ok(r.differences.some((x: string) => x.startsWith('Lead:') && x.includes(off)), r.differences.join(' | '));
  assert.deepEqual(writes(t, before), []);
  assert.equal(prof.toolsets[off], true, 'a check never changes Hermes');
  assert.equal((await t.provision(d.id)).json().state, 'ready');
  assert.equal(prof.toolsets[off], false);
  assert.equal((await check(t, d.id)).inSync, true);
});

