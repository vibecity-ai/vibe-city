import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/db.ts';
import { buildServices } from './app.ts';
import { createDept } from './testUtils.ts';
import { FakeChatModel, OpenAiCompatModel } from './model/chatModel.ts';
import { parseAgentReply } from './domain/chatService.ts';
import { generateCharacter } from './domain/characters.ts';

const setup = (model?: FakeChatModel) => {
  const db = openDb(':memory:');
  const { app } = buildServices(db, undefined, model ? { chatModel: model } : {});
  return { db, app };
};

test('characters are deterministic per seat and stored on first use', async () => {
  const { app } = setup();
  const { json } = await createDept(app, { name: 'Research', purpose: 'Track competitors' });
  const a = (await app.inject(`/api/departments/${json.id}/characters/chief`)).json();
  const b = (await app.inject(`/api/departments/${json.id}/characters/chief`)).json();
  assert.deepEqual(a, b);
  assert.equal(a.role, 'chief');
  assert.equal(a.title, 'Research chief');
  const w = (await app.inject(`/api/departments/${json.id}/characters/W-01`)).json();
  assert.equal(w.role, 'worker');
  assert.notEqual(w.name, '');
  assert.deepEqual(generateCharacter(json.id, 'Research', 'W-01'), w);
});

test('unknown agent keys are 404', async () => {
  const { app } = setup();
  const { json } = await createDept(app, { name: 'Ops' });
  assert.equal((await app.inject(`/api/departments/${json.id}/characters/boss`)).statusCode, 404);
  assert.equal((await app.inject(`/api/departments/${json.id}/characters/W-1`)).statusCode, 404);
});

test('without a model, history says so and sending is 503', async () => {
  const { app } = setup();
  const { json } = await createDept(app, { name: 'Legal' });
  const h = (await app.inject(`/api/departments/${json.id}/characters/chief/chat`)).json();
  assert.equal(h.modelReady, false);
  assert.deepEqual(h.messages, []);
  const r = await app.inject({ method: 'POST', url: `/api/departments/${json.id}/characters/chief/chat`, payload: { message: 'hi' } });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().error, 'model_unavailable');
});

test('chat stores both turns, sends persona + history, and returns a quest proposal', async () => {
  const model = new FakeChatModel((m) => m.length > 2
    ? JSON.stringify({ say: 'I can have a brief by Friday.', mood: 'focused', replies: ['Do it', 'Not now'], proposal: { kind: 'quest', title: 'Competitor brief', objective: 'Summarise three competitors.' } })
    : '```json\n{"say": "Hey boss.", "mood": "happy", "replies": ["What are you on?"], "proposal": null}\n```');
  const { app } = setup(model);
  const { json } = await createDept(app, { name: 'Research', purpose: 'Track competitors' });
  const url = `/api/departments/${json.id}/characters/chief/chat`;
  const r1 = await app.inject({ method: 'POST', url, payload: { message: 'Hello' } });
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.json().agent.text, 'Hey boss.');
  assert.equal(r1.json().agent.mood, 'happy');
  const r2 = await app.inject({ method: 'POST', url, payload: { message: 'Can you look at our competitors?' } });
  const reply = r2.json().agent;
  assert.equal(reply.proposal.title, 'Competitor brief');
  assert.deepEqual(reply.replies, ['Do it', 'Not now']);
  const sys = model.calls[1]![0]!.content;
  assert.match(sys, /Track competitors/);
  assert.match(sys, /Research chief/);
  assert.equal(model.calls[1]!.length, 4); // system + 2 past turns + new message
  const hist = (await app.inject(url)).json();
  assert.equal(hist.messages.length, 4);
  assert.equal(hist.modelReady, true);
});

test('parseAgentReply falls back to plain text and drops invalid fields', () => {
  assert.deepEqual(parseAgentReply('Just words.'), { text: 'Just words.', mood: 'neutral', replies: [], proposal: null });
  const r = parseAgentReply('<think>hmm</think>{"say":"Yo","mood":"furious","replies":[1,"ok"],"proposal":{"title":""}}');
  assert.equal(r.text, 'Yo'); assert.equal(r.mood, 'neutral'); assert.deepEqual(r.replies, ['ok']); assert.equal(r.proposal, null);
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
