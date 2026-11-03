import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/db.ts';
import { buildApp } from './app.ts';

export function memApp() {
  const db = openDb(':memory:');
  return { db, app: buildApp(db) };
}

export function tempDir(prefix = 'vc-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function createDept(app: ReturnType<typeof buildApp>, body: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: '/api/departments', payload: body });
  return { res, json: res.json() as Record<string, any> };
}

import { buildServices } from './app.ts';

/** Most suites exercise the chief + worker flow, so their helpers ask for one worker unless the test says otherwise. */
export function withWorker(inventory: Record<string, any> = {}) {
  return { ...inventory, limits: { maxConcurrentWorkers: 1, ...(inventory.limits ?? {}) } };
}
import { FakeHermes } from './testing/fakeHermes.ts';

/** App wired to an in-memory Hermes fake. */
export function provApp(opts: { fake?: FakeHermes } = {}) {
  const db = openDb(':memory:');
  const hermes = opts.fake ?? new FakeHermes();
  const { app, provisioning } = buildServices(db, hermes);
  const create = async (name: string, extra: Record<string, unknown> = {}) => {
    const { res, json } = await createDept(app, { name, ...extra, inventory: withWorker(extra.inventory as Record<string, any> | undefined) });
    if (res.statusCode !== 201) throw new Error(`create failed: ${res.body}`);
    return json as { id: string; hermesBoardSlug: string };
  };
  const provision = async (id: string) => (await app.inject({ method: 'POST', url: `/api/departments/${id}/provision` }));
  const status = async (id: string) => (await app.inject(`/api/departments/${id}/provisioning`)).json();
  const dept = async (id: string) => (await app.inject(`/api/departments/${id}`)).json();
  return { db, app, hermes, provisioning, create, provision, status, dept };
}

import { FakeKanban } from './testing/fakeKanban.ts';
import type { ServicesExtra } from './app.ts';

/** App + fake Hermes runtime + fake Kanban, with a helper that provisions a ready department and its board. */
export function questApp(extra: ServicesExtra = {}) {
  const db = openDb(':memory:');
  const hermes = new FakeHermes();
  const kanban = new FakeKanban();
  const services = buildServices(db, hermes, { kanban, ...extra });
  const { app } = services;
  const readyDept = async (name: string, inventory: Record<string, unknown> = {}) => {
    const { res, json } = await createDept(app, { name, inventory: withWorker(inventory) });
    if (res.statusCode !== 201) throw new Error(res.body);
    const prov = await app.inject({ method: 'POST', url: `/api/departments/${json.id}/provision` });
    if (prov.json().state !== 'ready') throw new Error(`not ready: ${prov.body}`);
    kanban.addBoard(json.hermesBoardSlug);
    return { id: json.id as string, board: json.hermesBoardSlug as string, chief: prov.json().chief.ref as string, worker: prov.json().worker.ref as string };
  };
  const create = async (deptId: string, body: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/api/departments/${deptId}/quests`, payload: { clientRequestId: crypto.randomUUID(), title: 'T', objective: 'Do the thing', ...body } });
  const get = async (url: string) => app.inject(url);
  const get_ = async (deptId: string, questId: string) => (await app.inject(`/api/departments/${deptId}/quests/${questId}`)).json();
  return { db, app, hermes, kanban, services, readyDept, create, get, get_ };
}
