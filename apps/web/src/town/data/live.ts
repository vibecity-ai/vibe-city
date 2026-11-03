/* The live connector: replaces the demo simulation. It reads the Vibe City backend (REST + /api/live), derives the
   view model with derive.ts and writes it into the store. The browser never talks to Hermes.

   Consistency rules (audited for the UI merge):
   - REST snapshots are the truth; live events are only hints to refetch, coalesced per department.
   - A failed refresh keeps the last good data and marks it stale; Hermes being down never clears quests.
   - Every fetch takes a ticket from `gate`; a response that is older than the latest request for the same key is dropped.
   - Mutations refresh the affected department only; create/archive (which change the floor order) refresh everything.
   - Sockets, coalescer timers and cancellation polls are closed when a department leaves the tower or the app unmounts. */
import type {
  AgentRole, CancellationStatus, DepartmentUpdate, DepartmentView, HealthView, Inventory, InventoryPatch, ProvisioningStatus, QuestDetail, QuestSummary,
} from '@vibe-city/shared';
import { api, ApiError, openLive } from '../../api.ts';
import { emptyExtra, useStore, type DeptInfo, type LogLine, type QuestExtra, type QuestItem } from '../store.ts';
import { clock, deriveDept, isLiveQuest } from './derive.ts';
import { backoffDelays, createCoalescer, createGate } from './sched.ts';
import { archivedNotice, inventorySavedNotice, newerCancellation } from './views.ts';
import type { Dept } from './types.ts';
import type { QuestSync } from './company.ts';

interface Raw {
  depts: DepartmentView[];
  prov: Record<string, ProvisioningStatus | null>;
  inv: Record<string, Inventory | null>;
  quests: Record<string, QuestSummary[]>;
  live: Record<string, QuestDetail[]>;
  sync: Record<string, QuestSync>;
  health: HealthView | null;
  companyName: string | null;
}
const raw: Raw = { depts: [], prov: {}, inv: {}, quests: {}, live: {}, sync: {}, health: null, companyName: null };
const slots = new Map<string, Map<string, number>>();
/** Per-department state of the backend's own Hermes event stream. */
const link = new Map<string, 'connected' | 'reconnecting' | 'dashboard_offline' | 'gateway_unavailable'>();
const sockets = new Map<string, () => void>();
/** Departments whose last quest refresh failed for a reason other than Hermes being down. */
const staleDepts = new Set<string>();
const polls = new Map<string, { dept: string; stop: () => void }>();
const gate = createGate();
/** One Hermes burst = one refresh: 400 ms after the last event, at most 2 s after the first. */
const hints = createCoalescer((id) => void refreshDept(id), { quietMs: 400, maxWaitMs: 2000 });
let poll: ReturnType<typeof setInterval> | undefined;
let healthPoll: ReturnType<typeof setInterval> | undefined;

const st = () => useStore.getState();
const message = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
const asApiError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(-1, 'client_error', message(e)));

/* ---------- derive + commit ---------- */

function commit() {
  const s = st();
  const hermesUp = connState().hermes;
  const sorted = [...raw.depts].filter((d) => !d.archivedAt).sort((a, b) => (a.floorPosition ?? 1e9) - (b.floorPosition ?? 1e9));
  const depts: Dept[] = sorted.map((v) => {
    const out = deriveDept({
      dept: v, provisioning: raw.prov[v.id] ?? null, liveQuests: raw.live[v.id] ?? [],
      maxWorkers: raw.inv[v.id]?.limits.maxConcurrentWorkers ?? 1, chiefModel: s.info[v.id]?.profiles?.chief.model ?? null,
      slots: slots.get(v.id) ?? new Map(), hermesUp,
    });
    slots.set(v.id, out.slots);
    return out.dept;
  });
  const quests: QuestItem[] = sorted.flatMap((v) => (raw.quests[v.id] ?? []).map((summary) => ({ deptId: v.id, summary })));
  const questSync: Record<string, QuestSync> = {};
  for (const v of sorted) questSync[v.id] = raw.sync[v.id] ?? 'not_loaded';
  const details: Record<string, QuestDetail> = { ...s.details };
  for (const v of sorted) for (const q of raw.live[v.id] ?? []) details[q.id] = q;
  const info: Record<string, DeptInfo> = {};
  for (const v of sorted) info[v.id] = { effective: s.info[v.id]?.effective ?? null, profiles: s.info[v.id]?.profiles ?? null, infoError: s.info[v.id]?.infoError ?? null, inventory: raw.inv[v.id] ?? null, provisioning: raw.prov[v.id] ?? null };

  if (s.loaded) emitFx(s.depts, depts, s.quests, quests);
  useStore.setState({
    company: raw.companyName ? { name: raw.companyName } : s.company, depts, quests, questSync, details, info,
    conn: connState(), loaded: true, stale: staleDepts.size > 0,
  });
}

