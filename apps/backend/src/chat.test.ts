import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/db.ts';
import { buildServices } from './app.ts';
import { createDept, questApp } from './testUtils.ts';
import { OpenAiCompatModel } from './model/chatModel.ts';
import { FakeHermes } from './testing/fakeHermes.ts';
import { FakeAgentChat } from './testing/fakeAgentChat.ts';
import { HermesAgentChat } from './hermes/agentChat.ts';
import { HermesAuthError } from './hermes/ports.ts';
import { parseAgentReply } from './domain/chatService.ts';
import { generateCharacter } from './domain/characters.ts';

const setup = () => {
  const db = openDb(':memory:');
  const { app } = buildServices(db);
  return { db, app };
};

test('characters are deterministic per seat and stored on first use', async () => {
  const { app } = setup();
  const { json } = await createDept(app, { name: 'Research', purpose: 'Track competitors' });
  const a = (await app.inject(`/api/departments/${json.id}/characters/chief`)).json();
  const b = (await app.inject(`/api/departments/${json.id}/characters/chief`)).json();
  assert.deepEqual(a, b);
  assert.equal(a.role, 'chief');
  assert.equal(a.title, 'Research lead');
  const w = (await app.inject(`/api/departments/${json.id}/characters/W-01`)).json();
  assert.equal(w.role, 'worker');
  assert.notEqual(w.name, '');
  // the lead was stored first, so the teammate's name is picked with the lead's name taken (a rare hash collision re-picks)
  assert.deepEqual(generateCharacter(json.id, 'Research', 'W-01', new Set([a.name])), w);
});

test('without a provisioned profile, history says so and sending is 503', async () => {
  const { app } = setup();
  const { json } = await createDept(app, { name: 'Legal' });
  const h = (await app.inject(`/api/departments/${json.id}/characters/chief/chat`)).json();
  assert.equal(h.modelReady, false);
  assert.deepEqual(h.messages, []);
  const r = await app.inject({ method: 'POST', url: `/api/departments/${json.id}/characters/chief/chat`, payload: { message: 'hi' } });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().error, 'model_unavailable');
});

/** A ready department whose agents chat through a scripted agent standing in for their Hermes profiles. */
const agentApp = (answer?: ConstructorParameters<typeof FakeAgentChat>[1]) => {
  const hermes = new FakeHermes();
  const agentChat = new FakeAgentChat(hermes, answer);
  const q = questApp({ agentChat, agentEnv: { NEAR_AI_API_KEY: 'near-secret' } }, hermes);
  return { ...q, agentChat };
};

test('chat talks to the agent\'s own profile, in one session, with its own key, and returns a quest proposal', async () => {
  const { app, hermes, kanban, agentChat, readyDept } = agentApp((t, history) => history.length
    ? 'I can have a brief by Friday.\n<vc>{"mood":"focused","replies":["Do it","Not now"],"proposal":{"title":"Competitor brief","objective":"Summarise three competitors."}}</vc>'
    : 'Hey boss.\n<vc>{"mood":"happy","replies":["What are you on?"],"proposal":null}</vc>');
  const d = await readyDept('Research', {});
  await kanban.createTask(d.board, { title: 'Scan competitor pricing' });
  const url = `/api/departments/${d.id}/characters/chief/chat`;
  assert.equal((await app.inject(url)).json().modelReady, true);
  const r1 = await app.inject({ method: 'POST', url, payload: { message: 'Hello' } });
  assert.equal(r1.statusCode, 200);
  assert.deepEqual([r1.json().agent.text, r1.json().agent.mood], ['Hey boss.', 'happy']);
  const r2 = await app.inject({ method: 'POST', url, payload: { message: 'Can you look at our competitors?' } });
  const reply = r2.json().agent;
  assert.equal(reply.text, 'I can have a brief by Friday.');
  assert.equal(reply.proposal.title, 'Competitor brief');
  assert.deepEqual(reply.replies, ['Do it', 'Not now']);
  // Both turns went to the lead's profile, in the same session, with the key Vibe City set in that profile.
  const [t1, t2] = agentChat.turns;
  assert.equal(t1!.profile, d.lead);
  assert.equal(t2!.sessionId, t1!.sessionId);
  assert.equal(t1!.key, hermes.env.get(d.lead)?.API_SERVER_KEY);
  assert.equal(hermes.env.get(d.lead)?.NEAR_AI_API_KEY, 'near-secret'); // multiplexed profiles read credentials only from their .env
  assert.equal(t2!.message, 'Can you look at our competitors?'); // Hermes holds the history: only the new message is sent
  assert.match(t1!.system, /Research/);
  assert.match(t1!.system, /Research lead/);
  assert.match(t1!.system, /\[ready\] Scan competitor pricing/, 'the board is in the prompt');
  assert.doesNotMatch(t1!.system, /terminal/, 'chat is never pointed at the shell');
  assert.equal((await app.inject(url)).json().messages.length, 4);
  // A teammate is its own profile, with its own key and session.
  await app.inject({ method: 'POST', url: `/api/departments/${d.id}/characters/W-01/chat`, payload: { message: 'Hi' } });
  assert.equal(agentChat.turns[2]!.profile, d.teammate);
  assert.notEqual(agentChat.turns[2]!.key, t1!.key);
});

