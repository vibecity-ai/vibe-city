import type { LiveMessage } from '@vibe-city/shared';
import type { HermesHealth } from '../hermes/ports.ts';
import type { CursorStore } from './cursorStore.ts';

export type StreamState = Extract<LiveMessage, { type: 'connection' }>['state'];

export interface BoardStreamDeps {
  /** e.g. ws://127.0.0.1:9119 */
  wsBaseUrl: string;
  /** Server-side only: sent to Hermes in the upgrade URL, never to a browser. */
  sessionToken: string;
  health: () => Promise<HermesHealth>;
  cursors: CursorStore;
  emit: (msg: LiveMessage) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  healthIntervalMs?: number;
  /** Injectable for tests; defaults to the global WebSocket. */
  WebSocketCtor?: typeof WebSocket;
}

/**
 * One authenticated server-side subscription to a department board's Hermes event stream.
 * - resumes from the persisted cursor (`since`), so a restart or reconnect misses nothing;
 * - deduplicates by event id (replays after a reconnect are harmless);
 * - tells clients to resync snapshots after every (re)connect, because events are a hint, not state;
 * - distinguishes "dashboard offline" (Hermes web server unreachable) from "gateway unavailable"
 *   (connected, but no gateway means workers cannot run).
 */
export class BoardStream {
  readonly departmentId: string;
  readonly board: string;
  state: StreamState = 'reconnecting';
  private d: Required<Omit<BoardStreamDeps, 'WebSocketCtor'>> & { WebSocketCtor: typeof WebSocket };
  private ws: WebSocket | null = null;
  private stopped = true;
  private last: number | null;
  private backoff: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(departmentId: string, board: string, deps: BoardStreamDeps) {
    this.departmentId = departmentId;
    this.board = board;
    this.d = {
      minBackoffMs: 1000, maxBackoffMs: 30_000, healthIntervalMs: 10_000, WebSocketCtor: globalThis.WebSocket, ...deps,
    };
    this.backoff = this.d.minBackoffMs;
    this.last = deps.cursors.get(board);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.retryTimer = this.healthTimer = null;
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
  }

  get cursor() { return this.last; }

  private setState(s: StreamState) {
    if (this.state === s) return;
    this.state = s;
    this.d.emit({ type: 'connection', departmentId: this.departmentId, state: s });
  }

  private url(): string {
    const u = new URL('/api/plugins/kanban/events', this.d.wsBaseUrl);
    u.searchParams.set('board', this.board);
    u.searchParams.set('token', this.d.sessionToken);
    if (this.last !== null) u.searchParams.set('since', String(this.last));
    return u.toString();
  }

  private connect() {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new this.d.WebSocketCtor(this.url());
    } catch {
      this.dropped();
      return;
    }
    this.ws = ws;
    let gone = false;
    const lost = () => { if (!gone) { gone = true; if (this.ws === ws) this.dropped(); } };
    ws.onopen = () => {
      this.backoff = this.d.minBackoffMs;
      this.setState('connected');
      this.d.emit({ type: 'resync', departmentId: this.departmentId });
      void this.checkGateway();
      if (this.healthTimer) clearInterval(this.healthTimer);
      this.healthTimer = setInterval(() => void this.checkGateway(), this.d.healthIntervalMs);
      this.healthTimer.unref?.();
    };
    ws.onmessage = (m) => this.onFrame(String(m.data));
    ws.onerror = lost;
    ws.onclose = lost;
  }

  private onFrame(data: string) {
    let j: { events?: { id: number; task_id: string; kind: string; created_at: number }[]; cursor?: number };
    try { j = JSON.parse(data); } catch { return; }
    for (const e of j.events ?? []) {
      if (typeof e.id !== 'number' || (this.last !== null && e.id <= this.last)) continue; // dedupe
      this.last = e.id;
      this.d.emit({ type: 'hermes.event', departmentId: this.departmentId, eventId: e.id, taskId: e.task_id, kind: e.kind, at: new Date(e.created_at * 1000).toISOString() });
    }
    if (typeof j.cursor === 'number' && (this.last === null || j.cursor > this.last)) this.last = j.cursor;
    if (this.last !== null) this.d.cursors.set(this.board, this.last);
  }

  private async checkGateway() {
    if (this.stopped || !this.ws) return;
    try {
      const h = await this.d.health();
      if (this.stopped || !this.ws) return;
      if (h.dashboard === 'down') this.setState('dashboard_offline');
      else this.setState(h.gateway === 'stopped' ? 'gateway_unavailable' : 'connected');
    } catch { /* keep the current state */ }
  }

  /** Socket lost: classify why, then retry with backoff. */
  private dropped() {
    if (this.stopped) return;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.ws = null;
    this.setState('reconnecting');
    void this.d.health().then((h) => {
      if (!this.stopped && h.dashboard === 'down') this.setState('dashboard_offline');
    }).catch(() => { if (!this.stopped) this.setState('dashboard_offline'); });
    const delay = Math.min(this.backoff, this.d.maxBackoffMs) * (0.75 + Math.random() * 0.5);
    this.backoff = Math.min(this.backoff * 2, this.d.maxBackoffMs);
    this.retryTimer = setTimeout(() => this.connect(), delay);
    this.retryTimer.unref?.();
  }
}