function connState() {
  const h = raw.health?.hermes;
  const live = [...link.values()];
  const hermes = !!h && h.dashboard === 'up' && h.auth === 'ok' && !live.includes('dashboard_offline');
  const gateway = !!h && h.gateway === 'running' && !live.includes('gateway_unavailable') && !live.includes('dashboard_offline');
  return { backend: true, hermes, gateway };
}

function emitFx(prev: Dept[], next: Dept[], pq: QuestItem[], nq: QuestItem[]) {
  const { emit } = st();
  const before = new Map(prev.map((d) => [d.id, d]));
  for (const d of next) {
    const p = before.get(d.id);
    if (!p) { emit({ k: 'floorAdded', dept: d.id }); continue; }
    if (!p.chief && d.chief) emit({ k: 'chiefArrived', dept: d.id });
    if (p.chief?.status !== 'running' && d.chief?.status === 'running') emit({ k: 'plan', dept: d.id });
    const had = new Map(p.workers.map((w) => [w.taskId, w]));
    for (const w of d.workers) {
      const o = had.get(w.taskId);
      if (!o) { emit({ k: 'workerJoined', dept: d.id, worker: w.id }); if (w.status === 'running') emit({ k: 'delegate', dept: d.id, to: w.id }); continue; }
      if (o.status !== w.status && w.status === 'completed') emit({ k: 'taskDone', dept: d.id, worker: w.id });
      if (o.status !== w.status && w.status === 'failed') emit({ k: 'taskFail', dept: d.id, worker: w.id });
      if (o.status !== 'running' && w.status === 'running' && o.status !== 'completed') emit({ k: 'delegate', dept: d.id, to: w.id });
    }
  }
  const was = new Map(pq.map((q) => [q.summary.id, q.summary.status]));
  for (const q of nq) if (q.summary.status === 'completed' && was.has(q.summary.id) && was.get(q.summary.id) !== 'completed') emit({ k: 'questDone', dept: q.deptId });
}

/* ---------- fetching ---------- */

/** Local data only (SQLite): safe to fetch for every department even when Hermes is down. Failures keep the last values. */
async function loadLocal(v: DepartmentView) {
  const t = gate.begin(`local:${v.id}`);
  const [inv, prov] = await Promise.all([api.inventory(v.id).catch(() => undefined), api.provisioning(v.id).catch(() => undefined)]);
  if (!gate.current(`local:${v.id}`, t)) return;
  if (inv) raw.inv[v.id] = inv;
  if (prov) raw.prov[v.id] = prov;
}

/** Quests come from Hermes. On failure the previous quests stay rather than being cleared. */
async function loadQuests(v: DepartmentView) {
  if (!v.hermesBoardRef) { raw.quests[v.id] = []; raw.live[v.id] = []; raw.sync[v.id] = 'no_board'; staleDepts.delete(v.id); return; }
  const t = gate.begin(`quests:${v.id}`);
  try {
    const list = await api.quests(v.id);
    const details = await Promise.all(list.filter(isLiveQuest).map((q) => api.quest(v.id, q.id)));
    if (!gate.current(`quests:${v.id}`, t)) return;
    raw.quests[v.id] = list; raw.live[v.id] = details; raw.sync[v.id] = 'ok';
    staleDepts.delete(v.id);
  } catch (e) {
    if (!gate.current(`quests:${v.id}`, t)) return;
    // Never loaded is different from loaded-then-failed: the company board must not show a missing list as empty.
    raw.sync[v.id] = raw.quests[v.id] && raw.sync[v.id] !== 'no_board' ? 'out_of_date' : 'not_loaded';
    if (e instanceof ApiError && e.unreachable) throw e;
    // Hermes unavailable: the connection state already says so; anything else marks this floor's data out of date.
    if (!(e instanceof ApiError && e.hermesUnavailable)) staleDepts.add(v.id);
  }
}

