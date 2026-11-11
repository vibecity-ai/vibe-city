import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questApp } from './testUtils.ts';

const MCP = 'http://127.0.0.1:4100/mcp';

async function setup() {
  const qa = questApp({ mcpUrl: MCP });
  const research = await qa.readyDept('Research');
  const growth = await qa.readyDept('Growth');
  const cfg = qa.hermes.mcpServers.get(growth.lead)!.vibecity!;
  const token = cfg.headers.Authorization!.slice(7);
  const rpc = async (method: string, params: Record<string, unknown> = {}, auth = token) =>
    qa.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: 1, method, params } });
  const tool = async (name: string, args: Record<string, unknown>, auth = token) => (await rpc('tools/call', { name, arguments: args }, auth)).json().result;
  return { ...qa, research, growth, token, rpc, tool };
}

test('provisioning gives every agent the Vibe City MCP server with its department\'s token and only the three tools', async () => {
  const { hermes, research, growth, rpc } = await setup();
  const a = hermes.mcpServers.get(research.lead)!.vibecity!, b = hermes.mcpServers.get(growth.lead)!.vibecity!;
  assert.equal(a.url, MCP);
  assert.deepEqual(a.tools.include, ['list_departments', 'request_quest', 'check_request']);
  assert.notEqual(a.headers.Authorization, b.headers.Authorization);
  assert.deepEqual(hermes.mcpServers.get(research.teammate)!.vibecity, a, 'teammates share their department\'s token');
  const init = (await rpc('initialize', { protocolVersion: '2025-06-18' })).json();
  assert.equal(init.result.serverInfo.name, 'vibe-city');
  assert.deepEqual((await rpc('tools/list')).json().result.tools.map((t: any) => t.name), ['list_departments', 'request_quest', 'check_request', 'list_task_files', 'read_task_file', 'list_on_market']);
  assert.equal((await rpc('tools/list', {}, 'vc_wrong')).statusCode, 401);
});

test('an agent requests a quest from another department: it lands on that board, assigned to its lead, origin recorded', async () => {
  const { app, kanban, research, growth, tool } = await setup();
  const list = await tool('list_departments', {});
  assert.match(list.content[0].text, /Research/);
  assert.doesNotMatch(list.content[0].text, /Growth/, 'not itself');
  const r = await tool('request_quest', { department: 'research', title: 'Competitor brief', objective: 'Summarise three competitors.', reason: 'Launch copy' });
  assert.ok(!r.isError, r.content[0].text);
  const reqs = (await app.inject('/api/quest-requests')).json().requests;
  assert.equal(reqs[0].state, 'created');
  assert.equal(reqs[0].fromName, 'Growth');
  const quests = (await app.inject(`/api/departments/${research.id}/quests`)).json().quests;
  const q = quests.find((x: any) => x.id === reqs[0].questId);
  assert.equal(q.title, 'Competitor brief');
  assert.equal(kanban.statusOf(research.board, q.id) !== undefined, true);
  const origins = (await app.inject('/api/quest-origins')).json().origins;
  assert.deepEqual(origins.find((o: any) => o.questId === q.id), { questId: q.id, departmentId: research.id, origin: 'agent', fromDepartmentId: growth.id, fromName: 'Growth', requestId: reqs[0].id });
  const check = await tool('check_request', { request_id: reqs[0].id });
  assert.match(check.content[0].text, /Competitor brief.*Research/);
});

test('guardrails: unknown, self, allowlist, and no handing work back', async () => {
  const { app, research, growth, tool } = await setup();
  assert.ok((await tool('request_quest', { department: 'Legal', title: 'x', objective: 'y' })).isError);
  assert.match((await tool('request_quest', { department: 'Growth', title: 'x', objective: 'y' })).content[0].text, /itself/);
  await app.inject({ method: 'PATCH', url: `/api/departments/${research.id}/quest-policy`, payload: { allowFrom: [] } });
  assert.match((await tool('request_quest', { department: 'Research', title: 'x', objective: 'y' })).content[0].text, /does not accept work from Growth/);
  await app.inject({ method: 'PATCH', url: `/api/departments/${research.id}/quest-policy`, payload: { allowFrom: '*' } });
  assert.ok(!(await tool('request_quest', { department: 'Research', title: 'Brief', objective: 'y' })).isError);
  // Research cannot hand work back to Growth while Growth's request is open.
  const back = await app.inject({ method: 'POST', url: '/api/quest-requests', payload: { fromDepartmentId: research.id, department: 'Growth', title: 'Back', objective: 'z' } });
  assert.equal(back.json().state, 'rejected');
  assert.match(back.json().note, /waiting on work from Research/);
});

