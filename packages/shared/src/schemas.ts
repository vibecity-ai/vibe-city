import { z } from 'zod';

// ---- primitives -----------------------------------------------------------

const idList = (what: string) =>
  z.array(z.string().trim().min(1, `${what} entries must be non-empty`).max(200)).max(200)
    .transform((a) => [...new Set(a)]);

/** Built-in toolset names Hermes 0.22 lists in `hermes tools list` (verified list in HERMES_COMPATIBILITY.md). */
export const TOOLSETS = [
  'web', 'browser', 'terminal', 'file', 'code_execution', 'vision', 'video', 'image_gen', 'video_gen', 'x_search',
  'tts', 'stt', 'skills', 'todo', 'kanban', 'memory', 'context_engine', 'session_search', 'connections', 'clarify',
  'delegation', 'cronjob', 'computer_use',
] as const;
export const ToolsetSchema = z.enum(TOOLSETS);
export type Toolset = z.infer<typeof ToolsetSchema>;
/** Never given to a department agent: sub-agents and cron jobs run outside the department board, where Vibe City cannot see them. */
export const AGENT_EXCLUDED_TOOLSETS = ['delegation', 'cronjob'] as const;

export const MAX_WORKERS_CEILING = 10;

// ---- inventory ------------------------------------------------------------

const skillIds = idList('skill');
/** MCP tools in Hermes' `server:tool` notation, or a bare server id for the whole server. */
const mcpTools = idList('MCP tool');
/** One model as Hermes names it: the provider slug plus the model id within that provider. */
export const ModelChoiceSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  id: z.string().trim().min(1).max(200),
}).strict();
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;
/** Toolset-level permissions. Verified enforceable in Hermes for `terminal`, `file`, `web`, `browser`, `code_execution`. */
const toolsets = z.array(ToolsetSchema).max(TOOLSETS.length).transform((a) => [...new Set(a)]);
const contextRefs = idList('shared context ref');

export const InventorySchema = z.object({
  allowedSkillIds: skillIds.default([]),
  allowedMcpTools: mcpTools.default([]),
  /** The agents' default model, chosen from Hermes' list. Null = keep the profile's own default. */
  model: ModelChoiceSchema.nullable().default(null),
  allowedToolsets: toolsets.default([]),
  sharedContextRefs: contextRefs.default([]),
  limits: z.object({
    /**
     * 0 = no worker profile: the chief does the work itself. Above 0 a worker profile is provisioned; the number is a
     * REQUESTED limit (Hermes only has a host-wide per-profile cap, so it is not guaranteed per department).
     */
    maxConcurrentWorkers: z.number().int().min(0).max(MAX_WORKERS_CEILING).default(0),
    /** Per-task runtime cap passed to Hermes as max_runtime_seconds when tasks are created. */
    maxTaskRuntimeSeconds: z.number().int().min(10).max(86_400).nullable().default(null),
    maxDelegationDepth: z.literal(1).default(1),
  }).default({ maxConcurrentWorkers: 0, maxTaskRuntimeSeconds: null, maxDelegationDepth: 1 }),
}).strict();
export type Inventory = z.infer<typeof InventorySchema>;

/** PATCH body: any subset; `limits` is merged field-by-field by the service. */
export const InventoryPatchSchema = z.object({
  allowedSkillIds: skillIds.optional(),
  allowedMcpTools: mcpTools.optional(),
  model: ModelChoiceSchema.nullable().optional(),
  allowedToolsets: toolsets.optional(),
  sharedContextRefs: contextRefs.optional(),
  limits: z.object({
    maxConcurrentWorkers: z.number().int().min(0).max(MAX_WORKERS_CEILING),
    maxTaskRuntimeSeconds: z.number().int().min(10).max(86_400).nullable(),
    maxDelegationDepth: z.literal(1),
  }).partial().strict().optional(),
}).strict();
export type InventoryPatch = z.infer<typeof InventoryPatchSchema>;

// ---- workspace ------------------------------------------------------------

/**
 * Input: an absolute host path (accepted only server-side, never echoed back).
 * Output: opaque summary. `isolation` is always 'unverified' until a verified sandbox exists
 * (workspace paths are advisory with Hermes' local backend; see HERMES_COMPATIBILITY.md).
 */