function syncSockets() {
  const want = new Set(raw.depts.filter((d) => !d.archivedAt && d.hermesBoardRef).map((d) => d.id));
  for (const [id, close] of sockets) if (!want.has(id)) { close(); sockets.delete(id); link.delete(id); setLiveDown(id, false); }
  for (const id of want) {
    if (sockets.has(id)) continue;
    sockets.set(id, openLive(id, (m) => {
      if (m.type === 'connection') { link.set(id, m.state); commit(); return; }
      if (m.type === 'hermes.event') pushLog(id, m.taskId, m.kind, m.at);
      hints.hint(id); // hermes.event and resync: refetch the snapshot
    }, (up) => {
      setLiveDown(id, !up);
      if (!up && link.delete(id)) commit();
    }));
  }
}

function setLiveDown(id: string, down: boolean) {
  if (!!st().liveDown[id] === down) return;
  useStore.setState((s) => {
    const { [id]: _, ...rest } = s.liveDown;
    return { liveDown: down ? { ...rest, [id]: true } : rest };
  });
}

/** Drops everything held for departments that left the tower (archived), including timers and sockets. */
function forgetGone() {
  const active = new Set(raw.depts.filter((d) => !d.archivedAt).map((d) => d.id));
  for (const id of new Set([...Object.keys(raw.prov), ...Object.keys(raw.quests), ...slots.keys(), ...[...polls.values()].map((p) => p.dept)])) {
    if (active.has(id)) continue;
    delete raw.prov[id]; delete raw.inv[id]; delete raw.quests[id]; delete raw.live[id]; delete raw.sync[id];
    slots.delete(id); staleDepts.delete(id); hints.cancel(id);
    for (const k of ['local', 'quests', 'info', 'dept']) gate.forget(`${k}:${id}`);
    gate.forget(`agent:${id}:chief`); gate.forget(`agent:${id}:worker`);
    for (const p of [...polls.values()]) if (p.dept === id) p.stop();
  }
}

function pushLog(deptId: string, taskId: string, kind: string, at: string) {
  const title = raw.live[deptId]?.flatMap((q) => q.tasks).find((t) => t.id === taskId)?.title ?? taskId;
  const k = /fail|block|crash|timed/i.test(kind) ? 'failed' : /complet|done/i.test(kind) ? 'completed' : /start|claim|spawn|run|promot/i.test(kind) ? 'running' : 'idle';
  const line: LogLine = { t: clock(at), dept: deptId, kind: k, text: `${title} · ${kind.replace(/_/g, ' ')}`, taskId };
  useStore.setState((s) => ({ log: [line, ...s.log].slice(0, 80) }));
}

/** Refetches one department's quests (live-event hint). */
export async function refreshDept(id: string) {
  const v = raw.depts.find((d) => d.id === id);
  if (!v) return;
  try {
    await loadQuests(v);
    commit();
    // keep any open quest detail current too
    const q = st().ui.questId;
    if (q && st().quests.some((x) => x.summary.id === q && x.deptId === id)) void loadQuest(id, q, true);
  } catch (e) { fail(e); }
}

/** After a mutation: the department row, its local data, quests and Hermes-side info. Falls back to a full refresh when the department is gone. */
export async function refreshOne(id: string) {
  const t = gate.begin(`dept:${id}`);
  try {
    const v = await api.department(id);
    if (!gate.current(`dept:${id}`, t)) return;
    if (v.archivedAt) return void (await refreshAll());
    raw.depts = raw.depts.some((d) => d.id === id) ? raw.depts.map((d) => (d.id === id ? v : d)) : [...raw.depts, v];
    await Promise.all([loadLocal(v), loadQuests(v).catch(() => undefined), loadDeptInfo(id)]);
    syncSockets();
    commit();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return void (await refreshAll());
    fail(e);
  }
}