test('over the daily cap a request waits for the CEO; approve creates it, reject closes it', async () => {
  const { app, research, growth, tool } = await setup();
  await app.inject({ method: 'PATCH', url: `/api/departments/${growth.id}/quest-policy`, payload: { dailyCap: 1 } });
  assert.ok(!(await tool('request_quest', { department: 'Research', title: 'One', objective: 'a' })).isError);
  const two = await tool('request_quest', { department: 'Research', title: 'Two', objective: 'b' });
  assert.match(two.content[0].text, /waiting for the CEO/);
  const pending = (await app.inject('/api/quest-requests')).json().requests.find((r: any) => r.title === 'Two');
  assert.equal(pending.state, 'pending_approval');
  const ok = (await app.inject({ method: 'POST', url: `/api/quest-requests/${pending.id}/approve` })).json();
  assert.equal(ok.state, 'created');
  assert.ok(ok.questId);
  await tool('request_quest', { department: 'Research', title: 'Three', objective: 'c' });
  const three = (await app.inject('/api/quest-requests')).json().requests.find((r: any) => r.title === 'Three');
  assert.equal((await app.inject({ method: 'POST', url: `/api/quest-requests/${three.id}/reject` })).json().state, 'rejected');
  assert.equal((await app.inject({ method: 'POST', url: `/api/quest-requests/${three.id}/approve` })).statusCode, 409);
  void research;
});

test('quests the CEO creates are recorded with origin user', async () => {
  const { app, research, create } = await setup();
  const r = await create(research.id, { title: 'Mine' });
  const origins = (await app.inject('/api/quest-origins')).json().origins;
  assert.equal(origins.find((o: any) => o.questId === r.json().questId).origin, 'user');
});

test('chat gets a read-only server entry with only the file tools; it reads its own board\'s task files, never another\'s', async () => {
  const { app, services, hermes, kanban, research, growth, tool } = await setup();
  const chat = hermes.mcpServers.get(growth.lead)!['vibecity-chat']!;
  assert.deepEqual(chat.tools.include, ['list_task_files', 'read_task_file']);
  assert.equal(chat.headers.Authorization, hermes.mcpServers.get(growth.lead)!.vibecity!.headers.Authorization);
  assert.deepEqual(hermes.platformMcp.get(growth.lead), { api_server: ['vibecity-chat'] }, 'naming it makes chat an allowlist: no request_quest');

  const mine = (await kanban.createTask(growth.board, { title: 'Market scan' })).task;
  kanban.attach(growth.board, mine.id, 'scan.md', '# Scan\nThree competitors.');
  kanban.attach(growth.board, mine.id, 'logo.png', 'PNG\u0000\u0001binary');
  const theirs = (await kanban.createTask(research.board, { title: 'Secret' })).task;
  kanban.attach(research.board, theirs.id, 'secret.md', 'not yours');

  assert.match((await tool('list_task_files', { task_id: mine.id })).content[0].text, /scan\.md \(\d+ bytes\)[\s\S]*logo\.png/);
  assert.equal((await tool('read_task_file', { task_id: mine.id, filename: 'scan.md' })).content[0].text, '# Scan\nThree competitors.');
  const bin = await tool('read_task_file', { task_id: mine.id, filename: 'logo.png' });
  assert.ok(bin.isError && /binary/.test(bin.content[0].text));
  assert.ok((await tool('read_task_file', { task_id: mine.id, filename: 'nope.md' })).isError);
  for (const r of [await tool('list_task_files', { task_id: theirs.id }), await tool('read_task_file', { task_id: theirs.id, filename: 'secret.md' })]) {
    assert.ok(r.isError, 'another department\'s task is not found');
    assert.doesNotMatch(r.content[0].text, /not yours/);
  }
  // naming a floor opens its board to the Chief of Staff only
  assert.ok((await tool('read_task_file', { task_id: theirs.id, filename: 'secret.md', department: 'Research' })).isError);
  const cos = services.chiefOfStaffId;
  assert.equal((await app.inject({ method: 'POST', url: `/api/departments/${cos}/provision` })).json().state, 'ready');
  const cosToken = hermes.mcpServers.get(services.departments.get(cos).agents[0]!.profileRef!)!.vibecity!.headers.Authorization!.slice(7);
  assert.equal((await tool('read_task_file', { task_id: theirs.id, filename: 'secret.md', department: 'research' }, cosToken)).content[0].text, 'not yours');
  assert.match((await tool('list_task_files', { task_id: mine.id, department: 'Growth' }, cosToken)).content[0].text, /scan\.md/);
  assert.ok((await tool('list_task_files', { task_id: mine.id, department: 'Nowhere' }, cosToken)).isError);
});

test('the listed (external) floor cannot request work from a wallet floor; other floors still can', async () => {
  const { app, db, kanban, growth, research, tool } = await setup();
  const t = (await app.inject({ method: 'POST', url: '/api/departments', payload: { name: 'Treasury', template: 'treasury-ops' } })).json();
  assert.equal((await app.inject({ method: 'POST', url: `/api/departments/${t.id}/provision` })).json().state, 'ready');
  kanban.addBoard(t.hermesBoardSlug);
  db.prepare("INSERT INTO market_agent (department_id, handle, token, created_at) VALUES (?, 'growth', 'aat_x', '2026-11-10')").run(growth.id);
  const r = await tool('request_quest', { department: 'Treasury', title: 'Swap', objective: 'Swap 100 NEAR to USDC' });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /internal/);
  assert.match((await tool('list_departments', {})).content[0].text, /- Treasury \(internal: never listed on the market\) \(does not accept work from you\)/);
  const ok = await app.inject({ method: 'POST', url: '/api/quest-requests', payload: { fromDepartmentId: research.id, department: 'Treasury', title: 'Rebalance', objective: 'z' } });
  assert.equal(ok.json().state, 'created', ok.body);
});
