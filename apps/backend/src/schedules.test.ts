import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRun, parseCron } from './domain/cron.ts';
import { stableUuid } from './domain/scheduleService.ts';
import { questApp } from './testUtils.ts';

const next = (cron: string, tz: string, after: string) => nextRun(parseCron(cron), tz, new Date(after))?.toISOString();

test('cron: weekday mornings, steps, names, ranges, time zones and DST', () => {
  assert.equal(next('0 9 * * 1-5', 'UTC', '2026-11-06T09:00:00Z'), '2026-11-09T09:00:00.000Z', 'Friday 9:00 -> Monday 9:00');
  assert.equal(next('*/15 * * * *', 'UTC', '2026-11-03T10:07:00Z'), '2026-11-03T10:15:00.000Z');
  assert.equal(next('30 8 * * mon', 'UTC', '2026-11-03T00:00:00Z'), '2026-11-09T08:30:00.000Z');
  assert.equal(next('0 9 * * *', 'Europe/Bucharest', '2026-11-03T12:00:00Z'), '2026-11-04T07:00:00.000Z', '09:00 in Bucharest is 07:00 UTC in winter');
  assert.equal(next('0 9 * * *', 'Europe/Bucharest', '2026-07-03T12:00:00Z'), '2026-07-04T06:00:00.000Z', 'and 06:00 UTC in summer');
  assert.equal(next('0 0 1 jan *', 'UTC', '2026-11-03T00:00:00Z'), '2027-01-01T00:00:00.000Z');
  assert.equal(next('0 12 15 * 5', 'UTC', '2026-11-03T00:00:00Z'), '2026-11-06T12:00:00.000Z', 'day-of-month OR day-of-week (Friday 6th comes first)');
  assert.throws(() => parseCron('0 9 * *'), /5 fields/);
  assert.throws(() => parseCron('61 * * * *'), /out of range/);
  assert.equal(next('0 0 30 2 *', 'UTC', '2026-01-01T00:00:00Z'), undefined, 'February 30th never comes');
  assert.match(stableUuid('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(stableUuid('x'), stableUuid('x'));
});

test('schedules: create, validate, fire once per slot (restart-safe), origin schedule, pause, run now, delete', async () => {
  const { app, db, readyDept, services } = questApp();
  const forceDue = (id: string, at: string) => db.prepare('UPDATE schedule SET next_run_at = ? WHERE id = ?').run(at, id);
  const d = await readyDept('Research');
  const bad = await app.inject({ method: 'POST', url: `/api/departments/${d.id}/schedules`, payload: { name: 'x', cron: '0 9 * *', title: 't', objective: 'o' } });
  assert.equal(bad.statusCode, 400);
  const badTz = await app.inject({ method: 'POST', url: `/api/departments/${d.id}/schedules`, payload: { name: 'x', cron: '0 9 * * *', timezone: 'Mars/Olympus', title: 't', objective: 'o' } });
  assert.match(badTz.json().message, /time zone/);
  const res = await app.inject({ method: 'POST', url: `/api/departments/${d.id}/schedules`, payload: { name: 'Digest', cron: '* * * * *', title: 'Morning digest', objective: 'Five bullets.' } });
  assert.equal(res.statusCode, 201);
  const sch = res.json();
  assert.ok(sch.nextRunAt);
  // Make it due, then tick twice: exactly one quest.
  const past = new Date(Date.now() - 60_000).toISOString();
  forceDue(sch.id, past);
  assert.deepEqual(await services.schedules.tick(), [sch.id]);
  assert.deepEqual(await services.schedules.tick(), []);
  forceDue(sch.id, past); // same slot again (e.g. after a restart): claimed already, no second quest
  assert.deepEqual(await services.schedules.tick(), []);
  const after = (await app.inject(`/api/schedules?departmentId=${d.id}`)).json().schedules[0];
  assert.ok(after.lastQuestId);
  assert.ok(Date.parse(after.nextRunAt) > Date.now() - 1000);
  const quests = (await app.inject(`/api/departments/${d.id}/quests`)).json().quests;
  assert.equal(quests.filter((q: any) => q.title === 'Morning digest').length, 1);
  const origin = (await app.inject('/api/quest-origins')).json().origins.find((o: any) => o.questId === after.lastQuestId);
  assert.equal(origin.origin, 'schedule');
  assert.equal(origin.requestId, sch.id);
  // pause: no next run; run now still works
  const paused = (await app.inject({ method: 'PATCH', url: `/api/schedules/${sch.id}`, payload: { enabled: false } })).json();
  assert.equal(paused.nextRunAt, null);
  const ran = (await app.inject({ method: 'POST', url: `/api/schedules/${sch.id}/run` })).json();
  assert.notEqual(ran.lastQuestId, after.lastQuestId);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/schedules/${sch.id}` })).statusCode, 204);
  assert.equal((await app.inject(`/api/schedules?departmentId=${d.id}`)).json().schedules.length, 0);
});

