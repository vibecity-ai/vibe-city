import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from './api.ts';
import { DEPT_ID, deptView, fakeBackend, iso } from './testing/fakeBackend.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const use = (b: ReturnType<typeof fakeBackend>) => { globalThis.fetch = b.fetch; return b; };
const D = `/api/departments/${DEPT_ID}`;

test('a malformed success payload becomes an invalid_response ApiError (no partial data)', async () => {
  use(fakeBackend().on('GET', D, { body: { ...deptView(), state: 'exploded' } }));
  await assert.rejects(api.department(DEPT_ID), (e: unknown) => e instanceof ApiError && e.code === 'invalid_response' && e.status === 200);
});

test('strict schemas reject leaked server-only fields (absolute paths, stored_path)', async () => {
  use(fakeBackend()
    .on('GET', D, { body: { ...deptView(), workspacePath: '/home/someone/secret' } })
    .on('GET', `${D}/quests/q/results`, { body: { questId: 'q', status: 'completed', leadSummary: null, tasks: [{
      taskId: 't', title: 't', agentKey: 'W-01', status: 'done', summary: null, error: null,
      attachments: [{ id: 1, taskId: 't', filename: 'a.txt', contentType: null, size: 1, createdAt: null, downloadUrl: '/x', stored_path: '/srv/hermes/a.txt' }],
    }] } }));
  await assert.rejects(api.department(DEPT_ID), (e: unknown) => e instanceof ApiError && e.code === 'invalid_response');
  await assert.rejects(api.results(DEPT_ID, 'q'), (e: unknown) => e instanceof ApiError && e.code === 'invalid_response');
});

test('network failure is backend_unreachable (status 0)', async () => {
  const b = use(fakeBackend());
  b.setDown(true);
  await assert.rejects(api.company(), (e: unknown) => e instanceof ApiError && e.unreachable && e.code === 'backend_unreachable');
});

test('backend JSON errors keep message, code and per-field issues', async () => {
  use(fakeBackend()
    .on('PATCH', D, { status: 400, body: { error: 'invalid_request', issues: [{ path: 'name', message: 'name is required' }] } })
    .on('POST', `${D}/provision`, { status: 409, body: { error: 'conflict', message: 'provisioning is already in progress for this department' } })
    .on('GET', `${D}/quests`, { status: 503, body: { error: 'hermes_unavailable', message: 'Hermes is unreachable' } }));
  await assert.rejects(api.updateDepartment(DEPT_ID, { name: '' }), (e: unknown) =>
    e instanceof ApiError && e.status === 400 && e.issues[0]!.path === 'name' && e.message === 'name: name is required');
  await assert.rejects(api.provision(DEPT_ID), (e: unknown) => e instanceof ApiError && e.code === 'conflict' && /already in progress/.test(e.message));
  await assert.rejects(api.quests(DEPT_ID), (e: unknown) => e instanceof ApiError && e.hermesUnavailable);
});

test('non-JSON error bodies are never shown to the user', async () => {
  use(fakeBackend().on('GET', '/api/company', { status: 502, raw: '<html>upstream /srv/secret/path token=abc</html>' }));
  await assert.rejects(api.company(), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 502);
    assert.doesNotMatch(e.message, /secret|token|html/);
    return true;
  });
});

test('chatStream relays progress, returns the reply, and turns an error event into an ApiError', async () => {
  const msg = (from: 'user' | 'agent', text: string) => ({ id: from, from, text, mood: from === 'agent' ? 'happy' : null, replies: [], proposal: null, at: iso });
  const sse = (frames: [string, unknown][]) => {
    const bytes = new TextEncoder().encode(frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(': keepalive\n\n'));
    // Split mid-frame, as the network does.
    return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 30)); c.enqueue(bytes.slice(30)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  let calls = 0;
  globalThis.fetch = (async () => (++calls === 1
    ? sse([['progress', { kind: 'thinking' }], ['progress', { kind: 'tool', name: 'terminal', preview: null }], ['reply', { user: msg('user', 'hi'), agent: msg('agent', 'Found it.') }]])
    : sse([['error', { status: 409, error: 'conflict', message: 'The agent is still answering your last message.' }]]))) as typeof fetch;
  const seen: unknown[] = [];
  const r = await api.chatStream(DEPT_ID, 'chief', { message: 'hi' }, (p) => seen.push(p));
  assert.equal(r.agent.text, 'Found it.');
  assert.deepEqual(seen, [{ kind: 'thinking' }, { kind: 'tool', name: 'terminal', preview: null }]);
  await assert.rejects(api.chatStream(DEPT_ID, 'chief', { message: 'hi' }, () => {}), (e: unknown) => e instanceof ApiError && e.status === 409 && /still answering/.test(e.message));
});
