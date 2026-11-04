import { z } from 'zod';

// ---- primitives -----------------------------------------------------------

const idList = (what: string) =>
  z.array(z.string().trim().min(1, `${what} entries must be non-empty`).max(200)).max(200)
    .transform((a) => [...new Set(a)]);

/** Built-in toolset names Hermes 0.22 lists in `hermes tools list` (verified against Hermes 0.22.5/0.22.6). */
export const TOOLSETS = [
  'web', 'browser', 'terminal', 'file', 'code_execution', 'vision', 'video', 'image_gen', 'video_gen', 'x_search',
  'tts', 'stt', 'skills', 'todo', 'kanban', 'memory', 'context_engine', 'session_search', 'connections', 'clarify',
  'delegation', 'cronjob', 'computer_use',
] as const;
export const ToolsetSchema = z.enum(TOOLSETS);
export type Toolset = z.infer<typeof ToolsetSchema>;
/** Never given to a department agent: sub-agents and cron jobs run outside the department board, where Vibe City cannot see them. */
export const AGENT_EXCLUDED_TOOLSETS = ['delegation', 'cronjob'] as const;

/** Agents a department may have besides its lead. Every agent is its own Hermes profile. */
export const MAX_TEAMMATES = 10;

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
  /** The agents' default model, chosen from Hermes' list. An agent's own model (from its hire) wins. Null = keep the profile's own default. */
  model: ModelChoiceSchema.nullable().default(null),
  allowedToolsets: toolsets.default([]),
  sharedContextRefs: contextRefs.default([]),
  limits: z.object({
    /** Per-task runtime cap passed to Hermes as max_runtime_seconds when tasks are created. */
    maxTaskRuntimeSeconds: z.number().int().min(10).max(86_400).nullable().default(null),
    maxDelegationDepth: z.literal(1).default(1),
  }).default({ maxTaskRuntimeSeconds: null, maxDelegationDepth: 1 }),
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
    maxTaskRuntimeSeconds: z.number().int().min(10).max(86_400).nullable(),
    maxDelegationDepth: z.literal(1),
  }).partial().strict().optional(),
}).strict();
export type InventoryPatch = z.infer<typeof InventoryPatchSchema>;

// ---- departments ----------------------------------------------------------

export const DEPARTMENT_STATES = ['unconfigured', 'provisioning', 'ready', 'error', 'disconnected'] as const;
export const BOARD_SYNC_STATES = ['not_provisioned', 'synced', 'error'] as const;

const name = z.string().trim().min(1, 'name is required').max(80);
const purpose = z.string().trim().max(2000);
const profileRef = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'invalid Hermes profile name').nullable();

export const DepartmentCreateSchema = z.object({
  name,
  purpose: purpose.default(''),
  inventory: InventoryPatchSchema.optional(),
  /** Agents to start with besides the lead. Each gets its own Hermes profile when the department is provisioned. */
  teammates: z.number().int().min(0).max(MAX_TEAMMATES).default(0),
}).strict();
export type DepartmentCreate = z.infer<typeof DepartmentCreateSchema>;

export const DepartmentUpdateSchema = z.object({
  name: name.optional(),
  purpose: purpose.optional(),
  /** An existing Hermes profile to use as the lead agent (null = a Vibe City-managed one). Teammates are always managed. */
  leadProfileRef: profileRef.optional(),
  /**
   * Explicit consent to let Vibe City modify these EXISTING Hermes profiles (toolsets, skills, model, SOUL.md block).
   * Each entry must equal the department's current lead ref. Replaces the previous confirmation list.
   */
  confirmModifyProfiles: z.array(z.string().trim().min(1)).max(1).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'at least one field is required');
export type DepartmentUpdate = z.infer<typeof DepartmentUpdateSchema>;

export const AGENT_KEY_RE = /^(chief|W-\d{2,3})$/;

/**
 * One agent of a department: its own Hermes profile. Every agent gets the same instructions; the lead (seat 0, key
 * `chief`) is the one new quests are assigned to, and it hands parts of the work to its teammates by profile name.
 */
export const DepartmentAgentSchema = z.object({
  key: z.string().regex(AGENT_KEY_RE),
  lead: z.boolean(),
  /** Null until provisioning has created (or associated) the profile. */
  profileRef: z.string().nullable(),
  /** The agent's own model (from its hire). Null = the department's model. */
  model: ModelChoiceSchema.nullable(),
  /** Skills the agent has on top of the department's allowance (from its hire). */
  skills: z.array(z.string()),
  createdAt: z.string(),
}).strict();
export type DepartmentAgent = z.infer<typeof DepartmentAgentSchema>;

export const DepartmentViewSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  name: z.string(),
  purpose: z.string(),
  /** Stable creation-order identifier (never renumbered, never reused). Not the visual position. */
  floorOrder: z.number().int(),
  /** Visual position among active departments: 1 = directly below the Executive Office. Null when archived. */
  floorPosition: z.number().int().min(1).nullable(),
  state: z.enum(DEPARTMENT_STATES),
  /** Lead first, then teammates in seat order. */
  agents: z.array(DepartmentAgentSchema),
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

export const PROVISIONING_STEPS = ['health', 'validate', 'board', 'agents', 'inventory', 'verify'] as const;

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
  /** One profile per agent, lead first. */
  agents: z.array(ResourceStatusSchema.extend({ key: z.string() }).strict()),
  inventory: z.object({ applied: z.boolean(), appliedAt: z.string().nullable(), inSync: z.boolean() }).strict(),
  lastReconciledAt: z.string().nullable(),
}).strict();
export type ProvisioningStatus = z.infer<typeof ProvisioningStatusSchema>;

