import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ZodError, type ZodType } from 'zod';
import {
  CompanyRenameSchema, CompanyViewSchema, DEFAULT_CHAT_MODEL, DEPARTMENT_ID_RE, DepartmentCreateSchema, templateById, DepartmentUpdateSchema, DepartmentViewSchema,
  InventoryPatchSchema, InventorySchema, ChatSessionIdSchema, HERMES_TASK_ID_RE, TaskAnswerSchema, TaskStepsViewSchema,
} from '@vibe-city/shared';
import {
  AgentViewSchema, EffectiveInventorySchema, HealthViewSchema, HermesDefaultsViewSchema, HermesModelsViewSchema, ProfilesViewSchema, ProvisioningStatusSchema, SyncCheckSchema,
} from '@vibe-city/shared';
import type { HermesRuntime } from './hermes/ports.ts';
import { HermesAuthError, HermesRejectedError, HermesUnavailableError } from './hermes/ports.ts';
import { Readable } from 'node:stream';
import websocket from '@fastify/websocket';
import {
  CancellationStatusSchema, DepartmentArchivedSchema, DepartmentListSchema, LiveMessageSchema, QuestActivitySchema, QuestCreateSchema,
  QuestCreatedSchema, QuestDetailSchema, QuestListSchema, QuestResultsSchema, QuestTasksSchema, ReconcileResultSchema, TEMPLATES,
} from '@vibe-city/shared';
import { ChiefOfStaffModelsSchema } from '@vibe-city/shared';
import { z } from 'zod';
import type { KanbanApi } from './hermes/kanbanApi.ts';
import { QuestService } from './domain/questService.ts';
import { safeFilename } from './domain/scrub.ts';
import { LiveHub } from './live/hub.ts';
import type { BoardStreamDeps } from './live/boardStream.ts';
import { SqliteCursorStore } from './live/cursorStore.ts';
import { ProvisioningService } from './domain/provisioningService.ts';
import { CompanyService } from './domain/companyService.ts';
import { DepartmentService } from './domain/departmentService.ts';
import { ConflictError, InvalidInputError, NotFoundError, UpstreamError } from './domain/errors.ts';
import { AGENT_KEY_RE, AgentPatchSchema, DepartmentAgentSchema, CharacterSchema, ChatHistorySchema, ChatReplySchema, ChatSendSchema } from '@vibe-city/shared';
import { CharacterService, chiefOfStaff } from './domain/characters.ts';
import { ChatService } from './domain/chatService.ts';
import type { AgentChat } from './hermes/agentChat.ts';
import { ModelFailedError, ModelUnavailableError, type ChatModel } from './model/chatModel.ts';
import { HiringService } from './domain/hiringService.ts';
import { dailyCredits, type ModelPrices, type PriceList } from './model/nearPrices.ts';
import { AssistantService } from './domain/assistantService.ts';
import { QuestRequestService } from './domain/questRequests.ts';
import { MCP_CHAT_SERVER_NAME, MCP_COS_TOOLS, MCP_FILE_TOOLS, MCP_SERVER_NAME, MCP_TOOLS, registerMcp } from './mcp/server.ts';
import { CHIEF_OF_STAFF, type MarketRegister } from '@vibe-city/shared';
import { ScheduleService } from './domain/scheduleService.ts';
import { register as registerTemplates } from './routes/templates.ts';
import { nearAiKey, readSettings, register as registerCompany, secret, writeSettings } from './routes/company.ts';
import { WalletService } from './domain/walletService.ts';
import { register as registerWallet } from './routes/wallet.ts';
import { aiKeyFor, register as registerAi } from './routes/ai.ts';
import { gameState, register as registerGame } from './routes/game.ts';
import { register as registerIpo } from './routes/ipo.ts';
import { register as registerMarket } from './routes/market.ts';
import { register as registerQuestFiles } from './routes/questFiles.ts';
import { register as registerEnv } from './routes/env.ts';
import { DepartmentEnvService } from './domain/departmentEnv.ts';
import { MarketService } from './domain/marketService.ts';
import { IpoService } from './domain/ipoService.ts';
import { DEFAULT_RPC, NearRpc, type NearReader } from './near/rpc.ts';
import { ScheduleCreateSchema, ScheduleListSchema, SchedulePatchSchema, ScheduleSchema } from '@vibe-city/shared';
import { QuestOriginListSchema, QuestPolicyPatchSchema, QuestPolicySchema, QuestRequestCreateSchema, QuestRequestListSchema, QuestRequestViewSchema } from '@vibe-city/shared';
import { AssistantViewSchema } from '@vibe-city/shared';
import {
  HiringCurrentSchema, HiringOfferSchema, HiringRequestViewSchema, HiringStartSchema,
  
} from '@vibe-city/shared';

const parse = <T>(schema: ZodType<T>, v: unknown): T => schema.parse(v);

