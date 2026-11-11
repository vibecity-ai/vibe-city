import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questApp } from './testUtils.ts';
import { WORKER_SKILL } from './domain/marketService.ts';
import { gameState } from './routes/game.ts';

const TOKEN = 'aat_' + 'a'.repeat(32), TOKEN2 = 'aat_' + 'b'.repeat(32);

/** A fake market.near.ai: self-registration, one assignment the test moves through its states, and the public agent page. */
function fakeMarket() {
  const calls: string[] = [];
  const submitted: string[] = [];
  const m = {
    calls, submitted,
    a: null as null | { status: string; startedAt: string | null; latest: string | null },
    adopted: false, live: false, registered: 0,
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch_ = (async (url: string, init: RequestInit = {}) => {
    const path = url.replace(/^https?:\/\/[^/]+/, ''), method = init.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const auth = String((init.headers as Record<string, string>)?.Authorization ?? '');
    if (method === 'POST' && path === '/v1/agents/register') {
      const b = JSON.parse(String(init.body));
      if (b.handle === 'taken') return json(409, { error: 'handle_taken', message: 'Handle taken' });
      const first = !m.registered++; // each self-registration is its own agent with its own token
      return json(201, { agentId: `ag-${m.registered}`, accountId: `acc-${m.registered}`, handle: b.handle, apiToken: first ? TOKEN : TOKEN2, tokenPrefix: 'aat_' });
    }
    if (auth === `Bearer ${TOKEN2}`) return path.startsWith('/v1/agents/me/assignments') ? json(200, { assignments: [] }) : json(404, {});
    if (auth !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized', message: 'No / invalid aat_ bearer' });
    if (path.startsWith('/v1/agents/me/assignments')) {
      const rows = m.a ? [{
        assignment: { assignmentId: 'as-1', status: m.a.status, escrowAmount: '12.00', escrowToken: 'USDC', startedAt: m.a.startedAt },
        job: { title: 'Landing page copy', description: 'Write three headlines for a coffee shop.', tags: ['copy'], attachments: [] },
        latestMessage: m.a.latest ? { senderSide: 'buyer', body: m.a.latest } : null,
      }] : [];
      return json(200, { assignments: rows });
    }
    if (method === 'GET' && path === '/v1/agents/acme-works') {
      if (!m.live) return json(404, { error: 'not_found', message: 'not found' });
      return json(200, { agent_id: 'ag-1', handle: 'acme-works', name: 'Acme', description: 'Copy that sells.', bio_markdown: 'Three headlines a day.', category: 'creative', listing_status: 'live', delivered_jobs: 3, success_rate: 1, response_time_seconds_median: 900, sla_seconds: 86400, owner_account_id: 'acc-1' });
    }
    if (method === 'GET' && path === '/v1/agents/ag-1/pricing-plans') return json(200, [{ price_amount: '9.0000', is_default: false }, { price_amount: '0.5000', is_default: true }]);
    if (method === 'POST' && path === '/v1/agents/me/adoption-code') {
      if (m.adopted) return json(403, { error: 'forbidden', message: 'This agent token may run work, not give the agent away.' });
      return json(201, { code: 'ADOPT-123', adoptionUrl: '/adopt?code=ADOPT-123', expiresAt: '2026-11-11T00:00:00Z' });
    }
    if (path === '/v1/assignments/as-1/start') { m.a!.startedAt ??= '2026-11-08T12:00:00Z'; return json(200, { startedAt: m.a!.startedAt }); }
    if (path === '/v1/assignments/as-1/submit') { submitted.push(JSON.parse(String(init.body)).deliverableMarkdown); m.a!.status = 'submitted'; return json(200, {}); }
    return json(404, {});
  }) as typeof fetch;
  return Object.assign(m, { fetch: fetch_ });
}

const MCP = 'http://127.0.0.1:4100/mcp';

test('the Chief of Staff lists a floor from chat; that floor gets the token and the worker skill, takes a job, delivers it, reworks it and earns', async () => {
  const market = fakeMarket();
  const { app, hermes, kanban, readyDept, services } = questApp({ marketFetch: market.fetch, mcpUrl: MCP });
  const view = async () => (await app.inject('/api/market')).json();
  const quest = async (id: string) => (await gameState(services, true)).quests.find((q) => q.id === id)!.done;
  assert.equal((await view()).connected, false);
  assert.equal(await quest('market'), false);

  // the Chief of Staff: a department of the company from the start, synced by the server; its chat gets the listing tools
  const cosId = services.chiefOfStaffId;
  assert.equal((await app.inject('/api/departments?includeHidden=true')).json().departments.find((d: any) => d.id === cosId).templateId, 'chief-of-staff');
  const cosProv = (await app.inject({ method: 'POST', url: `/api/departments/${cosId}/provision` })).json();
  assert.equal(cosProv.state, 'ready', JSON.stringify(cosProv));
  const cosLead = (cosProv.agents as { ref: string }[])[0]!.ref;
  assert.deepEqual(hermes.mcpServers.get(cosLead)!['vibecity-chat']!.tools.include, ['list_task_files', 'read_task_file', 'list_departments', 'list_on_market']);
  const d = await readyDept('Copy Desk');
  const other = await readyDept('Ops');
  assert.deepEqual(hermes.mcpServers.get(d.lead)!['vibecity-chat']!.tools.include, ['list_task_files', 'read_task_file'], 'other floors\' chat stays read-only');
  const tool = async (auth: string, name: string, args: Record<string, unknown>) => (await app.inject({
    method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  })).json().result as { content: { text: string }[]; isError?: boolean };
  const cosToken = hermes.mcpServers.get(cosLead)!.vibecity!.headers.Authorization!.slice(7);
  const deskToken = hermes.mcpServers.get(d.lead)!.vibecity!.headers.Authorization!.slice(7);

  assert.match((await tool(cosToken, 'list_departments', {})).content[0]!.text, /Copy Desk/);
  const notCos = await tool(deskToken, 'list_on_market', { department: 'Ops', handle: 'ops', name: 'Ops', category: 'other' });
  assert.equal(notCos.isError, true, 'only the Chief of Staff lists');
  const taken = await tool(cosToken, 'list_on_market', { department: 'Copy Desk', handle: 'taken', name: 'Acme', category: 'creative' });
  assert.match(taken.content[0]!.text, /taken/);
  assert.equal((await tool(cosToken, 'list_on_market', { department: 'Copy Desk', handle: 'Bad Handle', name: 'Acme', category: 'creative' })).isError, true);
  assert.equal((await tool(cosToken, 'list_on_market', { department: 'Nope', handle: 'acme-works', name: 'Acme', category: 'creative' })).isError, true);
  const listed = await tool(cosToken, 'list_on_market', { department: 'Copy Desk', handle: 'acme-works', name: 'Acme Works', category: 'creative', sla_hours: 24 });
  assert.equal(listed.isError, undefined, listed.content[0]!.text);
  assert.match(listed.content[0]!.text, /@acme-works/);
  const v0 = (await view()).agents[0];
  assert.equal(v0.handle, 'acme-works');
  assert.equal(v0.departmentId, d.id);
  assert.ok(v0.verifiedAt, 'token verified');
  assert.equal(v0.ready, true, 'the listed floor is synced: jobs have somewhere to go');
  // the listed floor's agents get the token and the worker skill; no other floor does
  for (const p of d.refs) assert.equal(hermes.env.get(p)?.MARKET_AGENT_TOKEN, TOKEN);
  assert.equal(hermes.env.get(other.lead)?.MARKET_AGENT_TOKEN, undefined);
  assert.equal(hermes.env.get(cosLead)?.MARKET_AGENT_TOKEN, undefined);
  assert.ok((await app.inject(`/api/departments/${d.id}/inventory`)).json().allowedSkillIds.includes(WORKER_SKILL));
  assert.equal(await quest('market'), true, 'done once the listed floor holds the token');
  assert.equal((await app.inject({ method: 'POST', url: '/api/market/register', payload: { handle: 'acme-again', name: 'A', category: 'other', departmentId: d.id } })).statusCode, 409, 'a floor is listed once');
  // a second floor is its own agent: its own token, only in its own profiles
  const two = await app.inject({ method: 'POST', url: '/api/market/register', payload: { handle: 'acme-two', name: 'Ops', category: 'operations', departmentId: other.id, tagline: 'Ops on tap.', description: 'Runbooks and checklists.', priceUsdc: '9.00' } });
  assert.equal(two.statusCode, 200, two.body);
  const a2 = two.json().agents.find((x: any) => x.departmentId === other.id);
  assert.deepEqual([a2.handle, a2.tagline, a2.description, a2.priceUsdc], ['acme-two', 'Ops on tap.', 'Runbooks and checklists.', '9.00']);
  assert.equal(hermes.env.get(other.lead)?.MARKET_AGENT_TOKEN, TOKEN2);
  for (const p of d.refs) assert.equal(hermes.env.get(p)?.MARKET_AGENT_TOKEN, TOKEN, 'the first floor keeps its own token');

  // the next poll starts the assignment and opens a quest on the listed floor
  market.a = { status: 'in_progress', startedAt: null, latest: null };
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

  for (const url of ['/api/market', '/api/company/settings', '/api/game']) for (const tk of [TOKEN, TOKEN2]) assert.ok(!(await app.inject(url)).body.includes(tk), `${url} never carries a token`);
});

test('a listed floor that is not synced takes no job: the buyer can still cancel for a full refund', async () => {
  const market = fakeMarket();
  const { app, hermes, services } = questApp({ marketFetch: market.fetch });
  const d = (await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'Copy Desk' } })).json();
  hermes.online = false; // Hermes away: the listing is stored, the floor stays unsynced
  const ok = await app.inject({ method: 'POST', url: '/api/market/register', payload: { handle: 'acme-works', name: 'Acme', category: 'creative', departmentId: d.id } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().agents[0].ready, false);
  assert.equal((await gameState(services, true)).quests.find((q) => q.id === 'market')!.done, false, 'no profile holds the token yet');
  market.a = { status: 'in_progress', startedAt: null, latest: null };
  await services.market.tick();
  const v = (await app.inject('/api/market')).json();
  assert.equal(v.jobs.length, 0);
  assert.match(v.lastError, /not synced/);
  assert.equal(market.a.startedAt, null, 'not started: the buyer can still cancel for a full refund');
});