export const WorkspaceInputSchema = z.string().trim().max(1024).nullable();
export const WorkspaceViewSchema = z.object({
  configured: z.boolean(),
  label: z.string().nullable(),
  isolation: z.enum(['unverified', 'verified']),
});
export type WorkspaceView = z.infer<typeof WorkspaceViewSchema>;

// ---- departments ----------------------------------------------------------

export const DEPARTMENT_STATES = ['unconfigured', 'provisioning', 'ready', 'error', 'disconnected'] as const;
export const BOARD_SYNC_STATES = ['not_provisioned', 'synced', 'error'] as const;

const name = z.string().trim().min(1, 'name is required').max(80);
const purpose = z.string().trim().max(2000);
const profileRef = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'invalid Hermes profile name').nullable();

export const DepartmentCreateSchema = z.object({
  name,
  purpose: purpose.default(''),
  workspace: WorkspaceInputSchema.optional(),
  inventory: InventoryPatchSchema.optional(),
}).strict();
export type DepartmentCreate = z.infer<typeof DepartmentCreateSchema>;

export const DepartmentUpdateSchema = z.object({
  name: name.optional(),
  purpose: purpose.optional(),
  workspace: WorkspaceInputSchema.optional(),
  chiefProfileRef: profileRef.optional(),
  workerProfileRef: profileRef.optional(),
  /**
   * Explicit consent to let Vibe City modify these EXISTING Hermes profiles (toolsets, skills, model, SOUL.md block).
   * Each entry must equal the department's current chief/worker ref. Replaces the previous confirmation list.
   */
  confirmModifyProfiles: z.array(z.string().trim().min(1)).max(2).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'at least one field is required');
export type DepartmentUpdate = z.infer<typeof DepartmentUpdateSchema>;

export const DepartmentViewSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  name: z.string(),
  purpose: z.string(),
  /** Stable creation-order identifier (never renumbered, never reused). Not the visual position. */
  floorOrder: z.number().int(),
  /** Visual position among active departments: 1 = directly below the Executive Office. Null when archived. */
  floorPosition: z.number().int().min(1).nullable(),
  state: z.enum(DEPARTMENT_STATES),
  workspace: WorkspaceViewSchema,
  chiefProfileRef: z.string().nullable(),
  workerProfileRef: z.string().nullable(),
  /** Deterministic slug derived from the immutable id; the board may not exist in Hermes yet. */
  hermesBoardSlug: z.string(),
  /** Null until the board has been synchronized with Hermes. */
  hermesBoardRef: z.string().nullable(),
  boardSyncState: z.enum(BOARD_SYNC_STATES),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type DepartmentView = z.infer<typeof DepartmentViewSchema>;

export const CompanyViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  executiveOffice: z.object({
    id: z.literal('executive-office'), name: z.string(), position: z.literal('top'), deletable: z.literal(false),
  }),
  /** Top-to-bottom: Executive Office first, then active departments, newest first. */
  floors: z.array(z.union([
    z.object({ kind: z.literal('executive') }),
    z.object({ kind: z.literal('department'), departmentId: z.string() }),
  ])),
}).strict();
export type CompanyView = z.infer<typeof CompanyViewSchema>;

export const DEPARTMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const boardSlugForDepartment = (id: string) => `vc-${id}`;

// ---- provisioning (Milestone 2) ---------------------------------------------

export const ProvisioningStateSchema = z.enum(DEPARTMENT_STATES);
export type ProvisioningState = z.infer<typeof ProvisioningStateSchema>;

export const PROVISIONING_STEPS = ['health', 'validate', 'board', 'chief', 'worker', 'inventory', 'verify'] as const;

export const ProvisioningErrorSchema = z.object({
  /** Machine-readable cause, e.g. hermes_unreachable, hermes_auth, profile_not_found, resource_missing. */
  code: z.string(),
  step: z.enum(PROVISIONING_STEPS),
  message: z.string(),
  /** true = temporary/availability problem or resumable; false = configuration must change first. */
  retryable: z.boolean(),
  at: z.string(),
}).strict();
export type ProvisioningError = z.infer<typeof ProvisioningErrorSchema>;