function fail(e: unknown) {
  if (e instanceof ApiError && e.unreachable) useStore.setState((s) => ({ stale: s.loaded, conn: { ...s.conn, backend: false } }));
  else useStore.setState({ stale: true });
}

export async function refreshAll() {
  const t = gate.begin('all');
  try {
    const [health, company, depts] = await Promise.all([api.health().catch(() => null), api.company(), api.departments()]);
    if (!gate.current('all', t)) return;
    raw.health = health; raw.companyName = company.name; raw.depts = depts;
    forgetGone();
    await Promise.all(depts.filter((d) => !d.archivedAt).map(async (v) => { await loadLocal(v); await loadQuests(v); }));
    if (!gate.current('all', t)) return;
    syncSockets();
    commit();
  } catch (e) { if (gate.current('all', t)) fail(e); }
}

async function refreshHealth() {
  try { raw.health = await api.health(); commit(); } catch (e) { fail(e); }
}

export function startLive() {
  void refreshAll();
  poll = setInterval(() => void refreshAll(), 30_000);
  healthPoll = setInterval(() => void refreshHealth(), 10_000);
  return stopLive;
}

export function stopLive() {
  clearInterval(poll); clearInterval(healthPoll);
  for (const c of sockets.values()) c();
  sockets.clear(); link.clear();
  hints.cancelAll();
  for (const p of [...polls.values()]) p.stop();
}

/* ---------- on-demand detail ---------- */

const setExtra = (questId: string, p: Partial<QuestExtra>) =>
  useStore.setState((s) => ({ extra: { ...s.extra, [questId]: { ...(s.extra[questId] ?? emptyExtra()), ...p } } }));

function applyCancellation(questId: string, c: CancellationStatus) {
  setExtra(questId, { cancellation: newerCancellation(st().extra[questId]?.cancellation, c) });
}

/** Detail, activity and results of one quest. Each part keeps its last good value when its request fails. */
export async function loadQuest(deptId: string, questId: string, quiet = false) {
  const tq = gate.begin(`quest:${questId}`);
  const tc = gate.begin(`cancel:${questId}`);
  if (!quiet) setExtra(questId, { loading: true, error: null });
  const [detail, activity, results] = await Promise.allSettled([api.quest(deptId, questId), api.activity(deptId, questId), api.results(deptId, questId)]);
  if (!gate.current(`quest:${questId}`, tq)) return;
  if (detail.status === 'fulfilled') {
    useStore.setState((s) => ({ details: { ...s.details, [questId]: detail.value } }));
    if (gate.current(`cancel:${questId}`, tc)) applyCancellation(questId, detail.value.cancellation);
  }
  const firstError = [detail, activity, results].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  setExtra(questId, {
    ...(activity.status === 'fulfilled' && { activity: activity.value }),
    ...(results.status === 'fulfilled' && { results: results.value }),
    loading: false, error: firstError ? message(firstError.reason) : null,
  });
}

export async function loadDeptInfo(deptId: string) {
  const t = gate.begin(`info:${deptId}`);
  const [effective, profiles] = await Promise.allSettled([api.effectiveInventory(deptId), api.profiles(deptId)]);
  if (!gate.current(`info:${deptId}`, t)) return;
  const err = [effective, profiles].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  useStore.setState((s) => {
    const prev = s.info[deptId] ?? { inventory: null, provisioning: null, effective: null, profiles: null };
    return { info: { ...s.info, [deptId]: {
      ...prev,
      effective: effective.status === 'fulfilled' ? effective.value : prev.effective,
      profiles: profiles.status === 'fulfilled' ? profiles.value : prev.profiles,
      infoError: err ? message(err.reason) : null,
    } } };
  });
}

