import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ZodError, type ZodType } from 'zod';
import {
  CompanyViewSchema, DEPARTMENT_ID_RE, DepartmentCreateSchema, DepartmentUpdateSchema, DepartmentViewSchema,
  InventoryPatchSchema, InventorySchema,
} from '@vibe-city/shared';
import {
  EffectiveInventorySchema, HealthViewSchema, HermesDefaultsViewSchema, ProfilesViewSchema, ProvisioningStatusSchema,
} from '@vibe-city/shared';
import type { HermesRuntime } from './hermes/ports.ts';
import { HermesAuthError, HermesRejectedError, HermesUnavailableError } from './hermes/ports.ts';
import { Readable } from 'node:stream';
import websocket from '@fastify/websocket';
import {
  CancellationStatusSchema, DepartmentArchivedSchema, DepartmentListSchema, LiveMessageSchema, QuestActivitySchema, QuestCreateSchema,
  QuestCreatedSchema, QuestDetailSchema, QuestListSchema, QuestResultsSchema, QuestTasksSchema, ReconcileResultSchema,
} from '@vibe-city/shared';
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
import { ConflictError, InvalidInputError, NotFoundError } from './domain/errors.ts';

const parse = <T>(schema: ZodType<T>, v: unknown): T => schema.parse(v);

export interface AppServices {
  app: FastifyInstance;
  provisioning: ProvisioningService;
  quests: QuestService;
  hub: LiveHub | null;
}

export interface ServicesExtra {
  kanban?: KanbanApi;
  /** Hermes event stream settings. Omit to disable live events (the WebSocket route then answers 503). */
  live?: Pick<BoardStreamDeps, 'wsBaseUrl' | 'sessionToken'> & Partial<BoardStreamDeps> & { graceMs?: number };
  /** Origins allowed to open the live WebSocket (browsers always send Origin). Requests without Origin are allowed. */
  allowedOrigins?: string[];
  /** Built web app (apps/web/dist). When set, the backend serves it on the same origin as the API. */
  webDist?: string;
}

/** `hermes` is optional so Milestone 1 callers (and tests) keep working: Hermes routes then answer 503. */
export function buildApp(db: DatabaseSync, hermes?: HermesRuntime): FastifyInstance {
  return buildServices(db, hermes).app;
}

export function buildServices(db: DatabaseSync, hermes?: HermesRuntime, extra: ServicesExtra = {}): AppServices {
  const company = new CompanyService(db);
  const c = company.ensureCompany();
  const departments = new DepartmentService(db, c.id);
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
  const runtime = hermes ?? unconfiguredHermes;
  const hub = extra.live
    ? new LiveHub({ health: () => runtime.health(), cursors: new SqliteCursorStore(db), ...extra.live }, { graceMs: extra.live.graceMs })
    : null;
  const allowedOrigins = extra.allowedOrigins ?? ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4100', 'http://localhost:4100'];

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'invalid_request',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof InvalidInputError) return reply.code(400).send({ error: 'invalid_request', message: err.message });
    if (err instanceof NotFoundError) return reply.code(404).send({ error: 'not_found', message: err.message });
    if (err instanceof HermesUnavailableError) return reply.code(503).send({ error: 'hermes_unavailable', message: err.message });
    if (err instanceof HermesAuthError) return reply.code(502).send({ error: 'hermes_auth', message: err.message });
    if (err instanceof HermesRejectedError) return reply.code(502).send({ error: 'hermes_rejected', message: err.message });
    if (err instanceof ConflictError) return reply.code(409).send({ error: 'conflict', message: err.message });
    const fe = err as { statusCode?: number; message?: string };
    if (fe.statusCode && fe.statusCode < 500) return reply.code(fe.statusCode).send({ error: 'bad_request', message: fe.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal_error' });
  });

  const idOf = (params: unknown): string => {
    const id = (params as { id: string }).id;
    if (!DEPARTMENT_ID_RE.test(id)) throw new NotFoundError('department not found');
    return id;
  };

  app.get('/api/company', async () => parse(CompanyViewSchema, company.view()));

  app.get('/api/departments', async (req) => {
    const q = req.query as { includeArchived?: string };
    return parse(DepartmentListSchema, { departments: departments.list({ includeArchived: q.includeArchived === 'true' }) });
  });

  app.post('/api/departments', async (req, reply) => {
    const dept = departments.create(parse(DepartmentCreateSchema, req.body));
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

  app.post('/api/runtime/reconcile', async () => parse(ReconcileResultSchema, { departments: await provisioning.reconcileAll() }));

  app.post('/api/departments/:id/provision', async (req) => {
    const id = idOf(req.params);
    return parse(ProvisioningStatusSchema, await provisioning.provision(id));
  });

  app.post('/api/departments/:id/provision/retry', async (req) => {
    const id = idOf(req.params);
    return parse(ProvisioningStatusSchema, await provisioning.retry(id));
  });

  app.get('/api/departments/:id/provisioning', async (req) => {
    const id = idOf(req.params);
    return parse(ProvisioningStatusSchema, provisioning.status(id));
  });

  app.get('/api/departments/:id/profiles', async (req) => {
    const id = idOf(req.params);
    return parse(ProfilesViewSchema, await provisioning.profiles(id));
  });

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
    const created = await quests_.create(idOf(req.params), parse(QuestCreateSchema, req.body));
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
      if (!board) return reject(1008, 'department is not provisioned');
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

  return { app, provisioning, quests: quests_, hub };
}
