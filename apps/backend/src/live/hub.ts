import type { LiveMessage } from '@vibe-city/shared';
import { BoardStream, type BoardStreamDeps } from './boardStream.ts';

type Send = (m: LiveMessage) => void;

/** Fans one Hermes stream per department out to any number of browser clients (ref-counted). */
export class LiveHub {
  private streams = new Map<string, { stream: BoardStream; clients: Set<Send>; stopTimer?: ReturnType<typeof setTimeout> }>();
  private deps: Omit<BoardStreamDeps, 'emit'>;
  private graceMs: number;

  constructor(deps: Omit<BoardStreamDeps, 'emit'>, opts: { graceMs?: number } = {}) {
    this.deps = deps;
    this.graceMs = opts.graceMs ?? 30_000;
  }

  /** Subscribes a client; returns an unsubscribe function. The client immediately receives the current state + resync. */
  subscribe(departmentId: string, board: string, send: Send): () => void {
    let entry = this.streams.get(departmentId);
    if (!entry) {
      const clients = new Set<Send>();
      const stream = new BoardStream(departmentId, board, { ...this.deps, emit: (m) => clients.forEach((c) => c(m)) });
      entry = { stream, clients };
      this.streams.set(departmentId, entry);
      stream.start();
    }
    if (entry.stopTimer) { clearTimeout(entry.stopTimer); entry.stopTimer = undefined; }
    entry.clients.add(send);
    send({ type: 'connection', departmentId, state: entry.stream.state });
    send({ type: 'resync', departmentId });
    const e = entry;
    return () => {
      e.clients.delete(send);
      if (e.clients.size === 0) {
        e.stopTimer = setTimeout(() => {
          if (e.clients.size === 0) { e.stream.stop(); this.streams.delete(departmentId); }
        }, this.graceMs);
        e.stopTimer.unref?.();
      }
    };
  }

  stopAll() {
    for (const e of this.streams.values()) { if (e.stopTimer) clearTimeout(e.stopTimer); e.stream.stop(); }
    this.streams.clear();
  }

  activeStreams() { return this.streams.size; }
}