/** The agent view of one profile (chief or the department's worker profile). Keeps the last view on failure. */
export async function loadAgent(deptId: string, role: AgentRole) {
  const key = `${deptId}:${role}`;
  const t = gate.begin(`agent:${key}`);
  const prev = () => st().agents[key] ?? { view: null, error: null, loading: false };
  useStore.setState((s) => ({ agents: { ...s.agents, [key]: { ...prev(), loading: true } } }));
  try {
    const view = await api.agent(deptId, role);
    if (!gate.current(`agent:${key}`, t)) return;
    useStore.setState((s) => ({ agents: { ...s.agents, [key]: { view, error: null, loading: false } } }));
  } catch (e) {
    if (!gate.current(`agent:${key}`, t)) return;
    useStore.setState((s) => ({ agents: { ...s.agents, [key]: { ...prev(), error: message(e), loading: false } } }));
  }
}

export async function loadArchived() {
  useStore.setState((s) => ({ archived: { ...s.archived, loading: true, error: null } }));
  try {
    const list = (await api.departments({ includeArchived: true })).filter((d) => d.archivedAt);
    useStore.setState({ archived: { list, loading: false, error: null } });
  } catch (e) {
    useStore.setState((s) => ({ archived: { ...s.archived, loading: false, error: message(e) } }));
  }
}

/* ---------- actions ---------- */

function setBusy(key: string, on: boolean) {
  useStore.setState((s) => {
    const { [key]: _, ...rest } = s.busy;
    return { busy: on ? { ...rest, [key]: true } : rest };
  });
}

async function run<T>(key: string, label: string, fn: () => Promise<T>): Promise<T | null> {
  if (st().busy[key]) return null;
  setBusy(key, true);
  try { return await fn(); }
  catch (e) { st().toast(`${label}: ${message(e)}`, 'bad'); return null; }
  finally { setBusy(key, false); }
}

/** Like `run`, but hands the error back to a form instead of a toast. */
async function attempt<T>(key: string, fn: () => Promise<T>): Promise<{ value: T | null; error: ApiError | null }> {
  if (st().busy[key]) return { value: null, error: null };
  setBusy(key, true);
  try { return { value: await fn(), error: null }; }
  catch (e) { return { value: null, error: asApiError(e) }; }
  finally { setBusy(key, false); }
}

export async function createDepartment(name: string, purpose: string) {
  const v = await run('create', 'Could not create the department', () => api.createDepartment({ name, purpose }));
  if (!v) return;
  await refreshAll();
  st().ui$({ modal: null });
  st().openFloor(v.id);
  st().toast(`Floor added · ${v.name}. Provision it to bring in the chief.`);
}

/** PATCH name/purpose/workspace. On failure nothing local changes (the last good state stays). */
export async function saveDepartmentSettings(id: string, patch: DepartmentUpdate): Promise<ApiError | null> {
  const before = raw.depts.find((d) => d.id === id)?.state;
  const { value, error } = await attempt(`settings:${id}`, () => api.updateDepartment(id, patch));
  if (!value) return error;
  await refreshOne(id);
  if (value.state === 'unconfigured' && before && before !== 'unconfigured') st().toast('Settings saved. The department must be provisioned again before agents get new work.', 'warn');
  else st().toast('Settings saved.');
  return null;
}

export async function archiveDepartment(id: string): Promise<ApiError | null> {
  const { value, error } = await attempt(`archive:${id}`, () => api.archiveDepartment(id));
  if (!value) return error;
  if (st().ui.floorId === id) st().closeFloor();
  st().ui$({ modal: null });
  await refreshAll(); // removes the floor, closes its socket, timers and polls (forgetGone/syncSockets)
  if (st().archived.list) void loadArchived();
  st().toast(archivedNotice(value.department.name, value.hermesResourcesRetained), value.hermesResourcesRetained ? 'warn' : 'good');
  return null;
}

export interface ProvisionOptions { chiefProfileRef?: string | null; workerProfileRef?: string | null; confirmModifyProfiles?: string[] }

/** Provisioning is synchronous on the backend (it can take a while: profile creation). Existing profiles need explicit consent. */
export async function provisionDepartment(id: string, opts: ProvisionOptions = {}, retry = false) {
  const status = await run(`provision:${id}`, 'Provisioning failed', async () => {
    const refs = { ...(opts.chiefProfileRef !== undefined && { chiefProfileRef: opts.chiefProfileRef }), ...(opts.workerProfileRef !== undefined && { workerProfileRef: opts.workerProfileRef }) };
    if (Object.keys(refs).length) await api.updateDepartment(id, refs);
    if (opts.confirmModifyProfiles?.length) await api.updateDepartment(id, { confirmModifyProfiles: opts.confirmModifyProfiles });
    return retry ? api.retryProvision(id) : api.provision(id);
  });
  await refreshOne(id);
  if (!status) return;
  if (status.state === 'ready') st().toast('Floor is ready. Chief and worker profiles are verified.');
  else if (status.error) st().toast(status.error.message, status.error.retryable ? 'warn' : 'bad');
}

