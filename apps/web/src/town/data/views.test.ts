import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CancellationStatus, CapabilityEntry } from '@vibe-city/shared';
import { deptView, detail, provStatus } from '../../testing/fakeBackend.ts';
import {
  LIMIT_COPY, WORKSPACE_ADVISORY, archiveConsequences, archivedNotice, assigneeWarning, cancellationView, capValue, fieldErrors,
  inventorySavedNotice, isGuaranteed, newerCancellation, originText, profileRows, provisioningActions, settingsFormFrom, settingsPatch,
  taskStatusView, workspaceErrorField, workspaceSummary,
} from './views.ts';

test('workspace copy is advisory and never claims isolation', () => {
  assert.match(WORKSPACE_ADVISORY, /not a sandbox/);
  assert.match(WORKSPACE_ADVISORY, /never sent back to the browser/);
  assert.doesNotMatch(WORKSPACE_ADVISORY, /\bisolated\b|\bsandboxed\b/i);
  const w = workspaceSummary({ configured: true, label: 'research', isolation: 'unverified' });
  assert.equal(w.label, 'research');
  assert.match(w.isolation, /unverified/i);
  assert.equal(workspaceSummary({ configured: false, label: null, isolation: 'unverified' }).label, 'Not configured');
});

test('settings patch sends only changed fields; workspace can be set or cleared', () => {
  const d = deptView({ workspace: { configured: true, label: 'old', isolation: 'unverified' } });
  const f = settingsFormFrom(d);
  assert.equal(settingsPatch(d, f), null);
  assert.deepEqual(settingsPatch(d, { ...f, name: '  Research 2 ' }), { name: 'Research 2' });
  assert.deepEqual(settingsPatch(d, { ...f, purpose: 'New' }), { purpose: 'New' });
  assert.deepEqual(settingsPatch(d, { ...f, workspaceMode: 'set', workspacePath: ' /srv/x ' }), { workspace: '/srv/x' });
  assert.deepEqual(settingsPatch(d, { ...f, workspaceMode: 'clear' }), { workspace: null });
  // clearing an unset workspace is not a change
  assert.equal(settingsPatch(deptView(), { ...settingsFormFrom(deptView()), workspaceMode: 'clear' }), null);
});

test('backend validation errors land on the right field', () => {
  assert.deepEqual(fieldErrors([{ path: 'name', message: 'name is required' }, { path: 'x', message: 'odd' }], ['name', 'purpose', 'workspace']),
    { name: 'name is required', form: 'odd' });
  assert.equal(workspaceErrorField('workspace directory does not exist'), 'workspace');
  assert.equal(workspaceErrorField('a department with this name already exists'), 'name');
  assert.equal(workspaceErrorField('department is archived'), 'form');
});

test('archive copy: leaves the tower, keeps the row and Hermes resources, is not deletion', () => {
  const lines = archiveConsequences(deptView()).join('\n');
  assert.match(lines, /disappears from the active tower/);
  assert.match(lines, /keeps the department record/);
  assert.match(lines, /Nothing is deleted in Hermes: board vc-/);
  assert.match(lines, /profile vc-111111111111-chief/);
  assert.match(lines, /not Hermes resource deletion/);
  assert.match(lines, /no restore/);
  assert.match(archiveConsequences(deptView({ hermesBoardRef: null, chiefProfileRef: null, workerProfileRef: null })).join(' '), /no Hermes resources/);
  assert.match(archivedNotice('R', true), /board and profiles were kept/);
  assert.doesNotMatch(archivedNotice('R', false), /kept/);
});

test('inventory limit copy is truthful', () => {
  assert.match(LIMIT_COPY.maxDelegationDepth, /cannot enforce/);
  assert.match(LIMIT_COPY.maxConcurrentWorkers, /host-limited/i);
  assert.match(LIMIT_COPY.maxTaskRuntimeSeconds, /does not propagate/);
  assert.match(inventorySavedNotice('ready', 'unconfigured').text, /provisioning again/);
  assert.equal(inventorySavedNotice('ready', 'unconfigured').tone, 'warn');
  assert.equal(inventorySavedNotice('unconfigured', 'unconfigured').tone, 'good');
});

test('only enforced capabilities with the guarantee flag are styled as guaranteed', () => {
  const e = (status: CapabilityEntry['status'], guarantee: boolean) => ({ status, guarantee });
  assert.equal(isGuaranteed(e('enforced', true)), true);
  assert.equal(isGuaranteed(e('enforced', false)), false);
  assert.equal(isGuaranteed(e('configured', true)), false);
  assert.equal(isGuaranteed(e('unverified', false)), false);
  assert.equal(isGuaranteed(e('unsupported', false)), false);
  assert.equal(capValue(['a', 'b']), 'a, b');
  assert.equal(capValue([]), 'none');
  assert.equal(capValue(null), '—');
  assert.equal(capValue({ sharedContextRefs: ['x'] }), 'sharedContextRefs: x');
});

