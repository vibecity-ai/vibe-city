import {
  AgentViewSchema, DepartmentAgentSchema, CancellationStatusSchema, CompanyViewSchema, DepartmentArchivedSchema, DepartmentListSchema, DepartmentViewSchema, EffectiveInventorySchema,
  CharacterSchema, ChatHistorySchema, ChatProgressSchema, ChatReplySchema, type Character, type ChatHistory, type ChatProgress, type ChatReply, type ChatSend,
  HealthViewSchema, HermesDefaultsViewSchema, HermesModelsViewSchema, InventorySchema, LiveMessageSchema, ProfilesViewSchema, ProvisioningStatusSchema, QuestActivitySchema, QuestCreatedSchema,
  QuestDetailSchema, QuestFileAddedSchema, QuestListSchema, type AttachmentView, QuestResultsSchema, QuestTasksSchema, SyncCheckSchema,
  type ActivityEvent, type AgentView, type CancellationStatus, type CompanyView, type DepartmentArchived, type DepartmentCreate, type DepartmentUpdate,
  type AgentPatch, type DepartmentAgent, type DepartmentView, type EffectiveInventory, type HealthView, type HermesDefaultsView, type HermesModelsView, type Inventory, type InventoryPatch, type LiveMessage, type ProfilesView,
  type ProvisioningStatus, type SyncCheck, type QuestCreate, type QuestCreated, type QuestDetail, type QuestResults, type QuestSummary, type QuestTasks,
} from '@vibe-city/shared';
import {
  InterviewHistorySchema, HiringCurrentSchema, HiringRequestViewSchema, InterviewReplySchema,
  type ChatMessage, type HiringBrief, type HiringRequestView, type InterviewReply,
  AssistantViewSchema, DeptDraftReplySchema, type AssistantView, type DeptDraftReply, ChiefOfStaffModelsSchema, type ChiefOfStaffModels,
  QuestOriginListSchema, QuestRequestListSchema, QuestRequestViewSchema,
  type QuestOrigin, type QuestRequestView,
  ScheduleListSchema, ScheduleSchema, type Schedule, type ScheduleCreate, type SchedulePatch,
  TaskStepsViewSchema, type TaskStepsView,
} from '@vibe-city/shared';
import { DepartmentEnvSchema, DepartmentFilesSchema, type DepartmentEnv, type DepartmentFiles } from '@vibe-city/shared';
import { AiUsageSummarySchema, CompanySettingsSchema, ConnectorCheckReplySchema, type ConnectorCheckReply, type ConnectorName, GameStateSchema, TemplateListSchema, type AiUsageSummary, type CompanySettings, type CompanySettingsPatch, type GameState, type TemplateList, WalletStateSchema, type WalletState } from '@vibe-city/shared';
import {
  ListingDraftSchema, MarketViewSchema, type ListingDraft, type MarketRegister, type MarketView,
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
const h = (id: string) => `/api/hiring/requests/${encodeURIComponent(id)}`;
const q = (dept: string, quest: string) => `${d(dept)}/quests/${encodeURIComponent(quest)}`;

export const api = {
  company: (): Promise<CompanyView> => request('GET', '/api/company', CompanyViewSchema),
  renameCompany: (name: string): Promise<CompanyView> => request('PATCH', '/api/company', CompanyViewSchema, { name }),
  departments: async (): Promise<DepartmentView[]> => (await request('GET', '/api/departments', DepartmentListSchema)).departments,
  department: (dept: string): Promise<DepartmentView> => request('GET', d(dept), DepartmentViewSchema),
  createDepartment: (input: Partial<DepartmentCreate> & { name: string }): Promise<DepartmentView> => request('POST', '/api/departments', DepartmentViewSchema, input),
  updateDepartment: (dept: string, input: DepartmentUpdate): Promise<DepartmentView> => request('PATCH', d(dept), DepartmentViewSchema, input),
  /** Archive (the only delete): hides the floor, keeps the row and every Hermes resource. */
  archiveDepartment: (dept: string): Promise<DepartmentArchived> => request('DELETE', d(dept), DepartmentArchivedSchema),
  inventory: (dept: string): Promise<Inventory> => request('GET', `${d(dept)}/inventory`, InventorySchema),
  patchInventory: (dept: string, input: InventoryPatch): Promise<Inventory> => request('PATCH', `${d(dept)}/inventory`, InventorySchema, input),
  fireAgent: (dept: string, agentKey: string): Promise<DepartmentView> => request('DELETE', `${d(dept)}/agents/${encodeURIComponent(agentKey)}`, DepartmentViewSchema),
  patchAgent: (dept: string, agentKey: string, input: AgentPatch): Promise<DepartmentAgent> => request('PATCH', `${d(dept)}/agents/${encodeURIComponent(agentKey)}`, DepartmentAgentSchema, input),
  effectiveInventory: (dept: string): Promise<EffectiveInventory> => request('GET', `${d(dept)}/effective-inventory`, EffectiveInventorySchema),
  provisioning: (dept: string): Promise<ProvisioningStatus> => request('GET', `${d(dept)}/provisioning`, ProvisioningStatusSchema),
  provision: (dept: string): Promise<ProvisioningStatus> => request('POST', `${d(dept)}/provision`, ProvisioningStatusSchema),
  checkSync: (dept: string): Promise<SyncCheck> => request('POST', `${d(dept)}/check`, SyncCheckSchema),
  profiles: (dept: string): Promise<ProfilesView> => request('GET', `${d(dept)}/profiles`, ProfilesViewSchema),
  agent: (dept: string, agentKey: string): Promise<AgentView> => request('GET', `${d(dept)}/agents/${encodeURIComponent(agentKey)}`, AgentViewSchema),
  /** What the agent did on one of its tasks (tools used, notes), from its Hermes run sessions. */
  taskSteps: (dept: string, agentKey: string, taskId: string): Promise<TaskStepsView> =>
    request('GET', `${d(dept)}/agents/${encodeURIComponent(agentKey)}/tasks/${encodeURIComponent(taskId)}/steps`, TaskStepsViewSchema),
  health: (): Promise<HealthView> => request('GET', '/api/runtime/health', HealthViewSchema),
  hermesDefaults: (): Promise<HermesDefaultsView> => request('GET', '/api/runtime/defaults', HermesDefaultsViewSchema),
  hermesModels: (): Promise<HermesModelsView> => request('GET', '/api/runtime/models', HermesModelsViewSchema),
  quests: async (dept: string): Promise<QuestSummary[]> => (await request('GET', `${d(dept)}/quests`, QuestListSchema)).quests,
  createQuest: (dept: string, input: QuestCreate): Promise<QuestCreated> => request('POST', `${d(dept)}/quests`, QuestCreatedSchema, input),
  /** The floor's file archive: every file on its jobs. */
  departmentFiles: (dept: string): Promise<DepartmentFiles> => request('GET', `${d(dept)}/files`, DepartmentFilesSchema),
  /** A floor's env variables: names and whether the agents have them (values are write-only). */
  deptEnv: (dept: string): Promise<DepartmentEnv> => request('GET', `${d(dept)}/env`, DepartmentEnvSchema),
  setDeptEnv: (dept: string, name: string, value: string): Promise<DepartmentEnv> => request('PUT', `${d(dept)}/env/${encodeURIComponent(name)}`, DepartmentEnvSchema, { value }),
  removeDeptEnv: (dept: string, name: string): Promise<DepartmentEnv> => request('DELETE', `${d(dept)}/env/${encodeURIComponent(name)}`, DepartmentEnvSchema),
  /** One reference file for a job, sent as raw bytes (Hermes keeps it on the quest's root task). */
  addQuestFile: async (dept: string, quest: string, file: File): Promise<AttachmentView> => {
    let res: Response;
    try {
      res = await fetch(`${q(dept, quest)}/files`, {
        method: 'POST', body: file,
        headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name), ...(file.type ? { 'x-content-type': file.type } : {}) },
      });
    } catch {
      throw new ApiError(0, 'backend_unreachable', 'The Vibe City backend is not reachable.');
    }
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) throw errorFrom(res.status, json);
    const parsed = QuestFileAddedSchema.safeParse(json);
    if (!parsed.success) throw new ApiError(res.status, 'invalid_response', 'The backend sent a response this app does not understand.');
    return parsed.data.attachment;
  },
  quest: (dept: string, quest: string): Promise<QuestDetail> => request('GET', q(dept, quest), QuestDetailSchema),
  /** Same task tree as `quest()` (which the UI uses); kept for callers that only need the tree. */
  tasks: (dept: string, quest: string): Promise<QuestTasks> => request('GET', `${q(dept, quest)}/tasks`, QuestTasksSchema),
  activity: async (dept: string, quest: string): Promise<ActivityEvent[]> => (await request('GET', `${q(dept, quest)}/activity`, QuestActivitySchema)).events,
  results: (dept: string, quest: string): Promise<QuestResults> => request('GET', `${q(dept, quest)}/results`, QuestResultsSchema),
  cancel: (dept: string, quest: string): Promise<CancellationStatus> => request('POST', `${q(dept, quest)}/cancel`, CancellationStatusSchema),
  /** The boss's answer to a blocked task: posted on it, and the task resumes. Returns the quest as it is now. */
  answerTask: (dept: string, quest: string, taskId: string, message: string): Promise<QuestDetail> =>
    request('POST', `${q(dept, quest)}/tasks/${encodeURIComponent(taskId)}/answer`, QuestDetailSchema, { message }),
  character: (dept: string, agentKey: string): Promise<Character> => request('GET', `${d(dept)}/characters/${encodeURIComponent(agentKey)}`, CharacterSchema),
  /** One chat with the agent: a Hermes session id, 'new', or omitted for the last one used. */
  chatHistory: (dept: string, agentKey: string, session?: string): Promise<ChatHistory> =>
    request('GET', `${d(dept)}/characters/${encodeURIComponent(agentKey)}/chat${session ? `?session=${encodeURIComponent(session)}` : ''}`, ChatHistorySchema),
  templates: (): Promise<TemplateList> => request('GET', '/api/templates', TemplateListSchema),
  game: (): Promise<GameState> => request('GET', '/api/game', GameStateSchema),
  aiUsage: (): Promise<AiUsageSummary> => request('GET', '/api/ai/usage', AiUsageSummarySchema),
  checkConnector: (name: ConnectorName): Promise<ConnectorCheckReply> => request('POST', `/api/wallet/connectors/${name}/check`, ConnectorCheckReplySchema),
  wallet: (): Promise<WalletState> => request('GET', '/api/wallet', WalletStateSchema),
  walletKey: (apiKey: string): Promise<WalletState> => request('POST', '/api/wallet/key', WalletStateSchema, { apiKey }),
  market: (): Promise<MarketView> => request('GET', '/api/market', MarketViewSchema),
  marketDraft: (): Promise<ListingDraft> => request('POST', '/api/market/listing-draft', ListingDraftSchema),
  marketRegister: (input: MarketRegister): Promise<MarketView> => request('POST', '/api/market/register', MarketViewSchema, input),
  marketToken: (handle: string, token: string): Promise<MarketView> => request('POST', '/api/market/token', MarketViewSchema, { handle, token }),
  companySettings: (): Promise<CompanySettings> => request('GET', '/api/company/settings', CompanySettingsSchema),
  setCompanySettings: (patch: CompanySettingsPatch): Promise<CompanySettings> => request('PATCH', '/api/company/settings', CompanySettingsSchema, patch),
  schedules: async (dept?: string): Promise<Schedule[]> => (await request('GET', `/api/schedules${dept ? `?departmentId=${encodeURIComponent(dept)}` : ''}`, ScheduleListSchema)).schedules,
  createSchedule: (dept: string, input: Partial<ScheduleCreate> & Pick<ScheduleCreate, 'name' | 'cron' | 'title' | 'objective'>): Promise<Schedule> => request('POST', `${d(dept)}/schedules`, ScheduleSchema, input),
  patchSchedule: (id: string, patch: SchedulePatch): Promise<Schedule> => request('PATCH', `/api/schedules/${encodeURIComponent(id)}`, ScheduleSchema, patch),
  deleteSchedule: async (id: string): Promise<void> => {
    const r = await fetch(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
    if (!r || !r.ok) throw new ApiError(r?.status ?? 0, 'error', 'Could not delete the schedule.');
  },
  runSchedule: (id: string): Promise<Schedule> => request('POST', `/api/schedules/${encodeURIComponent(id)}/run`, ScheduleSchema),
  questRequests: async (): Promise<QuestRequestView[]> => (await request('GET', '/api/quest-requests', QuestRequestListSchema)).requests,
  approveRequest: (id: string): Promise<QuestRequestView> => request('POST', `/api/quest-requests/${encodeURIComponent(id)}/approve`, QuestRequestViewSchema),
  rejectRequest: (id: string): Promise<QuestRequestView> => request('POST', `/api/quest-requests/${encodeURIComponent(id)}/reject`, QuestRequestViewSchema),
  questOrigins: async (): Promise<QuestOrigin[]> => (await request('GET', '/api/quest-origins', QuestOriginListSchema)).origins,
  assistant: (): Promise<AssistantView> => request('GET', '/api/assistant', AssistantViewSchema),
  assistantModels: (): Promise<ChiefOfStaffModels> => request('GET', '/api/assistant/models', ChiefOfStaffModelsSchema),
  departmentDraft: (messages: { from: 'user' | 'agent'; text: string }[]): Promise<DeptDraftReply> => request('POST', '/api/assistant/department-draft', DeptDraftReplySchema, { messages }),
  hiringCurrent: async (): Promise<HiringRequestView | null> => (await request('GET', '/api/hiring/current', HiringCurrentSchema)).request,
  hiringStart: (departmentId?: string): Promise<HiringRequestView> => request('POST', '/api/hiring/requests', HiringRequestViewSchema, departmentId ? { departmentId } : {}),
  hiring: (id: string): Promise<HiringRequestView> => request('GET', h(id), HiringRequestViewSchema),
  hiringAnswer: (id: string): Promise<HiringRequestView> => request('POST', `${h(id)}/answer`, HiringRequestViewSchema),
  hiringDecline: (id: string): Promise<HiringRequestView> => request('POST', `${h(id)}/decline`, HiringRequestViewSchema),
  hiringChat: (id: string, message: string): Promise<HiringRequestView> => request('POST', `${h(id)}/chat`, HiringRequestViewSchema, { message }),
  hiringBrief: (id: string, brief?: Omit<HiringBrief, 'departmentName'>): Promise<HiringRequestView> => request('POST', `${h(id)}/brief`, HiringRequestViewSchema, brief ? { brief } : {}),
  interviewHistory: (id: string, cand: string): Promise<ChatMessage[]> => request('GET', `${h(id)}/candidates/${encodeURIComponent(cand)}/interview`, InterviewHistorySchema),
  interview: (id: string, cand: string, message: string): Promise<InterviewReply> => request('POST', `${h(id)}/candidates/${encodeURIComponent(cand)}/interview`, InterviewReplySchema, { message }),
  hiringOffer: (id: string, candidateId: string, acceptConcerns = false): Promise<HiringRequestView> => request('POST', `${h(id)}/offer`, HiringRequestViewSchema, { candidateId, acceptConcerns }),
  chat: (dept: string, agentKey: string, input: ChatSend): Promise<ChatReply> => request('POST', `${d(dept)}/characters/${encodeURIComponent(agentKey)}/chat`, ChatReplySchema, input),
  chatStream: (dept: string, agentKey: string, input: ChatSend, onProgress: (p: ChatProgress) => void): Promise<ChatReply> =>
    chatStream(`${d(dept)}/characters/${encodeURIComponent(agentKey)}/chat/stream`, input, onProgress),
  cancellation: (dept: string, quest: string): Promise<CancellationStatus> => request('GET', `${q(dept, quest)}/cancellation`, CancellationStatusSchema),
};