/** Refresh: Hermes read and compared with the department, nothing written. `differences` empty = in sync. */
export const SyncCheckSchema = z.object({ inSync: z.boolean(), differences: z.array(z.string()), status: ProvisioningStatusSchema }).strict();
export type SyncCheck = z.infer<typeof SyncCheckSchema>;

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
   * (file isolation and worker delegation depth are never guarantees).
   */
  guarantee: z.boolean(),
  detail: z.string(),
}).strict();
export type CapabilityEntry = z.infer<typeof CapabilityEntrySchema>;

export const AgentConfigSchema = z.object({
  agentKey: z.string(),
  profileRef: z.string().nullable(),
  entries: z.array(CapabilityEntrySchema),
}).strict();
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const EffectiveInventorySchema = z.object({
  departmentId: z.string(),
  /** Whether `observedAt` data came from a real read of Hermes; null before the first successful apply. */
  observedAt: z.string().nullable(),
  inSync: z.boolean(),
  /** One report per agent profile, lead first. */
  agents: z.array(AgentConfigSchema),
  /** Department-wide gaps that are not per-agent (concurrency, file isolation, ...). */
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
  agents: z.array(z.object({ key: z.string(), ref: z.string().nullable(), exists: z.boolean().nullable(), model: z.string().nullable(), description: z.string().nullable() }).strict()),
}).strict();
export type ProfilesView = z.infer<typeof ProfilesViewSchema>;

/** Persona flavour only (title, colour): the lead seat or a teammate desk. Both are the same kind of agent. */
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
 * The agent view: one agent of a department, which is one Hermes profile.
 * Skills, toolsets and model come from the last read-back during provisioning/reconcile (`observedAt`); sessions are
 * read live and are null when Hermes could not be reached.
 */
