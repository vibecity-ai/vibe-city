/* Timing primitives for the live connector. Pure (timers are injected) and tested in sched.test.ts. */

/**
 * Last-request-wins guard. `begin(key)` returns a ticket; `current(key, ticket)` is false once a newer request for
 * the same key started, so a slow older response can never overwrite newer state.
 */
export function createGate() {
  const seq = new Map<string, number>();
  let n = 0;
  return {
    begin(key: string): number { const t = ++n; seq.set(key, t); return t; },
    current(key: string, ticket: number): boolean { return seq.get(key) === ticket; },
    forget(key: string) { seq.delete(key); },
  };
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (h: unknown) => void;
  now: () => number;
}
export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Coalesces bursts of hints per key into one call: runs `quietMs` after the last hint, but never later than `maxWaitMs`
 * after the first hint of a burst (so a continuous stream of events still refreshes regularly).
 */
export function createCoalescer(run: (key: string) => void, opts: { quietMs: number; maxWaitMs: number }, t: Timers = realTimers) {
  const pending = new Map<string, { handle: unknown; first: number }>();
  const fire = (key: string) => { pending.delete(key); run(key); };
  return {
    hint(key: string) {
      const p = pending.get(key);
      const first = p?.first ?? t.now();
      if (p) t.clear(p.handle);
      const wait = Math.max(0, Math.min(opts.quietMs, first + opts.maxWaitMs - t.now()));
      pending.set(key, { first, handle: t.set(() => fire(key), wait) });
    },
    cancel(key: string) { const p = pending.get(key); if (p) { t.clear(p.handle); pending.delete(key); } },
    cancelAll() { for (const k of [...pending.keys()]) this.cancel(k); },
    pending: (key: string) => pending.has(key),
  };
}

/** Bounded backoff delays (ms) whose sum stays within `budgetMs`: 1s, 2s, 4s, ... capped at `capMs`. */
export function backoffDelays(budgetMs: number, startMs = 1000, capMs = 10_000): number[] {
  const out: number[] = [];
  let total = 0, d = startMs;
  while (total + d <= budgetMs) { out.push(d); total += d; d = Math.min(d * 2, capMs); }
  return out;
}