test('a rejected key is replaced once and the turn retried', async () => {
  const { app, hermes, agentChat, readyDept } = agentApp();
  const d = await readyDept('Ops', {});
  const url = `/api/departments/${d.id}/characters/chief/chat`;
  await app.inject({ method: 'POST', url, payload: { message: 'one' } });
  hermes.env.set(d.lead, { API_SERVER_KEY: 'changed-outside-vibe-city' });
  const r = await app.inject({ method: 'POST', url, payload: { message: 'two' } });
  assert.equal(r.statusCode, 200);
  assert.equal(agentChat.turns.length, 2);
  assert.equal(agentChat.turns[1]!.key, hermes.env.get(d.lead)?.API_SERVER_KEY);
  assert.equal(agentChat.turns[1]!.sessionId, agentChat.turns[0]!.sessionId); // same conversation
});

test('an agent has many chats: a new one, then resuming the old one; a chat Vibe City never saw is read from Hermes', async () => {
  const { app, hermes, agentChat, readyDept } = agentApp();
  const d = await readyDept('Chats', {});
  const url = `/api/departments/${d.id}/characters/chief/chat`;
  await app.inject({ method: 'POST', url, payload: { message: 'first chat' } });
  const first = (await app.inject(url)).json();
  assert.equal(first.messages.length, 2);
  assert.match(agentChat.turns[0]!.title, /^first chat · [0-9a-f]{8}$/); // the Hermes session is named after its opening line

  const fresh = (await app.inject(`${url}?session=new`)).json();
  assert.notEqual(fresh.sessionId, first.sessionId);
  assert.deepEqual(fresh.messages, []);
  await app.inject({ method: 'POST', url, payload: { message: 'second chat', sessionId: fresh.sessionId } });
  assert.equal(agentChat.turns[1]!.sessionId, fresh.sessionId);
  assert.equal((await app.inject(url)).json().sessionId, fresh.sessionId, 'the window reopens on the last chat used');

  await app.inject({ method: 'POST', url, payload: { message: 'back to the first', sessionId: first.sessionId } });
  assert.equal(agentChat.turns[2]!.sessionId, first.sessionId);
  assert.deepEqual((await app.inject(`${url}?session=${first.sessionId}`)).json().messages.map((m: any) => m.text).filter((_: string, i: number) => i % 2 === 0), ['first chat', 'back to the first']);

  hermes.sessionLog.set(`${d.lead}/cli-chat-1`, [
    { role: 'user', content: 'hi from the terminal', at: '2026-11-01T10:00:00.000Z', calls: [], toolCallId: null, toolName: null },
    { role: 'assistant', content: '', at: '2026-11-01T10:00:02.000Z', calls: [{ id: 'c1', name: 'terminal', args: '{"command":"ls"}' }], toolCallId: null, toolName: null },
    { role: 'tool', content: '{"output":"a.md"}', at: '2026-11-01T10:00:03.000Z', calls: [], toolCallId: 'c1', toolName: 'terminal' },
    { role: 'assistant', content: 'Hello.\n<vc>{"mood":"happy","replies":["Thanks"],"proposal":null}</vc>', at: '2026-11-01T10:00:05.000Z', calls: [], toolCallId: null, toolName: null },
  ]);
  const old = (await app.inject(`${url}?session=cli-chat-1`)).json();
  assert.deepEqual(old.messages.map((m: any) => [m.from, m.text, m.mood]), [['user', 'hi from the terminal', null], ['agent', 'Hello.', 'happy']]);
  assert.deepEqual((await app.inject(`${url}?session=gone-1`)).json().messages, []);
  assert.equal((await app.inject(`${url}?session=..%2Fx`)).statusCode, 400);
});