export const AgentViewSchema = z.object({
  departmentId: z.string(),
  agentKey: z.string(),
  lead: z.boolean(),
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

/** The Vibe City-managed profile name of one agent: `vc-<id>-chief` for the lead, `vc-<id>-w01` for W-01. */
export const profileNameForAgent = (departmentId: string, agentKey: string) => {
  const short = departmentId.replace(/-/g, '').slice(0, 12);
  return `vc-${short}-${agentKey === 'chief' ? 'chief' : agentKey.replace('-', '').toLowerCase()}`;
};

// ---- quests (Milestone 3) ----------------------------------------------------
// A quest is a top-level Hermes Kanban task assigned to the department's lead agent. Nothing here is stored in SQLite:
// every view is derived from Hermes on request.

export const HERMES_TASK_ID_RE = /^t_[A-Za-z0-9]{4,32}$/;
export const HERMES_TASK_STATUSES = ['triage', 'todo', 'ready', 'running', 'blocked', 'scheduled', 'review', 'done', 'archived'] as const;

export const QUEST_STATUSES = [
  'queued',          // nothing has started yet
  'planning',        // the lead is running and has not handed out tasks yet
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
  /** The department agent the task is assigned to; null = a profile outside the department (flagged). */
  agentKey: z.string().nullable(),
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
  /** The lead's own task is done (planning finished). Does NOT mean the quest is complete. */
  planningComplete: z.boolean(),
  /** Tasks were handed to teammates. */
  delegated: z.boolean(),
  hasFailures: z.boolean(),
  hasBlocked: z.boolean(),
  /** Work remains but nothing is running right now (waiting for the dispatcher, a parent, or a human). */
  idle: z.boolean(),
  /** Tasks assigned to a profile that is not one of the department's agents were found. */
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
  leadSummary: z.string().nullable(),
  tasks: z.array(z.object({
    taskId: z.string(),
    title: z.string(),
    agentKey: z.string().nullable(),
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

// ---- characters and agent chat (feature spec 2.1, 2.2, 2.5) ------------------
// A character is the persona of one agent (the lead, or a teammate desk W-01…). It shapes how the agent talks in
// the dialogue window and never what it may do. Chat is a conversation with the model the department runs on; work
// only starts when the user accepts a proposal, which creates an ordinary quest.

export const MOODS = ['neutral', 'happy', 'focused', 'worried', 'smug', 'annoyed'] as const;
export type Mood = (typeof MOODS)[number];

export const CharacterSchema = z.object({
  departmentId: z.string(),
  agentKey: z.string(),
  role: z.enum(AGENT_ROLES),
  name: z.string(),
  /** Job title shown under the name, e.g. "Research chief". */
  title: z.string(),
  traits: z.array(z.string()),
  speechStyle: z.string(),
  quirk: z.string(),
  /** Signature colour (hex) for the portrait panel and name tag. */
  color: z.string(),
  /** Typewriter blip pitch in Hz. */
  voice: z.number(),
}).strict();
export type Character = z.infer<typeof CharacterSchema>;

export const ChatProposalSchema = z.object({
  kind: z.literal('quest'),
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(8000),
}).strict();
export type ChatProposal = z.infer<typeof ChatProposalSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  from: z.enum(['user', 'agent']),
  text: z.string(),
  mood: z.enum(MOODS).nullable(),
  /** Suggested next things the user might say (agent messages only). */
  replies: z.array(z.string()),
  proposal: ChatProposalSchema.nullable(),
  at: z.string(),
}).strict();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatHistorySchema = z.object({
  character: CharacterSchema,
  messages: z.array(ChatMessageSchema),
  /** False when no chat model is configured (NEAR_AI_API_KEY unset): the window shows why instead of a chat box. */
  modelReady: z.boolean(),
}).strict();
export type ChatHistory = z.infer<typeof ChatHistorySchema>;

export const ChatSendSchema = z.object({
  message: z.string().trim().min(1, 'say something').max(2000),
  /** The agent's current task title, as context for the persona. */
  taskTitle: z.string().trim().max(300).optional(),
}).strict();
export type ChatSend = z.infer<typeof ChatSendSchema>;

export const ChatReplySchema = z.object({ user: ChatMessageSchema, agent: ChatMessageSchema }).strict();
export type ChatReply = z.infer<typeof ChatReplySchema>;

/** What the agent is doing while it answers (the `progress` events of POST .../chat/stream). */
export const ChatProgressSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('thinking') }).strict(),
  z.object({ kind: z.literal('tool'), name: z.string(), preview: z.string().nullable() }).strict(),
  z.object({ kind: z.literal('approval'), command: z.string().nullable() }).strict(),
]);
export type ChatProgress = z.infer<typeof ChatProgressSchema>;

// ---- AR: scouting and hiring (feature spec 7.1) -------------------------------------------------------------------
// AR (Agent Resources) notices when a floor needs people and calls the CEO. The intake is a chat with AR's head, which
// ends in a brief; AR then scouts four candidates (two serious, two joke) and the CEO hires one. Nothing changes in
// Hermes until the offer: a hire adds an agent (its own Hermes profile, with the candidate's model and skills).

export const HIRING_STATES = ['ringing', 'intake', 'scouting', 'shortlist', 'hired', 'closed'] as const;
export type HiringState = (typeof HIRING_STATES)[number];
export const HIRING_TRIGGERS = ['manual', 'no_workers', 'queue', 'failures'] as const;

export const HiringTriggerSchema = z.object({
  kind: z.enum(HIRING_TRIGGERS),
  departmentId: z.string().nullable(),
  /** What AR says when it calls, built from real board numbers. */
  reason: z.string(),
}).strict();
export type HiringTrigger = z.infer<typeof HiringTriggerSchema>;

export const HiringBriefSchema = z.object({
  departmentId: z.string(),
  departmentName: z.string(),
  focus: z.string().trim().min(1).max(200),
  skills: z.array(z.string().trim().min(1).max(100)).max(10),
  /** Daily budget in credits (an estimate unit, see candidate cost). */
  budgetPerDay: z.number().int().min(1).max(100_000),
  notes: z.string().max(500),
}).strict();
export type HiringBrief = z.infer<typeof HiringBriefSchema>;

