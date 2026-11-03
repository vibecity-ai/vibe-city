import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from './api.ts';
import { DEPT_ID, deptView, detail, fakeBackend, iso } from './testing/fakeBackend.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const use = (b: ReturnType<typeof fakeBackend>) => { globalThis.fetch = b.fetch; return b; };
const D = `/api/departments/${DEPT_ID}`;

test('newly exposed routes hit the right paths and validate their responses', async () => {
  const b = use(fakeBackend()
    .on('GET', D, { body: deptView() })
    .on('GET', '/api/departments', ({ path }) => ({ body: { departments: path.includes('includeArchived=true') ? [deptView({ archivedAt: iso, floorPosition: null })] : [] } }))
    .on('DELETE', D, { body: { department: deptView({ archivedAt: iso, floorPosition: null }), hermesResourcesRetained: true } })
    .on('GET', `${D}/quests/t_root1/tasks`, { body: { questId: 't_root1', tasks: detail().tasks, violations: [], truncated: false } })
    .on('GET', `${D}/quests/t_root1/cancellation`, { body: detail().cancellation }));

  assert.equal((await api.department(DEPT_ID)).name, 'Research');
  assert.deepEqual(await api.departments(), []);
  const archived = await api.departments({ includeArchived: true });
  assert.equal(archived[0]!.archivedAt, iso);
  assert.ok(b.calls.some((c) => c.path === '/api/departments?includeArchived=true'));
  const out = await api.archiveDepartment(DEPT_ID);
  assert.equal(out.hermesResourcesRetained, true);
  assert.equal((await api.tasks(DEPT_ID, 't_root1')).tasks.length, 1);
  assert.equal((await api.cancellation(DEPT_ID, 't_root1')).state, 'none');
});

test('quest ids are URL-encoded', async () => {
  const b = use(fakeBackend());
  await api.quest(DEPT_ID, 'a/b').catch(() => undefined);
  assert.equal(b.calls[0]!.path, `${D}/quests/a%2Fb`);
});

test('a malformed success payload becomes an invalid_response ApiError (no partial data)', async () => {
  use(fakeBackend().on('GET', D, { body: { ...deptView(), state: 'exploded' } }));
  await assert.rejects(api.department(DEPT_ID), (e: unknown) => e instanceof ApiError && e.code === 'invalid_response' && e.status === 200);
});

test('strict schemas reject leaked server-only fields (absolute paths, stored_path)', async () => {
  use(fakeBackend()
    .on('GET', D, { body: { ...deptView(), workspacePath: '/home/someone/secret' } })
    .on('GET', `${D}/quests/q/results`, { body: { questId: 'q', status: 'completed', chiefSummary: null, tasks: [{
      taskId: 't', title: 't', role: 'worker', status: 'done', summary: null, error: null,
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