test('the stream endpoint relays progress, then the reply; errors arrive as an error event', async () => {
  const { app, agentChat, readyDept } = agentApp();
  agentChat.events = [{ kind: 'thinking' }, { kind: 'tool', name: 'kanban_list', preview: 'board' }];
  const d = await readyDept('Ops', {});
  const r = await app.inject({ method: 'POST', url: `/api/departments/${d.id}/characters/chief/chat/stream`, payload: { message: 'status?' } });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'] as string, /text\/event-stream/);
  const events = [...r.body.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => [m[1], JSON.parse(m[2]!)]);
  assert.deepEqual(events.map((e) => e[0]), ['progress', 'progress', 'reply']);
  assert.deepEqual(events[1]![1], { kind: 'tool', name: 'kanban_list', preview: 'board' });
  assert.equal(events[2]![1].agent.text, 'On it, boss.');
  const bad = await app.inject({ method: 'POST', url: `/api/departments/${d.id}/characters/W-09/chat/stream`, payload: { message: 'x' } });
  assert.match(bad.body, /event: error\ndata: .*"status":503/);
  // Validation still answers with a plain HTTP error before any stream starts.
  assert.equal((await app.inject({ method: 'POST', url: `/api/departments/${d.id}/characters/chief/chat/stream`, payload: { message: '' } })).statusCode, 400);
});

test('parseAgentReply splits the <vc> tag off and never loses the words', () => {
  assert.deepEqual(parseAgentReply('Just words.'), { text: 'Just words.', mood: 'neutral', replies: [], proposal: null });
  const r = parseAgentReply('<think>hmm</think>Yo boss.\n<vc>{"mood":"furious","replies":[1,"ok"],"proposal":{"title":""}}</vc>');
  assert.equal(r.text, 'Yo boss.'); assert.equal(r.mood, 'neutral'); assert.deepEqual(r.replies, ['ok']); assert.equal(r.proposal, null);
  assert.equal(parseAgentReply('Done.\n<vc>{"mood": "happy", broken').text, 'Done.');
  assert.equal(parseAgentReply('Done.\n<vc>```json\n{"mood":"happy"}\n```</vc>').mood, 'happy');
});

test('the OpenAI-compatible model sends the key and never leaks it in errors', async () => {
  let seen: { url: string; auth: string | null } | null = null;
  const ok = new OpenAiCompatModel({ baseUrl: 'https://x.test/v1/', apiKey: 'secret-key', model: 'm', fetch: (async (url: string, init: RequestInit) => {
    seen = { url, auth: new Headers(init.headers).get('authorization') };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 });
  }) as typeof fetch });
  assert.equal(await ok.complete([{ role: 'user', content: 'x' }]), 'hi');
  assert.deepEqual(seen, { url: 'https://x.test/v1/chat/completions', auth: 'Bearer secret-key' });
  const bad = new OpenAiCompatModel({ baseUrl: 'https://x.test/v1', apiKey: 'secret-key', model: 'm', fetch: (async () => new Response('nope secret-key', { status: 401 })) as typeof fetch });
  await assert.rejects(bad.complete([]), (e: Error) => !e.message.includes('secret-key') && /rejected the API key/.test(e.message));
});