export async function createQuest(deptId: string, input: { clientRequestId: string; title: string; objective: string; instructions?: string }) {
  const out = await run(`quest:${deptId}`, 'Could not create the quest', () => api.createQuest(deptId, input));
  if (!out) return null;
  await refreshDept(deptId);
  for (const w of out.warnings) st().toast(w, 'warn');
  const d = st().depts.find((x) => x.id === deptId);
  st().toast(`Quest created${d ? ` for ${d.name}` : ''} and assigned to ${d?.chief?.name ?? 'its chief'}.`);
  return out.questId;
}

export async function cancelQuest(deptId: string, questId: string) {
  const t = gate.begin(`cancel:${questId}`);
  const out = await run(`cancel:${questId}`, 'Could not cancel the quest', () => api.cancel(deptId, questId));
  if (!out) return;
  if (gate.current(`cancel:${questId}`, t)) applyCancellation(questId, out);
  // 202 means "accepted", not "cancelled": only a confirmed status says nothing is running any more.
  if (out.state === 'confirmed') st().toast('Quest cancelled. Hermes confirms nothing is running.', 'good');
  else { st().toast('Cancellation requested. Waiting for Hermes to confirm every task stopped.', 'warn'); pollCancellation(deptId, questId); }
  await refreshDept(deptId);
}

export function stopCancellationPoll(questId: string) { polls.get(questId)?.stop(); }

/**
 * Polls GET .../cancellation with bounded backoff until Hermes confirms, the quest view closes, Hermes/the backend
 * goes away, or the budget runs out. Live events refresh the same status in between (loadQuest).
 */
export function pollCancellation(deptId: string, questId: string, budgetMs = 120_000) {
  stopCancellationPoll(questId);
  const delays = backoffDelays(budgetMs);
  let i = 0;
  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { stopped = true; clearTimeout(handle); if (polls.get(questId)?.stop === stop) polls.delete(questId); };
  const end = (poll: QuestExtra['poll']) => { stop(); setExtra(questId, { poll }); };
  polls.set(questId, { dept: deptId, stop });
  setExtra(questId, { poll: 'polling' });
  const next = () => {
    if (i >= delays.length) return end('timeout');
    handle = setTimeout(() => void tick(), delays[i++]);
  };
  const tick = async () => {
    if (stopped) return;
    if (st().ui.questId !== questId) return end('idle');
    const t = gate.begin(`cancel:${questId}`);
    try {
      const c = await api.cancellation(deptId, questId);
      if (stopped) return;
      if (gate.current(`cancel:${questId}`, t)) applyCancellation(questId, c);
      if (st().extra[questId]?.cancellation?.state === 'confirmed') {
        end('idle');
        await refreshDept(deptId);
        return;
      }
    } catch (e) {
      if (stopped) return;
      if (e instanceof ApiError && (e.hermesUnavailable || e.unreachable)) return end('hermes_down');
      // anything else: keep trying within the budget
    }
    next();
  };
  next();
}

export async function patchInventory(deptId: string, patch: InventoryPatch) {
  const before = raw.prov[deptId]?.state;
  const out = await run(`inv:${deptId}`, 'Could not save the inventory', () => api.patchInventory(deptId, patch));
  if (!out) return;
  await refreshOne(deptId);
  const n = inventorySavedNotice(before, raw.prov[deptId]?.state);
  st().toast(n.text, n.tone);
}

export async function reconcileNow() {
  const out = await run('reconcile', 'Reconcile failed', () => api.reconcile());
  if (!out) return;
  await refreshAll();
  const open = st().ui.floorId;
  if (open) void loadDeptInfo(open);
  st().toast('Reconciled with Hermes.');
}
