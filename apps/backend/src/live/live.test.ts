import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket as WsClient, WebSocketServer } from 'ws';
import type { LiveMessage } from '@vibe-city/shared';
import type { HermesHealth } from '../hermes/ports.ts';
import { BoardStream } from './boardStream.ts';
import { LiveHub } from './hub.ts';
import { MemoryCursorStore } from './cursorStore.ts';
import { questApp } from '../testUtils.ts';

const TOKEN = 'secret-token-123';
const up: HermesHealth = { dashboard: 'up', auth: 'ok', gateway: 'running', version: 't', detail: null };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3000, what = 'condition') {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A stand-in for Hermes' /api/plugins/kanban/events WebSocket. */
class FakeHermesWs {
  server!: WebSocketServer;
  urls: URL[] = [];
  sockets = new Set<import('ws').WebSocket>();
  port = 0;
  async start(port = 0) {
    this.server = new WebSocketServer({ port, host: '127.0.0.1' });
    await new Promise<void>((r) => this.server.once('listening', () => r()));
    this.port = (this.server.address() as AddressInfo).port;
    this.server.on('connection', (s, req) => {
      this.urls.push(new URL(req.url!, 'http://x'));
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
  }
  events(...ids: number[]) {
    const events = ids.map((id) => ({ id, task_id: `t_${id.toString(16).padStart(4, '0')}`, run_id: null, kind: 'completed', payload: { secret: 'payload' }, created_at: 1_700_000_000 + id }));
    const frame = JSON.stringify({ events, cursor: Math.max(...ids) });
    for (const s of this.sockets) s.send(frame);
  }
  drop() { for (const s of this.sockets) s.terminate(); }
  async stop() { this.drop(); await new Promise<void>((r) => this.server.close(() => r())); }
  get base() { return `ws://127.0.0.1:${this.port}`; }
}

const mkStream = (hermes: FakeHermesWs, msgs: LiveMessage[], o: { health?: () => Promise<HermesHealth>; cursors?: MemoryCursorStore } = {}) =>
  new BoardStream('dept-1', 'vc-board', {
    wsBaseUrl: hermes.base, sessionToken: TOKEN, health: o.health ?? (async () => up), cursors: o.cursors ?? new MemoryCursorStore(),
    emit: (m) => msgs.push(m), minBackoffMs: 20, maxBackoffMs: 60, healthIntervalMs: 40,
  });
const eventIds = (msgs: LiveMessage[]) => msgs.filter((m): m is Extract<LiveMessage, { type: 'hermes.event' }> => m.type === 'hermes.event').map((m) => m.eventId);

test('stream authenticates server-side, announces connect + resync, relays events without payloads, and dedupes', async () => {
  const h = new FakeHermesWs();
  await h.start();
  const msgs: LiveMessage[] = [];
  const s = mkStream(h, msgs);
  s.start();
  await waitFor(() => msgs.some((m) => m.type === 'resync'), 3000, 'resync');
  assert.equal(h.urls[0]!.searchParams.get('token'), TOKEN, 'token is sent to Hermes');
  assert.equal(h.urls[0]!.searchParams.get('board'), 'vc-board');
  assert.equal(h.urls[0]!.searchParams.get('since'), null, 'no cursor yet: start at the tail');
  assert.ok(msgs.some((m) => m.type === 'connection' && m.state === 'connected'));
  h.events(1, 2);
  h.events(2, 3); // 2 is a duplicate
  await waitFor(() => eventIds(msgs).length >= 3, 3000, 'events');
  assert.deepEqual(eventIds(msgs), [1, 2, 3]);
  const wire = JSON.stringify(msgs);
  assert.ok(!wire.includes(TOKEN), 'the Hermes token never appears in relayed messages');
  assert.ok(!wire.includes('payload'), 'raw Hermes payloads are not relayed');
  s.stop();
  await h.stop();
});

test('after a dropped connection the stream resumes from the cursor, ignores replays, and asks clients to resync', async () => {
  const h = new FakeHermesWs();
  await h.start();
  const msgs: LiveMessage[] = [];
  const s = mkStream(h, msgs);
  s.start();
  await waitFor(() => h.sockets.size === 1);
  h.events(1, 2, 3);
  await waitFor(() => eventIds(msgs).length === 3);
  const resyncsBefore = msgs.filter((m) => m.type === 'resync').length;
  h.drop();
  await waitFor(() => h.urls.length === 2 && h.sockets.size === 1, 3000, 'reconnect');
  assert.equal(h.urls[1]!.searchParams.get('since'), '3', 'resumes from the last seen event id');
  await waitFor(() => msgs.filter((m) => m.type === 'resync').length === resyncsBefore + 1, 3000, 'second resync');
  h.events(2, 3, 4); // server replays old ones
  await waitFor(() => eventIds(msgs).includes(4));
  assert.deepEqual(eventIds(msgs), [1, 2, 3, 4], 'no duplicates after the replay');
  s.stop();
  await h.stop();
});

test('dashboard offline is reported separately from a reconnect, and recovery resumes the stream', async () => {
  const h = new FakeHermesWs();
  await h.start();
  const port = h.port;
  let dashboardUp = true;
  const health = async (): Promise<HermesHealth> => (dashboardUp ? up : { ...up, dashboard: 'down', gateway: 'unknown' });
  const msgs: LiveMessage[] = [];
  const s = mkStream(h, msgs, { health });
  s.start();
  await waitFor(() => s.state === 'connected');
  h.events(5);
  await waitFor(() => eventIds(msgs).includes(5));
  dashboardUp = false;
  await h.stop();
  await waitFor(() => s.state === 'dashboard_offline', 3000, 'dashboard_offline');
  assert.ok(msgs.some((m) => m.type === 'connection' && m.state === 'reconnecting'));
  dashboardUp = true;
  const h2 = new FakeHermesWs();
  await h2.start(port);
  await waitFor(() => s.state === 'connected', 5000, 'reconnected');
  assert.equal(h2.urls[0]!.searchParams.get('since'), '5');
  s.stop();
  await h2.stop();
});

test('gateway unavailable (dashboard up, workers cannot run) is distinguished from dashboard offline', async () => {
  const h = new FakeHermesWs();
  await h.start();
  let gateway: HermesHealth['gateway'] = 'running';
  const msgs: LiveMessage[] = [];
  const s = mkStream(h, msgs, { health: async () => ({ ...up, gateway }) });
  s.start();
  await waitFor(() => s.state === 'connected');
  gateway = 'stopped';
  await waitFor(() => s.state === 'gateway_unavailable', 3000, 'gateway_unavailable');
  assert.ok(h.sockets.size === 1, 'the event stream itself is still connected');
  gateway = 'running';
  await waitFor(() => s.state === 'connected');
  s.stop();
  await h.stop();
});

test('the cursor is persisted: a new stream (process restart) resumes without re-reading history', async () => {
  const h = new FakeHermesWs();
  await h.start();
  const cursors = new MemoryCursorStore();
  const msgs: LiveMessage[] = [];
  const s1 = mkStream(h, msgs, { cursors });
  s1.start();
  await waitFor(() => h.sockets.size === 1);
  h.events(7, 8);
  await waitFor(() => eventIds(msgs).includes(8));
  s1.stop();
  assert.equal(cursors.get('vc-board'), 8);
  const s2 = mkStream(h, [], { cursors });
  s2.start();
  await waitFor(() => h.urls.length === 2);
  assert.equal(h.urls[1]!.searchParams.get('since'), '8');
  s2.stop();
  await h.stop();
});

test('hub shares one Hermes stream between clients and stops it after the last one leaves', async () => {
  const h = new FakeHermesWs();
  await h.start();
  const hub = new LiveHub({ wsBaseUrl: h.base, sessionToken: TOKEN, health: async () => up, cursors: new MemoryCursorStore(), minBackoffMs: 20, maxBackoffMs: 60, healthIntervalMs: 40 }, { graceMs: 50 });
  const a: LiveMessage[] = [];
  const b: LiveMessage[] = [];
  const offA = hub.subscribe('dept-1', 'vc-board', (m) => a.push(m));
  const offB = hub.subscribe('dept-1', 'vc-board', (m) => b.push(m));
  assert.equal(hub.activeStreams(), 1);
  await waitFor(() => h.sockets.size === 1);
  h.events(1);
  await waitFor(() => eventIds(a).length === 1 && eventIds(b).length === 1);
  assert.equal(h.urls.length, 1, 'one upstream connection for two clients');
  offA();
  assert.equal(hub.activeStreams(), 1);
  offB();
  await waitFor(() => hub.activeStreams() === 0, 2000, 'stream stopped after grace');
  await waitFor(() => h.sockets.size === 0);
  await h.stop();
});

test('/api/live relays to browsers, rejects bad origins/departments, and never exposes the Hermes token', async () => {
  const h = new FakeHermesWs();
  await h.start();
  const t = questApp({
    live: { wsBaseUrl: h.base, sessionToken: TOKEN, minBackoffMs: 20, maxBackoffMs: 60, healthIntervalMs: 40, graceMs: 50 },
    allowedOrigins: ['http://localhost:5173'],
  });
  const d = await t.readyDept('Eng');
  const raw = await (await import('./../testUtils.ts')).createDept(t.app, { name: 'Unprovisioned' });
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (t.app.server.address() as AddressInfo).port;
  const open = (query: string, origin?: string) => new Promise<{ ws: WsClient; msgs: any[]; closed: Promise<number> }>((resolve) => {
    const ws = new WsClient(`ws://127.0.0.1:${port}/api/live?${query}`, origin ? { headers: { origin } } : {});
    const msgs: any[] = [];
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
    ws.on('open', () => resolve({ ws, msgs, closed }));
    ws.on('error', () => resolve({ ws, msgs, closed }));
  });

  const opened: WsClient[] = [];
  try {
  const good = await open(`departmentId=${d.id}`, 'http://localhost:5173');
  opened.push(good.ws);
  await waitFor(() => good.msgs.some((m) => m.type === 'resync'), 3000, 'resync to browser');
  await waitFor(() => h.sockets.size === 1, 3000, 'upstream Hermes connection');
  await waitFor(() => good.msgs.some((m) => m.type === 'connection' && m.state === 'connected'), 3000, 'connected state');
  h.events(10);
  await waitFor(() => good.msgs.some((m) => m.type === 'hermes.event' && m.eventId === 10), 3000, 'relayed event');
  const wire = JSON.stringify(good.msgs);
  assert.ok(!wire.includes(TOKEN) && !wire.includes('token'), 'no Hermes credential reaches the browser');
  assert.equal(h.urls.length, 1);
  assert.equal(h.urls[0]!.searchParams.get('board'), d.board, 'subscribed to the department board only');

  assert.equal(await (await open(`departmentId=${d.id}`, 'http://evil.example')).closed, 1008, 'cross-site origin refused');
  assert.equal(await (await open('departmentId=not-a-uuid')).closed, 1008);
  assert.equal(await (await open('departmentId=00000000-0000-4000-8000-000000000000')).closed, 1008);
  assert.equal(await (await open(`departmentId=${raw.json.id}`)).closed, 1008, 'unprovisioned department has no board to follow');
  assert.equal(h.urls.length, 1, 'refused clients caused no Hermes connection');
  } finally {
    for (const w of opened) w.terminate();
    await t.app.close();
    await h.stop();
  }
});