test('the Hermes agent client creates the session, follows the stream and maps auth errors', async () => {
  const seen: { url: string; auth: string | null; body: any }[] = [];
  const frames = [
    'event: run.started\ndata: {"run_id":"r1"}\n\n', ': keepalive\n\n',
    'event: tool.progress\ndata: {"tool_name":"_thinking","delta":"hm"}\n\n',
    'event: tool.started\ndata: {"tool_name":"terminal","preview":"ls"}\n\n',
    // a skill load, as Hermes 0.22.6's session chat stream sends it (api_server: tool_name, preview, args)
    'event: tool.started\ndata: {"message_id":"m1","tool_name":"skill_view","preview":"vibe-city","args":{"name":"vibe-city"}}\n\n',
    'event: assistant.completed\ndata: {"content":"Found it, boss."}\n\n', 'event: done\ndata: {}\n\n',
  ];
  const fetch_ = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
    if (url.endsWith('/api/sessions')) return new Response('{"error":{"message":"exists"}}', { status: seen.length === 1 ? 201 : 409 });
    // Frames split across chunks, as a real socket delivers them.
    const bytes = new TextEncoder().encode(frames.join(''));
    return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } }), { status: 200 });
  }) as typeof fetch;
  const client = new HermesAgentChat({ baseUrl: 'http://hermes.test:8642/', fetch: fetch_ });
  const events: unknown[] = [];
  const turn = { profile: 'vc-abc-chief', key: 'k'.repeat(48), sessionId: 'vibecity-ceo-1', title: 'what did you find?', message: 'what did you find?', system: 'persona' };
  assert.equal(await client.turn(turn, (e) => events.push(e)), 'Found it, boss.');
  assert.deepEqual(events, [{ kind: 'thinking' }, { kind: 'tool', name: 'terminal', preview: 'ls' }, { kind: 'skill', name: 'vibe-city' }]);
  assert.equal(seen[1]!.url, 'http://hermes.test:8642/p/vc-abc-chief/api/sessions/vibecity-ceo-1/chat/stream');
  assert.equal(seen[1]!.auth, `Bearer ${'k'.repeat(48)}`);
  assert.deepEqual(seen[1]!.body, { message: 'what did you find?', system_message: 'persona' });
  assert.equal(await client.turn(turn), 'Found it, boss.'); // 409 on create = the session already exists

  const unfinished = new HermesAgentChat({ baseUrl: 'http://hermes.test:8642', fetch: (async (url: string) => url.endsWith('/api/sessions')
    ? new Response('{}', { status: 201 })
    : new Response('event: assistant.completed\ndata: {"content":"I couldn\'t connect to the AI model service","completed":false}\n\n', { status: 200 })) as typeof fetch });
  await assert.rejects(unfinished.turn(turn), /could not finish: I couldn't connect/);

  const denied = new HermesAgentChat({ baseUrl: 'http://hermes.test:8642', fetch: (async () => new Response('{"error":{"message":"Invalid gateway API key"}}', { status: 401 })) as typeof fetch });
  await assert.rejects(denied.turn(turn), HermesAuthError);
  await assert.rejects(client.turn({ ...turn, profile: '../x' }), /invalid profile/);
});

