import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDept, questApp } from './testUtils.ts';
import { gameState } from './routes/game.ts';
import { clampListing } from './domain/marketService.ts';

const TOKEN = 'aat_' + 'a'.repeat(32);

/** A fake market.near.ai: self-registration, one assignment the test moves through its states, and the public agent page. */
function fakeMarket() {
  const calls: string[] = [];
  const submitted: string[] = [];
  const m = {
    calls, submitted,
    a: null as null | { status: string; startedAt: string | null; latest: string | null },
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch_ = (async (url: string, init: RequestInit = {}) => {
    const path = url.replace(/^https?:\/\/[^/]+/, ''), method = init.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const auth = String((init.headers as Record<string, string>)?.Authorization ?? '');
    if (method === 'POST' && path === '/v1/agents/register') {
      const b = JSON.parse(String(init.body));
      if (b.handle === 'taken') return json(409, { error: 'handle_taken', message: 'Handle taken' });
      return json(201, { agentId: 'ag-1', accountId: 'acc-1', handle: b.handle, apiToken: TOKEN, tokenPrefix: 'aat_aaaa' });
    }
    if (auth !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized', message: 'No / invalid aat_ bearer' });
    if (path.startsWith('/v1/agents/me/assignments')) {
      const rows = m.a ? [{
        assignment: { assignmentId: 'as-1', status: m.a.status, escrowAmount: '12.00', escrowToken: 'USDC', startedAt: m.a.startedAt },
        job: { title: 'Landing page copy', description: 'Write three headlines for a coffee shop.', tags: ['copy'], attachments: [] },
        latestMessage: m.a.latest ? { senderSide: 'buyer', body: m.a.latest } : null,
      }] : [];
      return json(200, { assignments: rows });
    }
    if (path === '/v1/assignments/as-1/start') { m.a!.startedAt ??= '2026-11-08T12:00:00Z'; return json(200, { startedAt: m.a!.startedAt }); }
    if (path === '/v1/assignments/as-1/submit') { submitted.push(JSON.parse(String(init.body)).deliverableMarkdown); m.a!.status = 'submitted'; return json(200, {}); }
    return json(404, {});
  }) as typeof fetch;
  return Object.assign(m, { fetch: fetch_ });
}

test('the company registers on the market; the Marketplace Agency takes a job, delivers it, reworks it and earns', async () => {
  const market = fakeMarket();
  const { app, hermes, kanban, readyDept, services } = questApp({ marketFetch: market.fetch });
  const view = async () => (await app.inject('/api/market')).json();
  const quest = async (id: string) => (await gameState(services, true)).quests.find((q) => q.id === id)!.done;
  assert.equal((await view()).connected, false);

  assert.equal(await quest('market'), false);
  // register: a taken handle is a 409; a good one stores the token server-side only
  const taken = await app.inject({ method: 'POST', url: '/api/market/register', payload: { handle: 'taken', name: 'Acme', category: 'creative' } });
  assert.equal(taken.statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/market/register', payload: { handle: 'Bad Handle', name: 'Acme', category: 'creative' } })).statusCode, 400);
  const reg = await app.inject({ method: 'POST', url: '/api/market/register', payload: { handle: 'acme-works', name: 'Acme Works', category: 'creative', slaHours: 24 } });
  assert.equal(reg.statusCode, 200, reg.body);
  assert.equal(reg.json().handle, 'acme-works');
  assert.ok(reg.json().verifiedAt, 'token verified');
  assert.equal(await quest('market'), true, 'a verified token is enough');
  assert.equal((await gameState(services, true)).locked['marketplace-agency'], true, 'still waits for NEAR AI, like every floor');
  assert.equal((await app.inject({ method: 'POST', url: '/api/market/register', payload: { handle: 'acme-two', name: 'A', category: 'other' } })).statusCode, 409, 'one agent per company');

  // a hire before the agency exists: not started (the buyer can still cancel for a full refund); another floor never takes it
  const other = await readyDept('Copy Desk');
  market.a = { status: 'in_progress', startedAt: null, latest: null };
  await services.market.tick();
  assert.equal((await view()).jobs.length, 0);
  assert.match((await view()).lastError, /Hire the Marketplace Agency/);
  assert.equal((await view()).agencyReady, false);
  assert.equal(market.a.startedAt, null);

  // the agency: its agents get the token as MARKET_AGENT_TOKEN, no other floor does
  const { json: agency } = await createDept(app, { name: 'Marketplace Agency', template: 'marketplace-agency' });
  const prov = (await app.inject({ method: 'POST', url: `/api/departments/${agency.id}/provision` })).json();
  assert.equal(prov.state, 'ready', JSON.stringify(prov));
  kanban.addBoard(agency.hermesBoardSlug);
  const d = { id: agency.id as string, board: agency.hermesBoardSlug as string };
  assert.equal((await view()).agencyReady, true);
  for (const a of prov.agents as { ref: string }[]) assert.equal(hermes.env.get(a.ref)?.MARKET_AGENT_TOKEN, TOKEN);
  for (const p of [other.lead, other.teammate]) assert.equal(hermes.env.get(p)?.MARKET_AGENT_TOKEN, undefined);

  // the next poll starts it and opens a quest on the agency
  await services.market.tick();
  await services.market.tick(); // a second poll changes nothing
  let job = (await view()).jobs[0];
  assert.equal((await view()).jobs.length, 1);
  assert.equal(job.departmentId, d.id);
  assert.equal(job.state, 'working');
  assert.equal(market.a.startedAt, '2026-11-08T12:00:00Z', 'started before any work');
  const origin = (await app.inject('/api/quest-origins')).json().origins.find((o: any) => o.questId === job.questId);
  assert.equal(origin.origin, 'market');

  // the quest completes: its result is submitted as the deliverable, host paths scrubbed
  kanban.complete(d.board, job.questId, 'Headlines: 1. Wake up 2. Brew 3. Sip. Draft at /home/u/.hermes/work/copy.md');
  await services.market.tick();
  assert.equal(market.submitted.length, 1);
  assert.match(market.submitted[0]!, /Wake up/);
  assert.ok(!market.submitted[0]!.includes('/home/u'), 'no host path leaves Vibe City');
  assert.equal((await view()).jobs[0].state, 'submitted');

  // request changes: back to in_progress with the buyer's note; a revision quest on the same department
  market.a.status = 'in_progress';
  market.a.latest = 'Make them funnier.';
  await services.market.tick();
  job = (await view()).jobs[0];
  assert.equal(job.state, 'working');
  assert.equal(job.rounds, 2);
  const rev = (await app.inject(`/api/departments/${d.id}/quests/${job.questId}`)).json();
  assert.match(rev.summary?.title ?? rev.title ?? JSON.stringify(rev), /revision 1/);
  kanban.complete(d.board, job.questId, 'Funnier headlines.');
  await services.market.tick();
  assert.equal(market.submitted.length, 2);

  // accepted: earnings after the 5% fee, and the first-job quest is done
  assert.equal(await quest('first-job'), false);
  market.a.status = 'accepted';
  await services.market.tick();
  assert.equal((await view()).jobs[0].state, 'accepted');
  assert.equal((await view()).earnedCents, 1140);
  assert.equal(await quest('first-job'), true);

  for (const url of ['/api/market', '/api/company/settings', '/api/game']) assert.ok(!(await app.inject(url)).body.includes(TOKEN), `${url} never carries the token`);
});

test('a pasted token is stored only if the market accepts it; no department means no job is taken', async () => {
  const market = fakeMarket();
  const { app, services } = questApp({ marketFetch: market.fetch });
  const bad = await app.inject({ method: 'POST', url: '/api/market/token', payload: { handle: 'acme-works', token: 'aat_' + 'b'.repeat(32) } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().message, /refused/);
  assert.equal((await app.inject('/api/market')).json().connected, false);
  const ok = await app.inject({ method: 'POST', url: '/api/market/token', payload: { handle: 'acme-works', token: TOKEN } });
  assert.equal(ok.statusCode, 200, ok.body);
  market.a = { status: 'in_progress', startedAt: null, latest: null };
  await services.market.tick();
  const v = (await app.inject('/api/market')).json();
  assert.equal(v.jobs.length, 0);
  assert.match(v.lastError, /Hire the Marketplace Agency/);
  assert.equal(market.a.startedAt, null, 'not started: the buyer can still cancel for a full refund');
});

test('a listing draft is made valid for the register form', () => {
  const d = clampListing('<think>hm</think>{"handle":"Acme Works!!","name":"Acme","tagline":"Words that sell.","category":"wizardry","priceUsdc":-3,"slaHours":5000,"deliverables":["a",7]}', 'Acme Co');
  assert.equal(d.handle, 'acme-works');
  assert.equal(d.category, 'other');
  assert.equal(d.priceUsdc, 10);
  assert.equal(d.slaHours, 720);
  assert.deepEqual(d.deliverables, ['a']);
  assert.equal(clampListing('<think>x</think>{"handle":"9","tagline":"t"}', '42 Things').handle, 'things', 'a bad handle falls back to the company name');
  assert.throws(() => clampListing('no json', 'Acme'), /could not write the listing/, 'no defaults dressed up as a draft');
  assert.throws(() => clampListing('{"handle":"acme"', 'Acme'), /could not write the listing/, 'cut off mid-JSON');
});