const ResourceStatusSchema = z.object({
  ref: z.string().nullable(),
  verified: z.boolean(),
  verifiedAt: z.string().nullable(),
  /** 'created' = Vibe City created it; 'associated' = an existing Hermes resource the user pointed at. */
  origin: z.enum(['created', 'associated']).nullable(),
  /** For associated profiles: whether the user confirmed that Vibe City may modify it. Null for created ones. */
  modificationConfirmed: z.boolean().nullable(),
}).strict();

export const ProvisioningStatusSchema = z.object({
  departmentId: z.string(),
  state: ProvisioningStateSchema,
  attempts: z.number().int(),
  error: ProvisioningErrorSchema.nullable(),
  board: ResourceStatusSchema,
  chief: ResourceStatusSchema,
  worker: ResourceStatusSchema,
  inventory: z.object({ applied: z.boolean(), appliedAt: z.string().nullable(), inSync: z.boolean() }).strict(),
  lastReconciledAt: z.string().nullable(),
}).strict();
export type ProvisioningStatus = z.infer<typeof ProvisioningStatusSchema>;

export const CAPABILITY_STATUSES = ['enforced', 'configured', 'unverified', 'unsupported'] as const;
/**
 * enforced    - applied, read back from Hermes, AND restriction behavior was tested against real Hermes
 * configured  - applied and read back, but runtime behavior is not tested
 * unverified  - not applied or not read back (no way to check in this installation)
 * unsupported - Hermes has no interface to enforce it
 */
export const CapabilityEntrySchema = z.object({
  capability: z.string(),
  requested: z.unknown(),
  effective: z.unknown(),
  status: z.enum(CAPABILITY_STATUSES),
  /**
   * true ONLY when status is 'enforced'. UIs must not present anything with guarantee=false as a security control
   * (workspace isolation and worker delegation depth are never guarantees).
   */
  guarantee: z.boolean(),
  detail: z.string(),
}).strict();
export type CapabilityEntry = z.infer<typeof CapabilityEntrySchema>;

export const RoleConfigSchema = z.object({
  role: z.enum(['chief', 'worker']),
  profileRef: z.string().nullable(),
  entries: z.array(CapabilityEntrySchema),
}).strict();
export type RoleConfig = z.infer<typeof RoleConfigSchema>;

export const EffectiveInventorySchema = z.object({
  departmentId: z.string(),
  /** Whether `observedAt` data came from a real read of Hermes; null before the first successful apply. */
  observedAt: z.string().nullable(),
  inSync: z.boolean(),
  chief: RoleConfigSchema,
  /** Null when the department has no workers (maxConcurrentWorkers 0). */
  worker: RoleConfigSchema.nullable(),
  /** Department-wide gaps that are not per-role (concurrency, workspace isolation, ...). */
  departmentWide: z.array(CapabilityEntrySchema),
}).strict();
export type EffectiveInventory = z.infer<typeof EffectiveInventorySchema>;

export const HealthViewSchema = z.object({
  checkedAt: z.string(),
  hermes: z.object({
    dashboard: z.enum(['up', 'down']),
    /** 'ok' = token accepted, 'rejected' = Hermes returned 401/403, 'unknown' = dashboard down. */
    auth: z.enum(['ok', 'rejected', 'unknown']),
    gateway: z.enum(['running', 'stopped', 'unknown']),
    version: z.string().nullable(),
    detail: z.string().nullable(),
  }).strict(),
}).strict();
export type HealthView = z.infer<typeof HealthViewSchema>;

/**
 * What Hermes' `default` profile has enabled, read live. The create-department form starts from it; nothing is
 * copied until the department is created with an inventory.
 */
export const HermesDefaultsViewSchema = z.object({
  checkedAt: z.string(),
  profile: z.literal('default'),
  model: z.string().nullable(),
  /** Every toolset Hermes lists. `manageable` = Vibe City can grant it (known and not excluded for agents). */
  toolsets: z.array(z.object({ name: z.string(), enabled: z.boolean(), manageable: z.boolean() }).strict()),
  /** Every installed skill, with whether the default profile has it enabled. */
  skills: z.array(z.object({ name: z.string(), enabled: z.boolean() }).strict()),
}).strict();
export type HermesDefaultsView = z.infer<typeof HermesDefaultsViewSchema>;