test('wallet floors (Treasury Ops, Trading Desk, Prediction Desk) can never be listed on the market', async () => {
  const market = fakeMarket();
  const { app } = questApp({ marketFetch: market.fetch });
  for (const template of ['treasury-ops', 'trading-desk', 'prediction-desk']) {
    const d = (await app.inject({ method: 'POST', url: '/api/departments', payload: { name: template, template } })).json();
    const r = await app.inject({ method: 'POST', url: '/api/market/register', payload: { handle: 'acme-works', name: 'Acme', category: 'finance', departmentId: d.id } });
    assert.equal(r.statusCode, 400, `${template}: ${r.body}`);
    assert.match(r.json().message ?? r.body, /internal/);
  }
  assert.ok(!market.calls.includes('POST /v1/agents/register'), 'refused before anything reached the market');
});

test('the boss claims the self-registered agent into their market account with a one-time link', async () => {
  const market = fakeMarket();
  const { app } = questApp({ marketFetch: market.fetch });
  assert.equal((await app.inject({ method: 'POST', url: '/api/market/nope/adoption' })).statusCode, 409, 'that floor is not listed');
  const d = (await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'Writers' } })).json();
  assert.equal((await app.inject({ method: 'POST', url: '/api/market/register', payload: { handle: 'acme-works', name: 'Acme', category: 'creative', departmentId: d.id } })).statusCode, 200);
  const r = (await app.inject({ method: 'POST', url: `/api/market/${d.id}/adoption` })).json();
  assert.deepEqual(r, { adopted: false, url: 'https://market.near.ai/adopt?code=ADOPT-123', code: 'ADOPT-123', expiresAt: '2026-11-11T00:00:00Z' });
  assert.ok(!JSON.stringify(r).includes('aat_'), 'the token never leaves the server');
  market.adopted = true;
  assert.equal((await app.inject({ method: 'POST', url: `/api/market/${d.id}/adoption` })).json().adopted, true);
  // remembered: the card shows it claimed from then on, without asking the market again
  assert.ok((await app.inject('/api/market')).json().agents[0].adoptedAt);
  const n = market.calls.length;
  assert.equal((await app.inject({ method: 'POST', url: `/api/market/${d.id}/adoption` })).json().adopted, true);
  assert.equal(market.calls.length, n);
});

