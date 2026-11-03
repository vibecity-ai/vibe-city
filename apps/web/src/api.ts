import {
  ActivityEventSchema, CancellationStatusSchema, CompanyViewSchema, DepartmentViewSchema, EffectiveInventorySchema, HealthViewSchema,
  InventorySchema, LiveMessageSchema, ProfilesViewSchema, ProvisioningStatusSchema, QuestCreatedSchema,
  QuestDetailSchema, QuestResultsSchema, QuestSummarySchema,
  type ActivityEvent, type CancellationStatus, type CompanyView, type DepartmentCreate, type DepartmentUpdate, type DepartmentView,
  type EffectiveInventory, type HealthView, type Inventory, type InventoryPatch, type LiveMessage, type ProfilesView, type ProvisioningStatus,
  type QuestCreate, type QuestCreated, type QuestDetail, type QuestResults, type QuestSummary,
} from '@vibe-city/shared';
import { z } from 'zod';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
  /** Hermes (or the network path to it) is unavailable: show a disconnected state, never invented data. */
  get hermesUnavailable() { return this.status === 503 || this.code === 'hermes_unavailable'; }
}

async function request<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'backend_unreachable', 'The Vibe City backend is not reachable.');
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string; issues?: { message: string }[] };
  if (!res.ok) {
    const msg = json.message ?? json.issues?.map((i) => i.message).join('; ') ?? res.statusText;
    throw new ApiError(res.status, json.error ?? 'error', msg);
  }
  return schema.parse(json);
}

const d = (id: string) => `/api/departments/${encodeURIComponent(id)}`;

export const api = {
  company: (): Promise<CompanyView> => request('GET', '/api/company', CompanyViewSchema),
  createDepartment: (input: Partial<DepartmentCreate> & { name: string }): Promise<DepartmentView> => request('POST', '/api/departments', DepartmentViewSchema, input),
  updateDepartment: (dept: string, input: DepartmentUpdate): Promise<DepartmentView> => request('PATCH', d(dept), DepartmentViewSchema, input),
  inventory: (dept: string): Promise<Inventory> => request('GET', `${d(dept)}/inventory`, InventorySchema),
  patchInventory: (dept: string, input: InventoryPatch): Promise<Inventory> => request('PATCH', `${d(dept)}/inventory`, InventorySchema, input),
  effectiveInventory: (dept: string): Promise<EffectiveInventory> => request('GET', `${d(dept)}/effective-inventory`, EffectiveInventorySchema),
  provisioning: (dept: string): Promise<ProvisioningStatus> => request('GET', `${d(dept)}/provisioning`, ProvisioningStatusSchema),
  provision: (dept: string): Promise<ProvisioningStatus> => request('POST', `${d(dept)}/provision`, ProvisioningStatusSchema),
  retryProvision: (dept: string): Promise<ProvisioningStatus> => request('POST', `${d(dept)}/provision/retry`, ProvisioningStatusSchema),
  profiles: (dept: string): Promise<ProfilesView> => request('GET', `${d(dept)}/profiles`, ProfilesViewSchema),
  reconcile: async (): Promise<ProvisioningStatus[]> =>
    (await request('POST', '/api/runtime/reconcile', z.object({ departments: z.array(ProvisioningStatusSchema) }))).departments,
  health: (): Promise<HealthView> => request('GET', '/api/runtime/health', HealthViewSchema),
  departments: async (): Promise<DepartmentView[]> =>
    (await request('GET', '/api/departments', z.object({ departments: z.array(DepartmentViewSchema) }))).departments,
  quests: async (dept: string): Promise<QuestSummary[]> =>
    (await request('GET', `${d(dept)}/quests`, z.object({ quests: z.array(QuestSummarySchema) }))).quests,
  createQuest: (dept: string, input: QuestCreate): Promise<QuestCreated> => request('POST', `${d(dept)}/quests`, QuestCreatedSchema, input),
  quest: (dept: string, quest: string): Promise<QuestDetail> => request('GET', `${d(dept)}/quests/${quest}`, QuestDetailSchema),
  activity: async (dept: string, quest: string): Promise<ActivityEvent[]> =>
    (await request('GET', `${d(dept)}/quests/${quest}/activity`, z.object({ events: z.array(ActivityEventSchema) }))).events,
  results: (dept: string, quest: string): Promise<QuestResults> => request('GET', `${d(dept)}/quests/${quest}/results`, QuestResultsSchema),
  cancel: (dept: string, quest: string): Promise<CancellationStatus> => request('POST', `${d(dept)}/quests/${quest}/cancel`, CancellationStatusSchema),
  cancellation: (dept: string, quest: string): Promise<CancellationStatus> => request('GET', `${d(dept)}/quests/${quest}/cancellation`, CancellationStatusSchema),
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
      const parsed = LiveMessageSchema.safeParse(JSON.parse(String(e.data)));
      if (parsed.success) onMessage(parsed.data);
    };
    ws.onclose = () => {
      onLink(false);
      if (!stopped) { timer = setTimeout(connect, retry); retry = Math.min(retry * 2, 15_000); }
    };
  };
  connect();
  return () => { stopped = true; clearTimeout(timer); ws?.close(); };
}