export interface AppServices {
  app: FastifyInstance;
  provisioning: ProvisioningService;
  quests: QuestService;
  hub: LiveHub | null;
  /** Call tick() periodically (the server does every 30 s) to fire due schedules. */
  schedules: ScheduleService;
  db: DatabaseSync;
  departments: DepartmentService;
  /** The OutLayer company wallet (brief 03). */
  wallet: WalletService;
  /** Rewrites every department's secrets env (OutLayer key, market token) into its profiles (best effort; the next sync retries). */
  pushDepartmentEnv: () => Promise<void>;
  /** Lists a floor on the Agent Market and re-syncs it (skill + token). */
  listOnMarket: (input: MarketRegister) => Promise<void>;
  /** The Chief of Staff department (hidden template, created with the company). */
  chiefOfStaffId: string;
  /** The Agent Market (brief 02). Call tick() periodically (the server does every 45 s) to take and deliver jobs. */
  market: MarketService;
  /** The Chief of Staff's chat model (checks a NEAR AI key and model before the settings route saves them). */
  chatModel: ChatModel;
  /** NEAR AI Cloud's priced model list, when configured: the models the Chief of Staff may use. */
  modelPrices: ModelPrices | null;
  /** The model the Chief of Staff uses until the CEO picks one. */
  chatModelDefault: string;
  /** Each floor's own env variables (write-only), pushed into its agents' profiles. */
  deptEnv: DepartmentEnvService;
  aiProxy: ServicesExtra['aiProxy'] | null;
  /** The IPO (brief 06): DAO, city token, revenue share proposals, signed by the company wallet. */
  ipo: IpoService;
}

export interface ServicesExtra {
  kanban?: KanbanApi;
  /** OutLayer's HTTP API (tests pass a fake). */
  outlayerFetch?: typeof fetch;
  /** market.near.ai's HTTP API (tests pass a fake) and its base URL (default https://market.near.ai). */
  marketFetch?: typeof fetch;
  marketBaseUrl?: string;
  /** Hermes event stream settings. Omit to disable live events (the WebSocket route then answers 503). */
  live?: Pick<BoardStreamDeps, 'wsBaseUrl' | 'sessionToken'> & Partial<BoardStreamDeps> & { graceMs?: number };
  /** Origins allowed to open the live WebSocket (browsers always send Origin). Requests without Origin are allowed. */
  allowedOrigins?: string[];
  /** Built web app (apps/web/dist). When set, the backend serves it on the same origin as the API. */
  webDist?: string;
  /** Chat model for the Chief of Staff (hiring and floor drafting) (NEAR AI Cloud in the container). Omit: those answer 503 model_unavailable. */
  chatModel?: ChatModel;
  /** The gateway API server, for the dialogue window's chat with an agent's own Hermes profile. Omit: agent chat answers 503. */
  agentChat?: AgentChat;
  /** The metering proxy (brief 04): agents call NEAR AI Cloud through `<publicUrl>/ai/v1` with a per-floor key, and the
      backend forwards to `upstreamUrl` with the company key. Omit: agents hold the company key and nothing is metered. */
  aiProxy?: { publicUrl: string; upstreamUrl: string; fetch?: typeof fetch };
  /** Variables each agent profile needs in its .env to answer through the gateway (e.g. NEAR_AI_API_KEY from the
      backend env). A NEAR AI key pasted in the game takes precedence over this one. */
  agentEnv?: Record<string, string>;
  /** The Chief of Staff's model until the CEO picks one (NEAR_AI_MODEL / CHAT_MODEL in the container). */
  chatModelDefault?: string;
  /** URL Hermes uses to reach the Vibe City MCP server. Set: every provisioned agent gets it in its config. */
  mcpUrl?: string;
  /** NEAR AI Cloud model prices for AR's shortlist. Omit: costs are guessed from model names. */
  modelPrices?: ModelPrices;
  /** What the IPO reads from NEAR (the offline demo passes a fake chain). Default: mainnet RPC. */
  nearRpc?: NearReader;
}

/** `hermes` is optional so Milestone 1 callers (and tests) keep working: Hermes routes then answer 503. */
export function buildApp(db: DatabaseSync, hermes?: HermesRuntime): FastifyInstance {
  return buildServices(db, hermes).app;
}

/** The Chief of Staff's model when neither the CEO nor the env chose one (the container's NEAR_AI_MODEL default). */
export { DEFAULT_CHAT_MODEL };

