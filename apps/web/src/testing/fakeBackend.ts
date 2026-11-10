/* A scripted stand-in for the Vibe City backend, for web unit tests: routes `METHOD /path` to handlers and records
   every call. Handlers return whatever DTO a test needs (tests use valid DTOs unless they test malformed responses). */
import type { DepartmentView, ProvisioningStatus, QuestDetail, QuestSummary } from '@vibe-city/shared';

export interface Reply { status?: number; body?: unknown; raw?: string }
export type Handler = (req: { method: string; path: string; body: unknown }) => Reply | Promise<Reply>;

export function fakeBackend() {
  const routes = new Map<string, Handler>();
  const calls: { method: string; path: string; body: unknown }[] = [];
  let down = false;
  const fetch = async (input: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: input, body });
    if (down) throw new TypeError('fetch failed');
    const h = routes.get(`${method} ${input}`) ?? routes.get(`${method} ${input.split('?')[0]}`);
    const r: Reply = h ? await h({ method, path: input, body }) : { status: 404, body: { error: 'not_found', message: 'no route' } };
    const text = r.raw ?? JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status ?? 200, headers: { 'content-type': r.raw ? 'text/html' : 'application/json' } });
  };
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    calls,
    on(method: string, path: string, h: Handler | Reply) { routes.set(`${method} ${path}`, typeof h === 'function' ? h : () => h); return this; },
    setDown(v: boolean) { down = v; },
    count: (method: string, prefix: string) => calls.filter((c) => c.method === method && c.path.startsWith(prefix)).length,
  };
}

export const DEPT_ID = '11111111-1111-4111-8111-111111111111';
export const iso = '2026-11-03T10:00:00.000Z';

export const deptView = (o: Partial<DepartmentView> = {}): DepartmentView => ({
  id: DEPT_ID, name: 'Research', purpose: 'Find things', floorOrder: 1, floorPosition: 1, state: 'ready',
  agents: [
    { key: 'chief', lead: true, profileRef: 'vc-111111111111-chief', model: null, skills: [], createdAt: iso },
    { key: 'W-01', lead: false, profileRef: 'vc-111111111111-w01', model: null, skills: [], createdAt: iso },
  ],
  hermesBoardSlug: `vc-${DEPT_ID}`, hermesBoardRef: `vc-${DEPT_ID}`, boardSyncState: 'synced', archivedAt: null, createdAt: iso, updatedAt: iso, ...o,
});

const res = (ref: string | null) => ({ ref, verified: true, verifiedAt: iso, origin: 'created' as const, modificationConfirmed: null });
export const provStatus = (o: Partial<ProvisioningStatus> = {}): ProvisioningStatus => ({
  departmentId: DEPT_ID, state: 'ready', attempts: 1, error: null,
  board: res(`vc-${DEPT_ID}`), agents: [{ key: 'chief', ...res('vc-111111111111-chief') }, { key: 'W-01', ...res('vc-111111111111-w01') }],
  inventory: { applied: true, appliedAt: iso, inSync: true }, lastReconciledAt: iso, ...o,
});

export const inventory = () => ({
  allowedSkillIds: [], allowedMcpTools: [], model: null, allowedToolsets: ['file'], sharedContextRefs: [],
  limits: { maxTaskRuntimeSeconds: null, maxDelegationDepth: 1 },
});

export const health = (up = true) => ({
  checkedAt: iso, hermes: up
    ? { dashboard: 'up', auth: 'ok', gateway: 'running', version: '2026.9.24', detail: null }
    : { dashboard: 'down', auth: 'unknown', gateway: 'unknown', version: null, detail: 'dashboard unreachable' },
});

export const company = () => ({
  id: 'c1', name: 'Acme', createdAt: iso,
  executiveOffice: { id: 'executive-office', name: 'Executive Office', position: 'top', deletable: false },
  floors: [{ kind: 'executive' }, { kind: 'department', departmentId: DEPT_ID }],
});

export const summary = (o: Partial<QuestSummary> = {}): QuestSummary => ({
  id: 't_root1', title: 'Quest one', status: 'running',
  flags: { planningComplete: false, delegated: false, hasFailures: false, hasBlocked: false, idle: false, unauthorizedAssignees: false },
  counts: { tasks: 1, done: 0, running: 1, pending: 0, blocked: 0, failed: 0, archived: 0 }, createdAt: iso, completedAt: null, ...o,
});

export const detail = (o: Partial<QuestDetail> = {}): QuestDetail => ({
  ...summary(), departmentId: DEPT_ID, objective: 'o',
  tasks: [{ id: 't_root1', title: 'Quest one', agentKey: 'chief', assignee: 'vc-111111111111-chief', status: 'running', parentIds: [], childIds: [], depth: 0, failed: false,
    createdAt: iso, startedAt: iso, completedAt: null, summary: null, error: null, blockReason: null, attachmentCount: 0, runs: [], note: null }],
  violations: [], warnings: [], truncated: false,
  cancellation: { state: 'none', requestedAt: null, confirmedAt: null, remaining: [], archivedTaskIds: [], alreadyFinishedTaskIds: [] }, ...o,
});