export const HiringMessageSchema = z.object({
  id: z.string(),
  from: z.enum(['user', 'agent']),
  text: z.string(),
  mood: z.enum(MOODS).nullable(),
  replies: z.array(z.string()),
  brief: HiringBriefSchema.nullable(),
  at: z.string(),
}).strict();
export type HiringMessage = z.infer<typeof HiringMessageSchema>;

export const GAGS = ['shades', 'frazzled', 'intern', 'guru'] as const;
export const CandidateSchema = z.object({
  id: z.string(),
  /** False for the two joke candidates. Their numbers are honestly bad too. */
  serious: z.boolean(),
  character: CharacterSchema,
  pitch: z.string(),
  /** Exaggerated portrait parts for joke candidates. */
  gag: z.enum(GAGS).nullable(),
  loadout: z.object({ model: ModelChoiceSchema.nullable(), skills: z.array(z.string()), toolsets: z.array(z.string()) }).strict(),
  /** Model size class guessed from the model name: 1 small, 2 balanced, 3 large. */
  tier: z.number().int().min(1).max(3),
  /** Estimated credits per day. An estimate from the model tier, not a price quote. */
  costPerDay: z.number().int().min(0),
  fitScore: z.number().int().min(0).max(100),
  /** AR's honest remark about this candidate. */
  note: z.string(),
}).strict();
export type Candidate = z.infer<typeof CandidateSchema>;

export const HiringRequestViewSchema = z.object({
  id: z.string(),
  state: z.enum(HIRING_STATES),
  trigger: HiringTriggerSchema,
  ar: CharacterSchema,
  messages: z.array(HiringMessageSchema),
  brief: HiringBriefSchema.nullable(),
  scoutingUntil: z.string().nullable(),
  /** Visible once scouting is over. */
  candidates: z.array(CandidateSchema),
  hiredCandidateId: z.string().nullable(),
  /** What the offer changed, once hired. */
  applied: z.object({ departmentId: z.string(), seat: z.string(), profileRef: z.string(), teamBefore: z.number().int(), teamAfter: z.number().int(), skills: z.array(z.string()), model: ModelChoiceSchema.nullable(), provisioning: z.string() }).strict().nullable(),
  modelReady: z.boolean(),
  createdAt: z.string(),
}).strict();
export type HiringRequestView = z.infer<typeof HiringRequestViewSchema>;

export const HiringCurrentSchema = z.object({ request: HiringRequestViewSchema.nullable() }).strict();
export const HiringStartSchema = z.object({ departmentId: z.string().optional() }).strict();
export const HiringSendSchema = z.object({ message: z.string().trim().min(1).max(2000) }).strict();
export const HiringBriefConfirmSchema = z.object({ brief: HiringBriefSchema.omit({ departmentName: true }).optional() }).strict();
export const HiringOfferSchema = z.object({ candidateId: z.string(), acceptConcerns: z.boolean().optional() }).strict();
export const InterviewSendSchema = z.object({ message: z.string().trim().min(1).max(1000) }).strict();
export const InterviewReplySchema = z.object({
  user: ChatMessageSchema, agent: ChatMessageSchema,
  stats: z.object({ ms: z.number().int(), tokens: z.number().int().nullable(), model: z.string(), costNote: z.string() }).strict(),
}).strict();
export type InterviewReply = z.infer<typeof InterviewReplySchema>;
export const InterviewHistorySchema = z.array(ChatMessageSchema);

// ---- executive assistant: new departments through the dialogue window (feature spec 4.3) ---------------------------
// The assistant drafts a floor (name, purpose, starter inventory) from a short chat. The backend keeps only what Hermes
// really has (installed skills, manageable toolsets, offered models). Nothing is created until the user confirms, and
// then through the normal POST /api/departments.

export const DeptDraftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  purpose: z.string().trim().max(2000),
  skills: z.array(z.string()),
  toolsets: z.array(ToolsetSchema),
  model: ModelChoiceSchema.nullable(),
  teammates: z.number().int().min(0).max(4),
  /** Estimate from the model size class and the number of agents. Not a price quote. */
  creditsPerDay: z.number().int().min(0),
  /** Anything the assistant asked for that Hermes does not have, said plainly. */
  dropped: z.array(z.string()),
}).strict();
export type DeptDraft = z.infer<typeof DeptDraftSchema>;