test('provisioning actions: retry only where the backend accepts it and it can help', () => {
  assert.deepEqual(provisioningActions(provStatus({ state: 'unconfigured' })).provision.show, true);
  assert.equal(provisioningActions(provStatus({ state: 'unconfigured' })).retry, false);
  const err = (retryable: boolean) => provStatus({ state: 'error', error: { code: 'x', step: 'board', message: 'm', retryable, at: '' } });
  assert.equal(provisioningActions(err(true)).retry, true);
  assert.equal(provisioningActions(err(false)).retry, false);
  assert.equal(provisioningActions(err(false)).provision.show, true);
  assert.equal(provisioningActions(provStatus({ state: 'disconnected' })).retry, true);
  assert.equal(provisioningActions(provStatus({ state: 'provisioning' })).provision.show, false);
  assert.equal(provisioningActions(provStatus({ state: 'ready' })).retry, false);
});

test('profile inspector: origin and associated-profile consent are explicit', () => {
  const base = { ref: 'p', verified: false, verifiedAt: null };
  assert.match(originText({ ...base, origin: 'created', modificationConfirmed: null }), /Managed/);
  assert.match(originText({ ...base, origin: 'associated', modificationConfirmed: true }), /you allowed/);
  assert.match(originText({ ...base, origin: 'associated', modificationConfirmed: false }), /NOT confirmed/);
  const rows = profileRows({ departmentId: 'd', reachable: false, chief: { ref: 'c', exists: null, model: null, description: null }, worker: { ref: 'w', exists: null, model: null, description: null } }, provStatus(), (s) => s ?? '—');
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.exists, /Unknown \(Hermes unreachable\)/);
  assert.match(rows[0]!.verified, /^Verified/);
  const live = profileRows({ departmentId: 'd', reachable: true, chief: { ref: 'c', exists: false, model: null, description: null }, worker: { ref: 'w', exists: true, model: 'm', description: 'd' } }, null, (s) => s ?? '—');
  assert.equal(live[0]!.exists, 'Missing in Hermes');
  assert.equal(live[1]!.model, 'm');
});

test('task status: pending and review are never "running"; failure differs from blocked', () => {
  assert.equal(taskStatusView({ status: 'todo', failed: false }).k, 'todo');
  assert.match(taskStatusView({ status: 'ready', failed: false }).label, /Pending/);
  assert.equal(taskStatusView({ status: 'review', failed: false }).label, 'In review');
  assert.equal(taskStatusView({ status: 'blocked', failed: false }).k, 'blocked');
  assert.equal(taskStatusView({ status: 'blocked', failed: true }).k, 'failed');
  assert.equal(taskStatusView({ status: 'running', failed: false }).k, 'running');
  assert.equal(taskStatusView({ status: 'archived', failed: false }).label, 'Archived');
});

test('unauthorized assignees are flagged', () => {
  assert.equal(assigneeWarning({ role: 'worker', assignee: 'vc-w' }), null);
  assert.match(assigneeWarning({ role: 'other', assignee: 'intruder' })!, /“intruder”.*not this department/);
});

test('cancellation: requested is never shown as cancelled; confirmed never regresses', () => {
  const tasks = detail().tasks;
  const requested: CancellationStatus = { state: 'requested', requestedAt: 'a', confirmedAt: null, remaining: [{ taskId: 't_root1', status: 'running' }], archivedTaskIds: ['t_x'], alreadyFinishedTaskIds: ['t_done'] };
  const confirmed: CancellationStatus = { ...requested, state: 'confirmed', confirmedAt: 'b', remaining: [] };
  assert.equal(cancellationView({ ...requested, state: 'none' }, tasks), null);
  const v = cancellationView(requested, tasks)!;
  assert.match(v.headline, /not confirmed yet: 1 task still stopping/);
  assert.doesNotMatch(v.headline, /^Cancelled/);
  assert.equal(v.remaining[0]!.title, 'Quest one');
  assert.equal(v.archived[0]!.title, 't_x');
  assert.equal(v.finished[0]!.id, 't_done');
  assert.match(cancellationView(confirmed, tasks)!.headline, /confirmed/);
  assert.equal(newerCancellation(confirmed, requested).state, 'confirmed');
  assert.equal(newerCancellation(requested, confirmed).state, 'confirmed');
  assert.equal(newerCancellation(null, requested).state, 'requested');
});
