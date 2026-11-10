import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floorObjects, type Box6 } from './controls.ts';

/** The room's depth in world units (interior.ts: V): the back wall is at v = V. */
const V = 140;

const overlap = (a: Box6, b: Box6) => a[0] < b[0] + b[3] && b[0] < a[0] + a[3] && a[1] < b[1] + b[4] && b[1] < a[1] + a[4] && a[2] < b[2] + b[5] && b[2] < a[2] + a[5];
/** Where people step out of the elevator and walk into the room. */
const ELEVATOR_WALKWAY: Box6 = [0, 16, 0, 44, 38, 40];

test('floor controls never stand on each other or in the elevator walkway', () => {
  const objs = floorObjects('Market wall');
  for (const a of objs) {
    assert.ok(!overlap(a.b, ELEVATOR_WALKWAY), `${a.id} blocks the elevator`);
    for (const b of objs) if (a !== b) assert.ok(!overlap(a.b, b.b), `${a.id} overlaps ${b.id}`);
  }
});

test('tools, skills and env stand together in one equipment bay', () => {
  const by = Object.fromEntries(floorObjects(null).map((o) => [o.id, o.b]));
  const left = Math.min(by.rack![0], by.library![0], by.keys![0]), right = Math.max(...['rack', 'library', 'keys'].map((k) => by[k]![0] + by[k]![3]));
  assert.ok(right - left <= 60, 'the bay is one stretch of wall');
  for (const k of ['rack', 'library', 'keys']) assert.equal(by[k]![1] + by[k]![4], V, `${k} stands against the back wall`);
});