test('a chat about a blocked task tells the agent why it is blocked, and its resume suggestion reaches the window', async () => {
  const { app, agentChat, readyDept } = agentApp(() => 'I can skip the install and list the commands.\n<vc>{"mood":"focused","replies":[],"proposal":null,"resume":"Skip the install; document the 5 commands."}</vc>');
  const d = await readyDept('Desk', {});
  const r = await app.inject({ method: 'POST', url: `/api/departments/${d.id}/characters/chief/chat`, payload: { message: 'What do you need?', blockedTask: { title: 'Install skills', reason: 'No shell access' } } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().agent.resume, 'Skip the install; document the 5 commands.');
  assert.match(agentChat.turns[0]!.system, /"Install skills", which is blocked .*No shell access/);
  assert.equal(parseAgentReply('Hi.\n<vc>{"mood":"happy","replies":[],"proposal":null}</vc>').resume, undefined);
  // a failed task: the agent is told it failed, with the error, and that the boss can retry it
  await app.inject({ method: 'POST', url: `/api/departments/${d.id}/characters/chief/chat`, payload: { message: 'What happened?', blockedTask: { title: 'Scrape A', reason: 'HTTP 403', failed: true } } });
  assert.match(agentChat.turns[1]!.system, /"Scrape A", which failed .*The error: "HTTP 403".*retry it/);
});

test('a lead that phoned about a finished quest is told to report on it, reading the task files first', async () => {
  const { app, agentChat, readyDept } = agentApp(() => 'Done: three competitors summarised.\n<vc>{"mood":"happy","replies":[],"proposal":null}</vc>');
  const d = await readyDept('Desk', {});
  const url = `/api/departments/${d.id}/characters/chief/chat`;
  assert.equal((await app.inject({ method: 'POST', url, payload: { message: 'Report?', finishedQuest: { title: 'Competitor brief' } } })).statusCode, 200);
  assert.match(agentChat.turns[0]!.system, /the quest "Competitor brief" on your board is finished.*read the task files first/);
  await app.inject({ method: 'POST', url, payload: { message: 'Thanks' } });
  assert.doesNotMatch(agentChat.turns[1]!.system, /is finished, and they picked up/, 'only the call carries the report context');
});

test('the Chief of Staff answers from a briefing of every floor and proposes a job for the floor it names', async () => {
  const { app, services, agentChat, kanban, readyDept } = agentApp((t) => /nobody/.test(t.message)
    ? 'Sales should.\n<vc>{"mood":"happy","replies":["OK"],"proposal":{"department":"Sales","title":"Call leads","objective":"Call ten leads."}}</vc>'
    : 'Research can.\n<vc>{"mood":"happy","replies":["Add a new floor"],"proposal":{"department":"research","title":"Competitor brief","objective":"Summarise three competitors."},"report":{"needs_you":["Win your first job"],"in_flight":[{"text":"Scan competitor pricing is ready","floor":"Research"},{"text":"","floor":"Research"}],"money":"$0 earned (estimate)"}}</vc>');
  const cos = services.chiefOfStaffId;
  assert.equal((await app.inject({ method: 'POST', url: `/api/departments/${cos}/provision` })).json().state, 'ready');
  const d = await readyDept('Research', {});
  await kanban.createTask(d.board, { title: 'Scan competitor pricing' });
  const url = `/api/departments/${cos}/characters/chief/chat`;
  const r = await app.inject({ method: 'POST', url, payload: { message: 'Look at our competitors' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().agent.proposal, { kind: 'quest', title: 'Competitor brief', objective: 'Summarise three competitors.', departmentId: d.id, departmentName: 'Research' });
  // a status report arrives as rows, and a row about a floor that exists carries where to go
  assert.deepEqual(r.json().agent.briefing, { needsYou: [{ text: 'Win your first job' }], inFlight: [{ text: 'Scan competitor pricing is ready', departmentId: d.id, departmentName: 'Research' }], money: '$0 earned (estimate)' });
  const system = agentChat.turns[0]!.system;
  assert.match(system, /### Research[\s\S]*\[ready\] Scan competitor pricing/, 'every floor and its board are in the prompt: no tool call to know them');
  assert.match(system, /CEO quests: \d of 7 done/);
  assert.match(system, /floor sits idle[^\n]*"Give a floor a job"/, 'an idle floor gets a job offered from the chat');
  assert.doesNotMatch(system, /### Chief of Staff/, 'its own empty board is not a floor');
  // a floor that does not exist has no board to put the job on
  assert.equal((await app.inject({ method: 'POST', url, payload: { message: 'nobody' } })).json().agent.proposal, null);
  // a floor's lead still proposes for its own floor
  const f = await app.inject({ method: 'POST', url: `/api/departments/${d.id}/characters/chief/chat`, payload: { message: 'Look at our competitors' } });
  assert.deepEqual(f.json().agent.proposal, { kind: 'quest', title: 'Competitor brief', objective: 'Summarise three competitors.' });
  assert.equal(f.json().agent.briefing, undefined, 'only the Chief of Staff reports on the company');
});

test('task ids the agent writes reach the window as the task titles from the board', async () => {
  let id = '';
  const { app, kanban, agentChat, readyDept } = agentApp(() => `${id} is done; t_unknown is not on the board.\n<vc>{"mood":"happy","replies":["What was in ${id}?"],"proposal":null}</vc>`);
  const d = await readyDept('Research', {});
  id = (await kanban.createTask(d.board, { title: 'Scan competitor pricing' })).task.id;
  const r = await app.inject({ method: 'POST', url: `/api/departments/${d.id}/characters/chief/chat`, payload: { message: 'Status?' } });
  assert.equal(r.json().agent.text, '"Scan competitor pricing" is done; t_unknown is not on the board.');
  assert.deepEqual(r.json().agent.replies, ['What was in "Scan competitor pricing"?']);
  assert.match(agentChat.turns[0]!.system, new RegExp(`${id} \\[`), 'the prompt keeps the id for the file tools');
});

test('a floor still being built is briefed as one the Chief of Staff can give its first job', async () => {
  const { app, services, agentChat, readyDept } = agentApp(() => 'A launch post to start.\n<vc>{"mood":"happy","replies":[],"proposal":{"department":"Growth","title":"Write a launch post","objective":"Draft one launch post."}}</vc>');
  const cos = services.chiefOfStaffId;
  await app.inject({ method: 'POST', url: `/api/departments/${cos}/provision` });
  const d = await readyDept('Growth', {});
  services.departments.patchRow(d.id, { provisioning_state: 'provisioning' });
  const r = await app.inject({ method: 'POST', url: `/api/departments/${cos}/characters/chief/chat`, payload: { message: 'Give them a first job' } });
  assert.equal(r.json().agent.proposal?.departmentId, d.id);
  assert.match(agentChat.turns[0]!.system, /### Growth[\s\S]*being built in Hermes right now: propose its jobs/);
});
