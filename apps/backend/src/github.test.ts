import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provApp } from './testUtils.ts';

const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz';
const patch = (app: ReturnType<typeof provApp>['app'], body: unknown) => app.inject({ method: 'PATCH', url: '/api/company/settings', payload: body as object });

test('a pasted GitHub token is stored write-only and reaches only the Software Department as GH_TOKEN', async () => {
  const saved = process.env.GITHUB_TOKEN; delete process.env.GITHUB_TOKEN;
  try {
    const { app, hermes, create, provision, dept } = provApp();
    const sw = await create('Software', { template: 'software' });
    const td = await create('Trading', { template: 'trading-desk' });
    assert.equal((await provision(sw.id)).json().state, 'ready');
    assert.equal((await provision(td.id)).json().state, 'ready');
    const profiles = async (id: string) => ((await dept(id)).agents as { profileRef: string | null }[]).map((a) => a.profileRef!);
    const [swProfiles, tdProfiles] = [await profiles(sw.id), await profiles(td.id)];
    assert.ok(swProfiles.length === 4 && swProfiles.every((p) => !hermes.env.get(p)?.GH_TOKEN), 'no token yet, nothing written');
    assert.equal((await app.inject('/api/company/settings')).json().githubConnected, false);

    // pasting it: stored, never echoed, and pushed to the Software floor's existing profiles right away
    const r = await patch(app, { githubToken: TOKEN });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().githubConnected, true);
    assert.ok(!r.body.includes(TOKEN) && !(await app.inject('/api/company/settings')).body.includes(TOKEN), 'the token never leaves the server');
    for (const p of swProfiles) assert.equal(hermes.env.get(p)?.GH_TOKEN, TOKEN, `${p} gets GH_TOKEN`);
    for (const p of tdProfiles) assert.equal(hermes.env.get(p)?.GH_TOKEN, undefined, `${p} (Trading Desk) does not`);

    // a Software floor hired later gets it when it is provisioned
    const sw2 = await create('Software 2', { template: 'software' });
    await provision(sw2.id);
    for (const p of await profiles(sw2.id)) assert.equal(hermes.env.get(p)?.GH_TOKEN, TOKEN);
  } finally { if (saved !== undefined) process.env.GITHUB_TOKEN = saved; }
});

test('settings PATCH rejects fields that are not settable yet and values that are not a token', async () => {
  const { app } = provApp();
  assert.equal((await patch(app, { nearAiApiKey: 'two words' })).statusCode, 400);
  assert.equal((await patch(app, { nearAiCreditsLoadedCents: 100 })).statusCode, 400, 'not settable yet');
  assert.equal((await patch(app, { githubToken: 'two words' })).statusCode, 400);
  assert.equal((await patch(app, { unknown: 1 })).statusCode, 400, 'strict schema');
  assert.equal((await app.inject('/api/company/settings')).json().githubConnected, !!process.env.GITHUB_TOKEN);
});