/** The game state as the Chief of Staff reads it: CEO quests, money and what waits on the CEO. Estimates stay labelled. */
function companyStatus(g: Awaited<ReturnType<typeof gameState>>): string {
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`, main = g.quests.filter((q) => !q.side), next = main.find((q) => !q.done), r = g.runway;
  return [
    `CEO quests: ${main.filter((q) => q.done).length} of ${main.length} done.${next ? ` Next: "${next.title}" (${next.hint})` : ' All done.'}`,
    `Side quests open: ${g.quests.filter((q) => q.side && !q.done).map((q) => q.title).join(', ') || 'none'}.`,
    `Money (estimates): earned ${usd(r.earnedCents)}, AI burn ${usd(r.dailyBurnCents)} a day, credits left ${r.creditsRemainingCents === null ? 'unknown (the boss has not said what is on the NEAR AI account)' : usd(r.creditsRemainingCents)}, runway ${r.days === null ? 'unknown' : `${r.days} days`}.`,
    `Waiting on the boss: ${g.decisions.map((d) => `${d.title} [${d.kind}]`).join('; ') || 'nothing'}.`,
  ].join('\n');
}

export function buildServices(db: DatabaseSync, hermes?: HermesRuntime, extra: ServicesExtra = {}): AppServices {
  /** What every agent profile gets for NEAR AI Cloud: the key pasted in the first quest, else the backend env's. */
  const aiEnv = (deptId: string): Record<string, string> => {
    const key = nearAiKey(db, extra.agentEnv?.NEAR_AI_API_KEY);
    // behind the metering proxy a floor holds its own pseudo key, never the company's
    return { ...extra.agentEnv, ...(key ? { NEAR_AI_API_KEY: extra.aiProxy ? aiKeyFor(db, deptId) : key } : {}) };
  };
  const company = new CompanyService(db);
  const c = company.ensureCompany();
  const departments = new DepartmentService(db, c.id);
  // The Chief of Staff is a department of the company from day one (hidden template): a Hermes profile the CEO talks
  // to in the dialogue window. server.ts syncs it with Hermes; the web keeps it out of the tower.
  const existingChief = departments.list({ includeHidden: true }).find((d) => d.templateId === CHIEF_OF_STAFF);
  const chiefOfStaffId = (existingChief ?? departments.create(DepartmentCreateSchema.parse({ name: 'Chief of Staff', template: CHIEF_OF_STAFF }), true)).id;
  // one person: the department's lead is the same Chief of Staff who drafts floors and runs hiring
  if (!existingChief) new CharacterService(db).save(chiefOfStaffId, 'chief', chiefOfStaff(c.id));
  const app = Fastify({ logger: false });
  const unconfiguredHermes: HermesRuntime = new Proxy({} as HermesRuntime, {
    get: () => async () => { throw new HermesUnavailableError('Hermes integration is not configured'); },
  });
  const provisioning = new ProvisioningService(db, departments, hermes ?? unconfiguredHermes);
  provisioning.recoverInterrupted();
  const unconfiguredKanban: KanbanApi = new Proxy({} as KanbanApi, {
    get: () => async () => { throw new HermesUnavailableError('Hermes integration is not configured'); },
  });
  const quests_ = new QuestService(departments, extra.kanban ?? unconfiguredKanban);
  const deptEnv = new DepartmentEnvService(db, departments, hermes);
  const runtime = hermes ?? unconfiguredHermes;
  const hub = extra.live
    ? new LiveHub({ health: () => runtime.health(), cursors: new SqliteCursorStore(db), ...extra.live }, { graceMs: extra.live.graceMs })
    : null;
  const allowedOrigins = extra.allowedOrigins ?? ['http://127.0.0.1:4200', 'http://localhost:4200', 'http://127.0.0.1:4100', 'http://localhost:4100'];

  /** The documented error body for a thrown error, or null for an unexpected one (logged, answered as 500). */
  const errorBody = (err: unknown): { status: number; body: Record<string, unknown> } | null => {
    if (err instanceof ZodError) {
      return { status: 400, body: { error: 'invalid_request', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } };
    }
    if (err instanceof InvalidInputError) return { status: 400, body: { error: 'invalid_request', message: err.message } };
    if (err instanceof NotFoundError) return { status: 404, body: { error: 'not_found', message: err.message } };
    if (err instanceof HermesUnavailableError) return { status: 503, body: { error: 'hermes_unavailable', message: err.message } };
    if (err instanceof HermesAuthError) return { status: 502, body: { error: 'hermes_auth', message: err.message } };
    if (err instanceof HermesRejectedError) return { status: 502, body: { error: 'hermes_rejected', message: err.message } };
    if (err instanceof ConflictError) return { status: 409, body: { error: 'conflict', message: err.message } };
    if (err instanceof UpstreamError) return { status: 502, body: { error: 'upstream', message: err.message } };
    if (err instanceof ModelUnavailableError) return { status: 503, body: { error: 'model_unavailable', message: err.message } };
    if (err instanceof ModelFailedError) return { status: 502, body: { error: 'model_failed', message: err.message } };
    const fe = err as { statusCode?: number; message?: string };
    if (fe.statusCode && fe.statusCode < 500) return { status: fe.statusCode, body: { error: 'bad_request', message: fe.message } };
    return null;
  };
  app.setErrorHandler((err, _req, reply) => {
    const e = errorBody(err);
    if (e) return reply.code(e.status).send(e.body);
    app.log.error(err);
    return reply.code(500).send({ error: 'internal_error' });
  });

  const idOf = (params: unknown): string => {
    const id = (params as { id: string }).id;
    if (!DEPARTMENT_ID_RE.test(id)) throw new NotFoundError('floor not found');
    return id;
  };

  app.get('/api/company', async () => parse(CompanyViewSchema, company.view()));
  app.patch('/api/company', async (req) => parse(CompanyViewSchema, company.rename(CompanyRenameSchema.parse(req.body).name)));

  app.get('/api/departments', async (req) => {
    const q = req.query as { includeArchived?: string; includeHidden?: string };
    return parse(DepartmentListSchema, { departments: departments.list({ includeArchived: q.includeArchived === 'true', includeHidden: q.includeHidden === 'true' }) });
  });

  app.post('/api/departments', async (req, reply) => {
    const input = parse(DepartmentCreateSchema, req.body);
    const dept = departments.create(input);
    // a template that runs on a loop gets one schedule, off until the CEO turns it on (brief 01)
    const t = input.template ? templateById(input.template) : null;
    if (t?.loop) schedules.create(dept.id, { name: t.name, cron: '0 9 * * *', timezone: 'UTC', title: `${t.name}: daily run`, objective: `Do today's work for ${t.name} as the department purpose describes, and report what you did.`, instructions: '', enabled: false });
    return reply.code(201).send(parse(DepartmentViewSchema, dept));
  });

  app.get('/api/departments/:id', async (req) => parse(DepartmentViewSchema, departments.get(idOf(req.params))));

  app.patch('/api/departments/:id', async (req) =>
    parse(DepartmentViewSchema, departments.update(idOf(req.params), parse(DepartmentUpdateSchema, req.body))));

  app.delete('/api/departments/:id', async (req) => {
    return parse(DepartmentArchivedSchema, departments.archive(idOf(req.params)));
  });

  app.get('/api/departments/:id/inventory', async (req) =>
    parse(InventorySchema, departments.getInventory(idOf(req.params))));

  app.patch('/api/departments/:id/inventory', async (req) =>
    parse(InventorySchema, departments.patchInventory(idOf(req.params), parse(InventoryPatchSchema, req.body))));

  // ---- Hermes provisioning (Milestone 2) ----

  app.get('/api/runtime/health', async () => parse(HealthViewSchema, await provisioning.health()));

  app.get('/api/runtime/defaults', async () => parse(HermesDefaultsViewSchema, await provisioning.hermesDefaults()));

  app.get('/api/runtime/models', async () => parse(HermesModelsViewSchema, await provisioning.hermesModels()));

  app.post('/api/runtime/reconcile', async () => parse(ReconcileResultSchema, { departments: await provisioning.reconcileAll() }));

  app.post('/api/departments/:id/provision', async (req) => {
    const id = idOf(req.params);
    return parse(ProvisioningStatusSchema, await provisioning.provision(id));
  });

  app.post('/api/departments/:id/provision/retry', async (req) => {
    const id = idOf(req.params);
    return parse(ProvisioningStatusSchema, await provisioning.retry(id));
  });

  app.post('/api/departments/:id/check', async (req) => parse(SyncCheckSchema, await provisioning.check(idOf(req.params))));

  app.get('/api/departments/:id/provisioning', async (req) => {
    const id = idOf(req.params);
    return parse(ProvisioningStatusSchema, provisioning.status(id));
  });

  app.get('/api/departments/:id/profiles', async (req) => {
    const id = idOf(req.params);
    return parse(ProfilesViewSchema, await provisioning.profiles(id));
  });

  app.get('/api/departments/:id/agents/:agentKey', async (req) => {
    const id = idOf(req.params);
    const key = (req.params as { agentKey?: string }).agentKey ?? '';
    if (!AGENT_KEY_RE.test(key)) throw new NotFoundError('agent not found');
    return parse(AgentViewSchema, await provisioning.agent(id, key));
  });

  app.get('/api/departments/:id/agents/:agentKey/tasks/:taskId/steps', async (req) => {
    const { agentKey = '', taskId = '' } = req.params as { agentKey?: string; taskId?: string };
    if (!AGENT_KEY_RE.test(agentKey)) throw new NotFoundError('agent not found');
    if (!HERMES_TASK_ID_RE.test(taskId)) throw new NotFoundError('task not found');
    return parse(TaskStepsViewSchema, await provisioning.taskSteps(idOf(req.params), agentKey, taskId));
  });

  app.patch('/api/departments/:id/agents/:agentKey', async (req) => {
    const id = idOf(req.params);
    const key = (req.params as { agentKey?: string }).agentKey ?? '';
    if (!AGENT_KEY_RE.test(key)) throw new NotFoundError('agent not found');
    return parse(DepartmentAgentSchema, departments.setAgentModel(id, key, parse(AgentPatchSchema, req.body).model));
  });

  app.delete('/api/departments/:id/agents/:agentKey', async (req) => {
    const id = idOf(req.params);
    const key = (req.params as { agentKey?: string }).agentKey ?? '';
    if (!AGENT_KEY_RE.test(key)) throw new NotFoundError('agent not found');
    departments.fireAgent(id, key);
    // Tell the rest of the team now rather than at the next 30 s check; firing itself never waits on Hermes.
    provisioning.reconcile(id).catch(() => undefined);
    return parse(DepartmentViewSchema, departments.get(id));
  });

  // ---- Characters and dialogue-window chat (feature spec 2.1, 2.2, 2.5) ----
  const noModel: ChatModel = { ready: false, complete: async () => { throw new ModelUnavailableError('No chat model is configured. Add your NEAR AI API key in the first quest.'); } };
  const characters = new CharacterService(db);
  const chat = new ChatService({
    db, departments, characters, hermes: runtime, companyName: () => company.view().name,
    ...(extra.kanban ? { kanban: extra.kanban } : {}),
    ...(extra.agentChat ? { agentChat: extra.agentChat } : {}),
    // `services` exists by the first chat
    companyStatus: async () => companyStatus(await gameState(services)),
    floorKit: () => assistant.floorKit(), // built further down; called per chat turn
    hiringFacts: () => hiring.facts(), // built further down too
    hiringOpen: () => hiring.isOpen(),
    listable: () => assistant.listable(),
    agentEnv: (profile) => aiEnv((db.prepare('SELECT department_id AS id FROM department_agent WHERE profile_ref = ?').get(profile) as { id: string } | undefined)?.id ?? ''),
  });
  /** `?session=<Hermes session id>` or `?session=new`; absent = the agent's last chat. */
  const sessionOf = (query: unknown): string | undefined => {
    const s = (query as { session?: unknown }).session;
    return s === undefined || s === 'new' ? s : parse(ChatSessionIdSchema, s);
  };
  const agentKeyOf = (params: unknown): string => {
    const key = (params as { agentKey?: string }).agentKey ?? '';
    if (!AGENT_KEY_RE.test(key)) throw new NotFoundError('agent not found');
    return key;
  };
  app.get('/api/departments/:id/characters/:agentKey', async (req) =>
    parse(CharacterSchema, chat.character(idOf(req.params), agentKeyOf(req.params))));
  app.get('/api/departments/:id/characters/:agentKey/chat', async (req) =>
    parse(ChatHistorySchema, await chat.history(idOf(req.params), agentKeyOf(req.params), sessionOf(req.query))));
  app.post('/api/departments/:id/characters/:agentKey/chat', async (req) =>
    parse(ChatReplySchema, await chat.send(idOf(req.params), agentKeyOf(req.params), parse(ChatSendSchema, req.body))));
  /** Same turn as POST .../chat, as Server-Sent Events: `progress` (thinking, tool use, waiting for an approval) while the
      agent works, then `reply` (a ChatReply) or `error` (the usual error body plus `status`). A tool-using turn can take
      minutes; closing the stream does not stop the agent, and the reply still lands in the history. */
  app.post('/api/departments/:id/characters/:agentKey/chat/stream', async (req, reply) => {
    const id = idOf(req.params), key = agentKeyOf(req.params), input = parse(ChatSendSchema, req.body);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (event: string, data: unknown) => { if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const ping = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n'); }, 15_000);
    try {
      send('reply', parse(ChatReplySchema, await chat.send(id, key, input, (e) => send('progress', e))));
    } catch (err) {
      const e = errorBody(err);
      if (!e) app.log.error(err);
      send('error', e ? { status: e.status, ...e.body } : { status: 500, error: 'internal_error' });
    } finally {
      clearInterval(ping);
      res.end();
    }
  });

  // ---- AR: scouting and hiring (feature spec 7.1) ----
  const hiring = new HiringService({
    db, departments, provisioning, quests: (id) => quests_.list(id), model: extra.chatModel ?? noModel,
    companyId: () => company.view().id, companyName: () => company.view().name,
    savePersona: (d, k, c) => characters.save(d, k, c),
    ...(extra.modelPrices ? { prices: extra.modelPrices } : {}),
  });
  const reqId = (params: unknown) => (params as { reqId: string }).reqId;
  app.get('/api/hiring/current', async () => parse(HiringCurrentSchema, { request: await hiring.current() }));
  // the brief comes from the Chief of Staff's chat: the request is created with its candidates
  app.post('/api/hiring/requests', async (req, reply) => {
    const { brief } = parse(HiringStartSchema, req.body ?? {});
    idOf({ id: brief.departmentId });
    return reply.code(201).send(parse(HiringRequestViewSchema, await hiring.create(brief)));
  });
  app.get('/api/hiring/requests/:reqId', async (req) => parse(HiringRequestViewSchema, hiring.get(reqId(req.params))));
  // answering or declining the call closes it: the talk itself is the Chief of Staff's chat
  app.post('/api/hiring/requests/:reqId/decline', async (req) => parse(HiringRequestViewSchema, hiring.decline(reqId(req.params))));
  app.post('/api/hiring/requests/:reqId/offer', async (req) => {
    const body = parse(HiringOfferSchema, req.body);
    return parse(HiringRequestViewSchema, await hiring.offer(reqId(req.params), body.candidateId, body.acceptConcerns));
  });

  // ---- executive assistant: draft a new floor in the dialogue window (feature spec 4.3) ----
  const assistant = new AssistantService({
    departments, provisioning,
    ...(extra.modelPrices ? { prices: extra.modelPrices } : {}),
    companyId: () => company.view().id,
    isListed: (id) => market.isListed(id), // market is built further down; called per request
  });
  app.get('/api/assistant', async () => parse(AssistantViewSchema, { character: assistant.character(), modelReady: (extra.chatModel ?? noModel).ready }));
  // The models the Chief of Staff may think with (NEAR AI's priced list, cheapest per day first) and the one in use.
  app.get('/api/assistant/models', async () => {
    const list = extra.modelPrices ? await extra.modelPrices.list().catch(() => new Map() as PriceList) : new Map() as PriceList;
    const chosen = readSettings(db).chiefOfStaffModel;
    return parse(ChiefOfStaffModelsSchema, {
      current: chosen ?? extra.chatModelDefault ?? DEFAULT_CHAT_MODEL, chosen: !!chosen,
      models: [...list].sort(([, a], [, b]) => dailyCredits(a) - dailyCredits(b))
        .map(([id, p]) => ({ id, inPerM: Math.round(p.inPerM * 100) / 100, outPerM: Math.round(p.outPerM * 100) / 100, context: p.context, privacy: p.privacy ?? null, icon: p.icon ?? null })),
    });
  });

  // ---- quests between departments + the Vibe City MCP server (feature spec 2.4) ----
  const questRequests = new QuestRequestService({
    db, departments, createQuest: (id, input) => quests_.create(id, input), listQuests: (id) => quests_.list(id),
  });
  /** Lists a floor on the market (the Chief of Staff's list_on_market tool, and POST /api/market/register): register,
      then re-sync the floor so its profiles get the marketplace-worker skill and the token (writeDepartmentEnv below). */
  const listOnMarket = async (input: MarketRegister) => {
    await market.register(input);
    try { await provisioning.provision(input.departmentId); } catch { /* Hermes away: the next sync applies the skill and the token */ }
  };
  registerMcp(app, {
    requests: questRequests, questDetail: (d, q) => quests_.detail(d, q), files: quests_,
    chiefOfStaffId, departments, listOnMarket,
  });
  // Secrets a floor's agents get in their profile .env: company-wallet floors (by template) get the OutLayer wallet key, the listed floor the Agent Market token (marketplace-worker). Written after every sync that changed something and whenever
  // the CEO pastes a wallet key; other floors never receive them.
  const wallet = new WalletService(db, extra.outlayerFetch);
  const writeDepartmentEnv = async (deptId: string, profiles: string[]) => {
    const at = new Date().toISOString();
    const t = TEMPLATES.find((x) => x.id === departments.getRow(deptId).template_id);
    const mkt = market.tokenFor(deptId);
    // every agent thinks with NEAR AI Cloud: the key (pasted in the first quest, else the backend env) goes to all floors
    // the floor's own variables first: a name Vibe City manages always keeps Vibe City's value
    const env = { ...deptEnv.values(deptId), ...aiEnv(deptId), ...(mkt ? { MARKET_AGENT_TOKEN: mkt } : {}), ...(t?.wallet === 'company' ? wallet.env() : null) };
    if (!Object.keys(env).length || !hermes?.setProfileEnv) return;
    if (extra.aiProxy && hermes.setProviderBaseUrl) for (const p of profiles) await hermes.setProviderBaseUrl(p, 'near-ai', `${extra.aiProxy.publicUrl}/ai/v1`);
    for (const p of profiles) await hermes.setProfileEnv(p, env);
    if (profiles.length) deptEnv.markApplied(deptId, at);
    // the `market` quest: a listed floor's agents hold its token
    if (mkt && profiles.length) market.markTokenApplied(deptId, at);
  };
  const pushDepartmentEnv = async () => {
    for (const d of departments.list({ includeHidden: true })) {
      const profiles = departments.agents(d.id).map((a) => a.profile_ref).filter((p): p is string => !!p);
      try { await writeDepartmentEnv(d.id, profiles); } catch (e) { console.warn(`secrets env not written for ${d.id}: ${(e as Error).message}`); }
    }
  };
  provisioning.afterProvision = writeDepartmentEnv;
  if (extra.mcpUrl && hermes?.setMcpServer) {
    const url = extra.mcpUrl, rt = hermes;
    provisioning.afterProvision = async (deptId, profiles) => {
      // One token per department, shared by its agents (issuing rotates it, so every profile gets the new one).
      const token = questRequests.issueToken(deptId);
      const headers = { Authorization: `Bearer ${token}` };
      // chat only reads, except the Chief of Staff's, which lists a floor on the market from the dialogue window
      const chatTools = deptId === chiefOfStaffId ? [...MCP_FILE_TOOLS, ...MCP_COS_TOOLS] : [...MCP_FILE_TOOLS];
      for (const p of profiles) {
        await rt.setMcpServer!(p, MCP_SERVER_NAME, { url, headers, tools: { include: [...MCP_TOOLS] } });
        await rt.setMcpServer!(p, MCP_CHAT_SERVER_NAME, { url, headers, tools: { include: chatTools } });
        // Naming the read-only entry makes chat's list an allowlist: chat reads task files but gets no request_quest.
        await rt.setPlatformMcpServers?.(p, 'api_server', [MCP_CHAT_SERVER_NAME]);
      }
      await writeDepartmentEnv(deptId, profiles);
    };
  }

  // ---- schedules (feature spec 8): the backend creates the quests, Hermes cron stays off ----
  const schedules = new ScheduleService({
    db, departments, createQuest: (id, input) => quests_.create(id, input),
    recordOrigin: (deptId, questId, scheduleId) => questRequests.recordOrigin(deptId, questId, 'schedule', { departmentId: deptId, requestId: scheduleId }),
  });
  const schedId = (params: unknown) => (params as { schedId: string }).schedId;
  app.get('/api/schedules', async (req) => {
    const q = req.query as { departmentId?: string };
    return parse(ScheduleListSchema, { schedules: schedules.list(q.departmentId) });
  });
  app.post('/api/departments/:id/schedules', async (req, reply) => reply.code(201).send(parse(ScheduleSchema, schedules.create(idOf(req.params), parse(ScheduleCreateSchema, req.body)))));
  app.patch('/api/schedules/:schedId', async (req) => parse(ScheduleSchema, schedules.update(schedId(req.params), parse(SchedulePatchSchema, req.body))));
  app.delete('/api/schedules/:schedId', async (req, reply) => { schedules.remove(schedId(req.params)); return reply.code(204).send(); });
  app.post('/api/schedules/:schedId/run', async (req) => parse(ScheduleSchema, await schedules.runNow(schedId(req.params))));

  app.get('/api/quest-requests', async () => parse(QuestRequestListSchema, { requests: questRequests.list() }));
  /** For the CEO (and tests): file a request on behalf of a department, through the same guardrails. */
  app.post('/api/quest-requests', async (req, reply) => {
    const b = parse(QuestRequestCreateSchema, req.body);
    idOf({ id: b.fromDepartmentId });
    return reply.code(201).send(parse(QuestRequestViewSchema, await questRequests.request(b)));
  });
  app.post('/api/quest-requests/:reqId/approve', async (req) => parse(QuestRequestViewSchema, await questRequests.approve((req.params as { reqId: string }).reqId)));
  app.post('/api/quest-requests/:reqId/reject', async (req) => parse(QuestRequestViewSchema, questRequests.reject((req.params as { reqId: string }).reqId)));
  app.get('/api/quest-origins', async () => parse(QuestOriginListSchema, { origins: questRequests.origins() }));
  app.get('/api/departments/:id/quest-policy', async (req) => parse(QuestPolicySchema, questRequests.policy(idOf(req.params))));
  app.patch('/api/departments/:id/quest-policy', async (req) => parse(QuestPolicySchema, questRequests.setPolicy(idOf(req.params), parse(QuestPolicyPatchSchema, req.body))));

  app.get('/api/departments/:id/effective-inventory', async (req) => {
    const id = idOf(req.params);
    return parse(EffectiveInventorySchema, provisioning.effectiveInventory(id));
  });

  // ---- Quests (Milestone 3): Hermes Kanban is the source of truth; nothing here is stored in SQLite ----

  const questParams = (params: unknown) => ({ dept: idOf(params), quest: (params as { questId: string }).questId });

  app.get('/api/departments/:id/quests', async (req) => {
    return parse(QuestListSchema, { quests: await quests_.list(idOf(req.params)) });
  });

  app.post('/api/departments/:id/quests', async (req, reply) => {
    const id = idOf(req.params);
    const created = await quests_.create(id, parse(QuestCreateSchema, req.body));
    questRequests.recordOrigin(id, created.questId, 'user');
    return reply.code(201).send(parse(QuestCreatedSchema, created));
  });

  app.get('/api/departments/:id/quests/:questId', async (req) => {
    const { dept, quest } = questParams(req.params);
    return parse(QuestDetailSchema, await quests_.detail(dept, quest));
  });

  app.get('/api/departments/:id/quests/:questId/tasks', async (req) => {
    const { dept, quest } = questParams(req.params);
    const d = await quests_.detail(dept, quest);
    return parse(QuestTasksSchema, { questId: quest, tasks: d.tasks, violations: d.violations, truncated: d.truncated });
  });

  app.get('/api/departments/:id/quests/:questId/activity', async (req) => {
    const { dept, quest } = questParams(req.params);
    const limit = parse(z.coerce.number().int().min(1).max(1000).default(200), (req.query as { limit?: string }).limit);
    return parse(QuestActivitySchema, { questId: quest, events: await quests_.activity(dept, quest, limit) });
  });

  app.get('/api/departments/:id/quests/:questId/results', async (req) => {
    const { dept, quest } = questParams(req.params);
    return parse(QuestResultsSchema, await quests_.results(dept, quest));
  });

  app.get('/api/departments/:id/quests/:questId/attachments/:attachmentId', async (req, reply) => {
    const { dept, quest } = questParams(req.params);
    const aid = Number((req.params as { attachmentId: string }).attachmentId);
    const a = await quests_.openAttachment(dept, quest, aid);
    const name = safeFilename(a.filename);
    // Never trust the stored content type (an HTML attachment must not render in our origin): always a download.
    reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .header('content-security-policy', "default-src 'none'; sandbox");
    if (a.size >= 0) reply.header('content-length', String(a.size));
    if (!a.response.body) return reply.send(Buffer.alloc(0));
    return reply.send(Readable.fromWeb(a.response.body as import('node:stream/web').ReadableStream));
  });

  app.post('/api/departments/:id/quests/:questId/cancel', async (req, reply) => {
    const { dept, quest } = questParams(req.params);
    const status = await quests_.requestCancel(dept, quest);
    // 202: the request was accepted; `state` says whether Hermes has confirmed that everything stopped.
    return reply.code(202).send(parse(CancellationStatusSchema, status));
  });

  app.post('/api/departments/:id/quests/:questId/tasks/:taskId/answer', async (req) => {
    const { dept, quest } = questParams(req.params);
    const taskId = (req.params as { taskId?: string }).taskId ?? '';
    if (!HERMES_TASK_ID_RE.test(taskId)) throw new NotFoundError('task not found');
    await quests_.answer(dept, quest, taskId, parse(TaskAnswerSchema, req.body).message);
    return parse(QuestDetailSchema, await quests_.detail(dept, quest));
  });

  app.get('/api/departments/:id/quests/:questId/cancellation', async (req) => {
    const { dept, quest } = questParams(req.params);
    return parse(CancellationStatusSchema, await quests_.cancellationStatus(dept, quest));
  });

  // ---- Live events: browser <-> Vibe City only. The Hermes connection (and its token) stays server-side. ----

  app.register(websocket);
  app.register(async (inst) => {
    inst.get('/api/live', { websocket: true }, (socket, req) => {
      const reject = (code: number, reason: string) => { socket.close(code, reason); };
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) return reject(1008, 'origin not allowed');
      if (!hub) return reject(1013, 'live events are not configured');
      const raw = (req.query as { departmentId?: string }).departmentId ?? '';
      if (!DEPARTMENT_ID_RE.test(raw)) return reject(1008, 'invalid department');
      let board: string;
      try {
        board = departments.getRow(raw).hermes_board_ref ?? '';
      } catch {
        return reject(1008, 'unknown department');
      }
      if (!board) return reject(1008, 'floor is not synced with Hermes');
      const unsubscribe = hub.subscribe(raw, board, (m) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(parse(LiveMessageSchema, m)));
      });
      socket.on('close', unsubscribe);
      socket.on('error', unsubscribe);
    });
  });
  app.addHook('onClose', async () => { hub?.stopAll(); });

  // ---- Web app (optional): same origin as the API, so the browser never needs CORS or the Hermes address ----
  if (extra.webDist) {
    app.register(fastifyStatic, { root: resolve(extra.webDist), wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      // Client-side routes fall back to the app shell; unknown API paths and missing files (e.g. a stale hashed
      // chunk after a rebuild) stay a 404, so a browser never receives HTML in place of a script.
      const path = req.url.split('?')[0]!;
      if (req.method === 'GET' && !path.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(path)) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    });
  }

  const market = new MarketService({
    db, departments, createQuest: (id, input) => quests_.create(id, input), results: (id, q) => quests_.results(id, q),
    recordOrigin: (id, q) => questRequests.recordOrigin(id, q, 'market'),
    ...(extra.marketFetch ? { fetch: extra.marketFetch } : {}), ...(extra.marketBaseUrl ? { baseUrl: extra.marketBaseUrl } : {}),
  });
  const services: AppServices = {
    app, provisioning, quests: quests_, hub, schedules, db, departments, wallet, pushDepartmentEnv, market, listOnMarket, chiefOfStaffId,
    chatModel: extra.chatModel ?? noModel, modelPrices: extra.modelPrices ?? null, chatModelDefault: extra.chatModelDefault ?? DEFAULT_CHAT_MODEL, deptEnv, aiProxy: extra.aiProxy ?? null,
    ipo: new IpoService({
      db, wallet, rpc: extra.nearRpc ?? new NearRpc(DEFAULT_RPC.mainnet),
      walletAccount: () => readSettings(db).outlayerAccountId, companyName: () => company.view().name, nearUsd: () => wallet.nearUsd(),
    }),
  };
  // hackathon route modules (docs/briefs): one line each
  registerTemplates(app, services); registerCompany(app, services); registerWallet(app, services);
  registerAi(app, services); registerGame(app, services); registerIpo(app, services); registerMarket(app, services);
  registerQuestFiles(app, services); registerEnv(app, services);
  return services;
}