export const AssistantTurnSchema = z.object({ from: z.enum(['user', 'agent']), text: z.string().max(4000) }).strict();
export const DeptDraftRequestSchema = z.object({ messages: z.array(AssistantTurnSchema).min(1).max(40) }).strict();
export const DeptDraftReplySchema = z.object({
  say: z.string(), mood: z.enum(MOODS), replies: z.array(z.string()), draft: DeptDraftSchema.nullable(),
}).strict();
export type DeptDraftReply = z.infer<typeof DeptDraftReplySchema>;
export const AssistantViewSchema = z.object({ character: CharacterSchema, modelReady: z.boolean() }).strict();
export type AssistantView = z.infer<typeof AssistantViewSchema>;

// ---- quests between departments (feature spec 2.4) ----------------------------------------------------------------
// An agent can hand work to another department through the Vibe City MCP tool `request_quest`. The request becomes an
// ordinary quest on the target department's board (assigned to its lead), with guardrails: the target's allowlist,
// no handing work back along an open chain, and a daily cap per requesting department (over the cap the CEO decides).

export const QUEST_ORIGINS = ['user', 'agent', 'schedule', 'market'] as const;
export const QUEST_REQUEST_STATES = ['created', 'pending_approval', 'rejected', 'failed'] as const;

export const QuestRequestViewSchema = z.object({
  id: z.string(),
  fromDepartmentId: z.string(), fromName: z.string(),
  toDepartmentId: z.string().nullable(), toName: z.string(),
  title: z.string(), objective: z.string(), reason: z.string(),
  state: z.enum(QUEST_REQUEST_STATES),
  /** Why it was rejected, failed, or is waiting for approval. */
  note: z.string().nullable(),
  questId: z.string().nullable(),
  createdAt: z.string(), decidedAt: z.string().nullable(),
}).strict();
export type QuestRequestView = z.infer<typeof QuestRequestViewSchema>;
export const QuestRequestListSchema = z.object({ requests: z.array(QuestRequestViewSchema) }).strict();

export const QuestOriginSchema = z.object({
  questId: z.string(), departmentId: z.string(), origin: z.enum(QUEST_ORIGINS),
  fromDepartmentId: z.string().nullable(), fromName: z.string().nullable(), requestId: z.string().nullable(),
}).strict();
export type QuestOrigin = z.infer<typeof QuestOriginSchema>;
export const QuestOriginListSchema = z.object({ origins: z.array(QuestOriginSchema) }).strict();

export const QuestPolicySchema = z.object({
  /** Departments allowed to give this department work: '*' for every department, or a list of department ids. */
  allowFrom: z.union([z.literal('*'), z.array(z.string()).max(50)]),
  /** Quests this department's agents may request per 24 h before each one needs the CEO's approval. */
  dailyCap: z.number().int().min(0).max(100),
}).strict();
export type QuestPolicy = z.infer<typeof QuestPolicySchema>;
export const QuestPolicyPatchSchema = QuestPolicySchema.partial().strict();
export const QuestRequestCreateSchema = z.object({
  fromDepartmentId: z.string(), department: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(200), objective: z.string().trim().min(1).max(8000), reason: z.string().trim().max(1000).default(''),
}).strict();

// ---- schedules (feature spec 8) ----------------------------------------------------------------------------------
// Recurring quests. The Vibe City backend is the scheduler (Hermes' cronjob toolset stays off for department agents):
// at each fire time it creates an ordinary quest on the department's board, with origin 'schedule' and one
// idempotency key per fire, so a restart never fires twice.

export const ScheduleSchema = z.object({
  id: z.string(),
  departmentId: z.string(),
  name: z.string(),
  cron: z.string(),
  timezone: z.string(),
  title: z.string(),
  objective: z.string(),
  instructions: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastQuestId: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
}).strict();
export type Schedule = z.infer<typeof ScheduleSchema>;
export const ScheduleListSchema = z.object({ schedules: z.array(ScheduleSchema) }).strict();
export const ScheduleCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  cron: z.string().trim().min(9).max(100),
  timezone: z.string().trim().min(1).max(64).default('UTC'),
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(8000),
  instructions: z.string().trim().max(8000).default(''),
  enabled: z.boolean().default(true),
}).strict();
export type ScheduleCreate = z.infer<typeof ScheduleCreateSchema>;
export const SchedulePatchSchema = ScheduleCreateSchema.partial().strict();
export type SchedulePatch = z.infer<typeof SchedulePatchSchema>;