/** One agent turn over Server-Sent Events: `onProgress` while the agent works (tools can take minutes), then the reply. */
async function chatStream(path: string, input: ChatSend, onProgress: (p: ChatProgress) => void): Promise<ChatReply> {
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(input) });
  } catch {
    throw new ApiError(0, 'backend_unreachable', 'The Vibe City backend is not reachable.');
  }
  if (!res.ok || !res.body) throw errorFrom(res.status, await res.json().catch(() => undefined));
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n/g, '\n');
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1]?.trim();
      const raw = /^data: (.*)$/m.exec(frame)?.[1];
      if (!event || raw === undefined) continue;
      const data: unknown = (() => { try { return JSON.parse(raw); } catch { return undefined; } })();
      if (event === 'progress') { const p = ChatProgressSchema.safeParse(data); if (p.success) onProgress(p.data); }
      else if (event === 'error') throw errorFrom(typeof (data as { status?: unknown })?.status === 'number' ? (data as { status: number }).status : 500, data);
      else if (event === 'reply') {
        const r = ChatReplySchema.safeParse(data);
        if (!r.success) throw new ApiError(200, 'invalid_response', 'The backend sent a reply this app does not understand.');
        return r.data;
      }
    }
  }
  throw new ApiError(0, 'stream_ended', 'The connection closed before the agent answered. The reply will appear when you reopen the chat.');
}

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