/** Models Hermes can use right now: its authenticated providers and their model lists (Hermes' own model picker data). */
export const HermesModelsViewSchema = z.object({
  checkedAt: z.string(),
  /** What the `default` profile uses. */
  current: z.object({ provider: z.string().nullable(), model: z.string().nullable() }).strict(),
  providers: z.array(z.object({
    slug: z.string(),
    name: z.string(),
    current: z.boolean(),
    models: z.array(z.string()),
  }).strict()),
}).strict();
export type HermesModelsView = z.infer<typeof HermesModelsViewSchema>;

export const ProfilesViewSchema = z.object({
  departmentId: z.string(),
  /** Live Hermes data; null when Hermes could not be reached (the stored refs are still returned). */
  reachable: z.boolean(),
  chief: z.object({ ref: z.string().nullable(), exists: z.boolean().nullable(), model: z.string().nullable(), description: z.string().nullable() }).strict(),
  worker: z.object({ ref: z.string().nullable(), exists: z.boolean().nullable(), model: z.string().nullable(), description: z.string().nullable() }).strict(),
}).strict();
export type ProfilesView = z.infer<typeof ProfilesViewSchema>;

export const AGENT_ROLES = ['chief', 'worker'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** One Hermes session of a profile, reduced to safe fields (no cwd, prompt preview, origin, billing endpoints). */
export const AgentSessionSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  /** Where the session came from in Hermes, e.g. `kanban`, `cli`, `cron`. */
  source: z.string().nullable(),
  model: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  lastActiveAt: z.string().nullable(),
  /** Hermes' own "active" flag: not ended and recently active. */
  active: z.boolean(),
  messageCount: z.number().int().nullable(),
  toolCallCount: z.number().int().nullable(),
  endReason: z.string().nullable(),
}).strict();
export type AgentSession = z.infer<typeof AgentSessionSchema>;

/**
 * The agent view: one Hermes profile of a department (the chief, or the shared worker profile).
 * Skills, toolsets and model come from the last read-back during provisioning/reconcile (`observedAt`); sessions are
 * read live and are null when Hermes could not be reached. Skills and models are department-wide allowances.
 */
export const AgentViewSchema = z.object({
  departmentId: z.string(),
  role: z.enum(AGENT_ROLES),
  profileRef: z.string().nullable(),
  observedAt: z.string().nullable(),
  model: z.string().nullable(),
  /** The profile's model provider as Hermes reports it. */
  provider: z.string().nullable(),
  /** Every skill installed in the profile, with whether Hermes reports it enabled. */
  skills: z.array(z.object({ name: z.string(), enabled: z.boolean(), essential: z.boolean() }).strict()),
  /** Every toolset Hermes lists for the profile, with whether it is enabled there. */
  toolsets: z.array(z.object({ name: z.string(), enabled: z.boolean() }).strict()),
  sessions: z.array(AgentSessionSchema).nullable(),
  sessionsError: z.string().nullable(),
}).strict();
export type AgentView = z.infer<typeof AgentViewSchema>;

export const profileNamesForDepartment = (id: string) => {
  const short = id.replace(/-/g, '').slice(0, 12);
  return { chief: `vc-${short}-chief`, worker: `vc-${short}-worker` };
};

// ---- quests (Milestone 3) ----------------------------------------------------
// A quest is a top-level Hermes Kanban task assigned to the department chief. Nothing here is stored in SQLite:
// every view is derived from Hermes on request.

export const HERMES_TASK_ID_RE = /^t_[A-Za-z0-9]{4,32}$/;
export const HERMES_TASK_STATUSES = ['triage', 'todo', 'ready', 'running', 'blocked', 'scheduled', 'review', 'done', 'archived'] as const;