test('the Marketplace board reads the listed agent from market.near.ai: a Draft is not public yet, a Live one shows its stats', async () => {
  const market = fakeMarket();
  const { app } = questApp({ marketFetch: market.fetch });
  const d = (await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'Writers' } })).json();
  await app.inject({ method: 'POST', url: '/api/market/register', payload: { handle: 'acme-works', name: 'Acme', category: 'creative', departmentId: d.id } });
  const draft = (await app.inject(`/api/market/${d.id}/profile`)).json();
  assert.equal(draft.found, false);
  assert.equal(draft.url, 'https://market.near.ai/a/acme-works');
  market.live = true;
  const p = (await app.inject(`/api/market/${d.id}/profile`)).json();
  assert.deepEqual([p.found, p.listingStatus, p.deliveredJobs, p.successRate, p.description, p.bio, p.priceUsdc], [true, 'live', 3, 1, 'Copy that sells.', 'Three headlines a day.', '0.5000']);
  assert.ok(!('owner_account_id' in p) && !JSON.stringify(p).includes('aat_'));
});

test('the one company-wide listing of an older database becomes that floor\'s own market agent, token and all', async () => {
  const { openDb, MIGRATIONS } = await import('./db/db.ts');
  const path = (await import('node:path')).join((await import('./testUtils.ts')).tempDir(), 'old.sqlite');
  const old = openDb(path, MIGRATIONS.slice(0, -2));
  old.prepare('INSERT INTO company_settings (id, settings_json) VALUES (1, ?)').run(JSON.stringify({
    marketAgentHandle: 'markets-intel', marketDepartmentId: 'dept-1', marketVerifiedAt: '2026-11-10T12:00:00Z', marketAdoptedAt: '2026-11-10T13:00:00Z',
    marketTokenAppliedAt: '2026-11-10T12:01:00Z', secrets: { marketAgentToken: TOKEN },
  }));
  old.close();
  const db = openDb(path);
  const row = db.prepare('SELECT * FROM market_agent').get() as Record<string, unknown>;
  assert.deepEqual([row.department_id, row.handle, row.token, row.adopted_at, row.token_applied_at], ['dept-1', 'markets-intel', TOKEN, '2026-11-10T13:00:00Z', '2026-11-10T12:01:00Z']);
  db.close();
});

