import {
  CancellationStatusSchema, CompanyViewSchema, DepartmentArchivedSchema, DepartmentListSchema, DepartmentViewSchema, EffectiveInventorySchema,
  HealthViewSchema, InventorySchema, LiveMessageSchema, ProfilesViewSchema, ProvisioningStatusSchema, QuestActivitySchema, QuestCreatedSchema,
  QuestDetailSchema, QuestListSchema, QuestResultsSchema, QuestTasksSchema, ReconcileResultSchema,
  type ActivityEvent, type CancellationStatus, type CompanyView, type DepartmentArchived, type DepartmentCreate, type DepartmentUpdate,
  type DepartmentView, type EffectiveInventory, type HealthView, type Inventory, type InventoryPatch, type LiveMessage, type ProfilesView,
  type ProvisioningStatus, type QuestCreate, type QuestCreated, type QuestDetail, type QuestResults, type QuestSummary, type QuestTasks,
} from '@vibe-city/shared';
import type { z } from 'zod';

export interface FieldIssue { path: string; message: string }

export class ApiError extends Error {
  status: number;
  code: string;
  /** Per-field validation problems from a 400 `invalid_request` (path is the dotted body field, e.g. `name`). */
  issues: FieldIssue[];
  constructor(status: number, code: string, message: string, issues: FieldIssue[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
  /** Hermes (or the network path to it) is unavailable: show a disconnected state, never invented data. */
  get hermesUnavailable() { return this.status === 503 || this.code === 'hermes_unavailable'; }
  /** The Vibe City backend itself could not be reached. */
  get unreachable() { return this.status === 0; }
}

const GENERIC: Record<number, string> = {
  400: 'The request was rejected.', 404: 'Not found.', 409: 'That conflicts with the current state.',
  502: 'Hermes rejected the request.', 503: 'Hermes is not available.',
};

/** Pulls a safe error message out of a backend error body. Only the documented `message`/`issues` fields are used. */
function errorFrom(status: number, body: unknown): ApiError {
  const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; message?: unknown; issues?: unknown };
  const code = typeof b.error === 'string' ? b.error : 'error';
  const issues: FieldIssue[] = Array.isArray(b.issues)
    ? b.issues.flatMap((i) => (i && typeof i === 'object' && typeof (i as FieldIssue).message === 'string'
      ? [{ path: typeof (i as FieldIssue).path === 'string' ? (i as FieldIssue).path : '', message: (i as FieldIssue).message }] : []))
    : [];
  const message = typeof b.message === 'string' && b.message
    ? b.message
    : issues.length ? issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')
      : GENERIC[status] ?? (status >= 500 ? `The backend failed (HTTP ${status}).` : `Request failed (HTTP ${status}).`);
  return new ApiError(status, code, message, issues);
}

async function request<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'backend_unreachable', 'The Vibe City backend is not reachable.');
  }
  // Non-JSON bodies (proxy error pages, HTML) are never shown: they can contain anything.
  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok) throw errorFrom(res.status, json);
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError(res.status, 'invalid_response', 'The backend sent a response this app does not understand. Reload the page; if it persists, the app and backend versions differ.');
  return parsed.data;
}

const d = (id: string) => `/api/departments/${encodeURIComponent(id)}`;
const q = (dept: string, quest: string) => `${d(dept)}/quests/${encodeURIComponent(quest)}`;