export const QUEST_STATUSES = [
  'queued',          // nothing has started yet
  'planning',        // the chief is running and has not created worker tasks yet
  'running',         // work is in progress or waiting to be dispatched
  'awaiting_input',  // a task is blocked waiting for a human
  'in_review',       // a task is in review
  'failed',          // work stopped because a task failed
  'completed',       // every task in the tree is done
  'cancelling',      // cancellation requested, not yet confirmed
  'cancelled',       // cancellation confirmed: nothing active, nothing can be redispatched
] as const;
export type QuestStatus = (typeof QUEST_STATUSES)[number];

export const QuestCreateSchema = z.object({
  /** Client-generated UUID per form submission. Retrying the same request returns the same quest (no duplicates). */
  clientRequestId: z.string().uuid(),
  title: z.string().trim().min(1, 'title is required').max(200),
  objective: z.string().trim().min(1, 'objective is required').max(8000),
  instructions: z.string().trim().max(8000).optional(),
}).strict();
export type QuestCreate = z.infer<typeof QuestCreateSchema>;

const iso = z.string().nullable();

export const TaskRunViewSchema = z.object({
  id: z.number().int(),
  profile: z.string().nullable(),
  state: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown']),
  startedAt: iso,
  endedAt: iso,
}).strict();

export const TaskNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** chief = the quest root, worker = assigned to the department worker, other = any other assignee (flagged). */
  role: z.enum(['chief', 'worker', 'other']),
  assignee: z.string().nullable(),
  status: z.enum(HERMES_TASK_STATUSES),
  parentIds: z.array(z.string()),
  childIds: z.array(z.string()),
  depth: z.number().int(),
  /** blocked after a failure (not a deliberate "needs input" block). */
  failed: z.boolean(),
  createdAt: iso,
  startedAt: iso,
  completedAt: iso,
  summary: z.string().nullable(),
  error: z.string().nullable(),
  attachmentCount: z.number().int(),
  runs: z.array(TaskRunViewSchema),
}).strict();
export type TaskNode = z.infer<typeof TaskNodeSchema>;

export const CancellationStatusSchema = z.object({
  /**
   * none       - never requested
   * requested  - requested; tasks may still be active (pending, not confirmed)
   * confirmed  - every task is done or archived and no run is active
   */
  state: z.enum(['none', 'requested', 'confirmed']),
  requestedAt: iso,
  confirmedAt: iso,
  /** Tasks that are still not stopped (empty when confirmed). */
  remaining: z.array(z.object({ taskId: z.string(), status: z.enum(HERMES_TASK_STATUSES) }).strict()),
  /** Tasks Vibe City archived as part of the cancellation. */
  archivedTaskIds: z.array(z.string()),
  /** Tasks that were already finished (left untouched, results kept). */
  alreadyFinishedTaskIds: z.array(z.string()),
}).strict();
export type CancellationStatus = z.infer<typeof CancellationStatusSchema>;

export const QuestFlagsSchema = z.object({
  /** The chief's own task is done (planning finished). Does NOT mean the quest is complete. */
  planningComplete: z.boolean(),
  /** Worker tasks exist. */
  delegated: z.boolean(),
  hasFailures: z.boolean(),
  hasBlocked: z.boolean(),
  /** Work remains but nothing is running right now (waiting for the dispatcher, a parent, or a human). */
  idle: z.boolean(),
  /** Tasks assigned to a profile other than the department's chief/worker were found. */
  unauthorizedAssignees: z.boolean(),
}).strict();

export const QuestSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(QUEST_STATUSES),
  flags: QuestFlagsSchema,
  /** Factual counts, never a percentage. */
  counts: z.object({
    tasks: z.number().int(),
    done: z.number().int(),
    running: z.number().int(),
    pending: z.number().int(),
    blocked: z.number().int(),
    failed: z.number().int(),
    archived: z.number().int(),
  }).strict(),
  createdAt: iso,
  completedAt: iso,
}).strict();
export type QuestSummary = z.infer<typeof QuestSummarySchema>;