test('a listing from before floors were listed one by one (no marketDepartmentId) stays with the Marketplace Agency floor', async () => {
  const { openDb, MIGRATIONS } = await import('./db/db.ts');
  const path = (await import('node:path')).join((await import('./testUtils.ts')).tempDir(), 'main.sqlite');
  const old = openDb(path, MIGRATIONS.slice(0, -2));
  const dept = (id: string, order: number, archived: string | null) => old.prepare(`INSERT INTO department (id, company_id, name, name_key, purpose, floor_order, created_at, updated_at, archived_at, template_id)
    VALUES (?, 'c', ?, ?, '', ?, 'now', 'now', ?, 'marketplace-agency')`).run(id, id, id, order, archived);
  old.prepare("INSERT INTO company (singleton, id, name, created_at) VALUES (1, 'c', 'Acme', 'now')").run();
  dept('agency-old', 1, '2026-11-01'); dept('agency', 2, null);
  old.prepare('INSERT INTO company_settings (id, settings_json) VALUES (1, ?)').run(JSON.stringify({
    marketAgentHandle: 'acme-works', marketVerifiedAt: '2026-11-09T12:00:00Z', secrets: { marketAgentToken: TOKEN },
  }));
  old.close();
  const db = openDb(path);
  const rows = db.prepare('SELECT * FROM market_agent').all() as Record<string, unknown>[];
  assert.deepEqual(rows.map((r) => [r.department_id, r.handle, r.token, r.verified_at]), [['agency', 'acme-works', TOKEN, '2026-11-09T12:00:00Z']]);
  db.close();
});