export const api = {
  company: (): Promise<CompanyView> => request('GET', '/api/company', CompanyViewSchema),
  departments: async (opts: { includeArchived?: boolean } = {}): Promise<DepartmentView[]> =>
    (await request('GET', `/api/departments${opts.includeArchived ? '?includeArchived=true' : ''}`, DepartmentListSchema)).departments,
  department: (dept: string): Promise<DepartmentView> => request('GET', d(dept), DepartmentViewSchema),
  createDepartment: (input: Partial<DepartmentCreate> & { name: string }): Promise<DepartmentView> => request('POST', '/api/departments', DepartmentViewSchema, input),
  updateDepartment: (dept: string, input: DepartmentUpdate): Promise<DepartmentView> => request('PATCH', d(dept), DepartmentViewSchema, input),
  /** Archive (the only delete): hides the floor, keeps the row and every Hermes resource. */
  archiveDepartment: (dept: string): Promise<DepartmentArchived> => request('DELETE', d(dept), DepartmentArchivedSchema),
  inventory: (dept: string): Promise<Inventory> => request('GET', `${d(dept)}/inventory`, InventorySchema),
  patchInventory: (dept: string, input: InventoryPatch): Promise<Inventory> => request('PATCH', `${d(dept)}/inventory`, InventorySchema, input),
  effectiveInventory: (dept: string): Promise<EffectiveInventory> => request('GET', `${d(dept)}/effective-inventory`, EffectiveInventorySchema),
  provisioning: (dept: string): Promise<ProvisioningStatus> => request('GET', `${d(dept)}/provisioning`, ProvisioningStatusSchema),
  provision: (dept: string): Promise<ProvisioningStatus> => request('POST', `${d(dept)}/provision`, ProvisioningStatusSchema),
  retryProvision: (dept: string): Promise<ProvisioningStatus> => request('POST', `${d(dept)}/provision/retry`, ProvisioningStatusSchema),
  profiles: (dept: string): Promise<ProfilesView> => request('GET', `${d(dept)}/profiles`, ProfilesViewSchema),
  reconcile: async (): Promise<ProvisioningStatus[]> => (await request('POST', '/api/runtime/reconcile', ReconcileResultSchema)).departments,
  health: (): Promise<HealthView> => request('GET', '/api/runtime/health', HealthViewSchema),
  quests: async (dept: string): Promise<QuestSummary[]> => (await request('GET', `${d(dept)}/quests`, QuestListSchema)).quests,
  createQuest: (dept: string, input: QuestCreate): Promise<QuestCreated> => request('POST', `${d(dept)}/quests`, QuestCreatedSchema, input),
  quest: (dept: string, quest: string): Promise<QuestDetail> => request('GET', q(dept, quest), QuestDetailSchema),
  /** Same task tree as `quest()` (which the UI uses); kept for callers that only need the tree. */
  tasks: (dept: string, quest: string): Promise<QuestTasks> => request('GET', `${q(dept, quest)}/tasks`, QuestTasksSchema),
  activity: async (dept: string, quest: string): Promise<ActivityEvent[]> => (await request('GET', `${q(dept, quest)}/activity`, QuestActivitySchema)).events,
  results: (dept: string, quest: string): Promise<QuestResults> => request('GET', `${q(dept, quest)}/results`, QuestResultsSchema),
  cancel: (dept: string, quest: string): Promise<CancellationStatus> => request('POST', `${q(dept, quest)}/cancel`, CancellationStatusSchema),
  cancellation: (dept: string, quest: string): Promise<CancellationStatus> => request('GET', `${q(dept, quest)}/cancellation`, CancellationStatusSchema),
};

/** Live events from the Vibe City backend (never from Hermes directly). Reconnects automatically. */
export function openLive(departmentId: string, onMessage: (m: LiveMessage) => void, onLink: (up: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/live?departmentId=${encodeURIComponent(departmentId)}`);
    ws.onopen = () => { retry = 1000; onLink(true); };
    ws.onmessage = (e) => {
      let data: unknown;
      try { data = JSON.parse(String(e.data)); } catch { return; }
      const parsed = LiveMessageSchema.safeParse(data);
      if (parsed.success) onMessage(parsed.data);
    };
    ws.onclose = () => {
      if (stopped) return;
      onLink(false);
      timer = setTimeout(connect, retry); retry = Math.min(retry * 2, 15_000);
    };
  };
  connect();
  return () => { stopped = true; clearTimeout(timer); ws?.close(); };
}