export const QuestDetailSchema = QuestSummarySchema.extend({
  departmentId: z.string(),
  objective: z.string(),
  tasks: z.array(TaskNodeSchema),
  /** Human-readable findings, e.g. a task assigned to a profile outside the department. */
  violations: z.array(z.string()),
  cancellation: CancellationStatusSchema,
  /** Non-fatal notices, e.g. "no gateway running: tasks will wait". */
  warnings: z.array(z.string()),
  /** true when the tree was truncated by safety limits. */
  truncated: z.boolean(),
}).strict();
export type QuestDetail = z.infer<typeof QuestDetailSchema>;

export const ActivityEventSchema = z.object({
  /** Hermes event id (unique within the board). */
  id: z.number().int(),
  at: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  kind: z.string(),
  label: z.string(),
  detail: z.string().nullable(),
}).strict();
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const AttachmentViewSchema = z.object({
  id: z.number().int(),
  taskId: z.string(),
  filename: z.string(),
  contentType: z.string().nullable(),
  size: z.number().int(),
  createdAt: iso,
  /** Vibe City download route. Hermes' stored_path is never exposed. */
  downloadUrl: z.string(),
}).strict();
export type AttachmentView = z.infer<typeof AttachmentViewSchema>;

export const QuestResultsSchema = z.object({
  questId: z.string(),
  status: z.enum(QUEST_STATUSES),
  chiefSummary: z.string().nullable(),
  tasks: z.array(z.object({
    taskId: z.string(),
    title: z.string(),
    role: z.enum(['chief', 'worker', 'other']),
    status: z.enum(HERMES_TASK_STATUSES),
    summary: z.string().nullable(),
    error: z.string().nullable(),
    attachments: z.array(AttachmentViewSchema),
  }).strict()),
}).strict();
export type QuestResults = z.infer<typeof QuestResultsSchema>;

export const QuestCreatedSchema = z.object({
  questId: z.string(),
  hermesBoardSlug: z.string(),
  warnings: z.array(z.string()),
}).strict();
export type QuestCreated = z.infer<typeof QuestCreatedSchema>;

// ---- response envelopes -----------------------------------------------------
// Every list/wrapper response has a strict schema so the backend and the browser validate the same shape.

export const DepartmentListSchema = z.object({ departments: z.array(DepartmentViewSchema) }).strict();
export type DepartmentList = z.infer<typeof DepartmentListSchema>;

/** DELETE /api/departments/:id. Archiving never deletes anything in Hermes. */
export const DepartmentArchivedSchema = z.object({
  department: DepartmentViewSchema,
  /** true when the department had a board or profile refs: those Hermes resources still exist and were not touched. */
  hermesResourcesRetained: z.boolean(),
}).strict();
export type DepartmentArchived = z.infer<typeof DepartmentArchivedSchema>;

export const ReconcileResultSchema = z.object({ departments: z.array(ProvisioningStatusSchema) }).strict();
export const QuestListSchema = z.object({ quests: z.array(QuestSummarySchema) }).strict();

export const QuestTasksSchema = z.object({
  questId: z.string(),
  tasks: z.array(TaskNodeSchema),
  violations: z.array(z.string()),
  truncated: z.boolean(),
}).strict();
export type QuestTasks = z.infer<typeof QuestTasksSchema>;

export const QuestActivitySchema = z.object({ questId: z.string(), events: z.array(ActivityEventSchema) }).strict();
export type QuestActivity = z.infer<typeof QuestActivitySchema>;

// ---- live events relayed to the frontend ------------------------------------

export const LiveMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hermes.event'),
    departmentId: z.string(),
    eventId: z.number().int(),
    taskId: z.string(),
    kind: z.string(),
    at: z.string(),
  }).strict(),
  z.object({
    type: z.literal('connection'),
    departmentId: z.string(),
    /** connected | reconnecting | dashboard_offline (Hermes web server unreachable) | gateway_unavailable (dashboard up, workers cannot run) */
    state: z.enum(['connected', 'reconnecting', 'dashboard_offline', 'gateway_unavailable']),
  }).strict(),
  /** Sent after every (re)connect: refetch snapshots from the REST API. */
  z.object({ type: z.literal('resync'), departmentId: z.string() }).strict(),
]);
export type LiveMessage = z.infer<typeof LiveMessageSchema>;
