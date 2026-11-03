import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelays, createCoalescer, createGate, type Timers } from './sched.ts';

function fakeTimers() {
  let now = 0;
  let q: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  const t: Timers = {
    set: (fn, ms) => { q.push({ at: now + ms, fn, id: ++id }); return id; },
    clear: (h) => { q = q.filter((x) => x.id !== h); },
    now: () => now,
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = q.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      q = q.filter((x) => x !== next);
      now = next.at; next.fn();
    }
    now = end;
  };
  return { t, advance };
}

test('gate: only the latest request for a key may apply', () => {
  const g = createGate();
  const a = g.begin('k');
  const b = g.begin('k');
  assert.equal(g.current('k', a), false);
  assert.equal(g.current('k', b), true);
  assert.equal(g.current('other', b), false);
  g.forget('k');
  assert.equal(g.current('k', b), false);
});

test('coalescer: a burst of hints becomes one run after the quiet period', () => {
  const { t, advance } = fakeTimers();
  const runs: string[] = [];
  const c = createCoalescer((k) => runs.push(k), { quietMs: 400, maxWaitMs: 2000 }, t);
  for (let i = 0; i < 50; i++) { c.hint('d1'); advance(10); }
  assert.deepEqual(runs, []);
  advance(400);
  assert.deepEqual(runs, ['d1']);
});

test('coalescer: a continuous stream still runs at least every maxWait', () => {
  const { t, advance } = fakeTimers();
  let runs = 0;
  const c = createCoalescer(() => runs++, { quietMs: 400, maxWaitMs: 2000 }, t);
  for (let i = 0; i < 100; i++) { c.hint('d1'); advance(100); } // 10 s of events every 100 ms
  assert.ok(runs >= 4 && runs <= 6, `ran ${runs} times`);
});

test('coalescer: keys are independent and can be cancelled', () => {
  const { t, advance } = fakeTimers();
  const runs: string[] = [];
  const c = createCoalescer((k) => runs.push(k), { quietMs: 400, maxWaitMs: 2000 }, t);
  c.hint('a'); c.hint('b'); c.cancel('a');
  advance(1000);
  assert.deepEqual(runs, ['b']);
  c.hint('a'); c.cancelAll(); advance(1000);
  assert.deepEqual(runs, ['b']);
});

test('backoff delays grow, are capped, and fit the budget', () => {
  assert.deepEqual(backoffDelays(120_000).slice(0, 5), [1000, 2000, 4000, 8000, 10_000]);
  assert.ok(backoffDelays(120_000).reduce((a, b) => a + b, 0) <= 120_000);
  assert.deepEqual(backoffDelays(500), []);
});
