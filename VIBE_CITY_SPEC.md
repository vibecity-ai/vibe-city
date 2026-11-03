# Vibe City Product and Integration Specification

**Status:** Normative source of truth  
**Last reconciled with code:** 2026-11-03  
**Project root:** `/home/urataps/Work/VibeCity`  
**Prototype/reference:** `/home/urataps/Work/vibeytown`

## 1. Authority and maintenance

This document defines the intended Vibe City product behavior. A code change that alters a public model, route, state transition, security boundary, Hermes mapping, or user-visible guarantee must update this document in the same change.

Evidence used to reconcile this version:

- `packages/shared/src/schemas.ts` — public DTOs and validation
- `apps/backend/src/app.ts` — HTTP and WebSocket surface
- `apps/backend/src/domain/*` — domain behavior
- `apps/backend/src/hermes/*` — supported Hermes adapter boundary
- `apps/web/src/town/*` — current UI behavior
- `ARCHITECTURE.md` — implementation decisions through Milestone 3
- `HERMES_COMPATIBILITY.md` — behavior verified against Hermes
- `/home/urataps/.hermes/hermes-agent` — locally installed Hermes contracts used to specify future Project and heartbeat integration

Historical PRDs and conversation exports may be reviewed for context, but they are not evidence of implemented behavior or locked requirements. A historical proposal enters this contract only when it is confirmed by the current code, verified Hermes behavior, or an explicit new product decision.

When artifacts disagree:

1. This document is the product contract.
2. Shared schemas define the currently accepted wire format.
3. Tests and domain code establish current implementation behavior.
4. `ARCHITECTURE.md` and `HERMES_COMPATIBILITY.md` are evidence and rationale, not the current product contract.
5. The standalone `vibeytown` repository is a visual reference, not production state or integration behavior.

Every section is marked **Implemented**, **Planned**, or **Decision required**. Planned behavior must not be represented as working in the UI.

## 2. Product definition

Vibe City is a truthful visual client for an AI-native company run by Hermes Agent.

- The company is a tower.
- A department is a floor.
- A department chief and its workers are real Hermes profiles and runs.
- In the current model, a worker character represents a real worker-role task/run at a desk; it is not a persistent employee record.
- A quest is a top-level Hermes Kanban task assigned to the department chief.
- Worker tasks are descendants of the quest and normally run after the chief finishes planning.
- Inventory represents requested and observed Hermes capabilities; it is not cosmetic equipment.
- Animation follows backend and Hermes state. It must never invent activity, completion, earnings, isolation, or safety.

The city UI is the only web experience.

## 3. Non-negotiable product invariants

1. **Hermes Kanban is the source of truth for quests.** Vibe City does not maintain a second quest/task store.
2. **Vibe City SQLite stores only Vibe City metadata**, such as company, departments, inventory, verified Hermes references, event cursors, and future integration bindings.
3. **The browser never talks directly to Hermes.** The Vibe City backend owns the dashboard token and relays normalized data.
4. **No direct reads or writes of Hermes databases.** Use supported dashboard REST/WebSocket, gateway RPC, or validated `hermes` CLI operations.
5. **Raw Hermes event payloads and host paths never reach the browser.** Paths are removed or reduced to a safe basename/label.
6. **Attachments are authorized through the department and quest tree** and downloaded through Vibe City as `application/octet-stream`; Hermes `stored_path` is never exposed.
7. **A task percentage is never fabricated.** Progress is expressed with factual task counts and states.
8. **Chief completion means planning completed, not quest completion.** Quest completion is derived from the entire task tree.
9. **Workspace paths are advisory on the local Hermes backend.** They must not be described as a sandbox or isolation boundary.
10. **A capability is guaranteed only when its effective status is `enforced`.** `configured`, `unverified`, and `unsupported` are not guarantees.
11. **Associated Hermes profiles are never modified without explicit consent.** Managed Vibe City profiles are the default.
12. **Cancellation is confirmed only when all tasks are terminal and no run remains open.** A request to stop is not itself success.
13. **Offline, stale, failed, blocked, and idle are different states** and must remain distinguishable.

## 4. System layout — Implemented

### 4.1 Workspace

The project is an npm workspace monorepo:

| Path | Responsibility |
|---|---|
| `packages/shared` | Strict Zod schemas and shared TypeScript types |
| `apps/backend` | Fastify API, SQLite metadata, Hermes adapter, reconciliation, quest aggregation, live relay |
| `apps/web` | React/Vite city |
| `apps/web/src/town` | Canvas city renderer, store, backend-to-world derivation, city UI |

### 4.2 Runtime dependencies

- Vibe City backend: default `http://127.0.0.1:4100`
- Vibe City web development server: default `http://127.0.0.1:5173`
- Hermes dashboard: default `http://127.0.0.1:9119`
- Hermes gateway: separate process required for task execution
- Vibe City metadata DB: `apps/backend/data/vibe-city.sqlite` unless `VIBE_CITY_DB` overrides it

The backend does not start or reconfigure Hermes services. Dashboard and gateway health are reported separately.

## 5. Company and departments — Implemented

### 5.1 Company

- One company row exists.
- The Executive Office is logical, always first, and cannot be deleted.
- Active departments follow it, newest first.

### 5.2 Department identity and ordering

- Department ID is a UUID.
- `floorOrder` is a stable, monotonic creation identifier and is never reused or renumbered.
- `floorPosition` is the current visible position among active departments; archived departments have no visible position.
- Archive is the department delete operation. Hermes resources are retained.
- Active department names are unique; an archived name may be reused.

### 5.3 Department state

Allowed states:

- `unconfigured`
- `provisioning`
- `ready`
- `error`
- `disconnected`

`ready` means required resources exist and match the configured inventory. It does not mean every requested capability is enforceable.

### 5.4 Hermes resources

Each department has:

- deterministic board slug `vc-<department UUID>`
- one chief profile
- one worker profile
- department inventory
- optional advisory host workspace path

Managed profile names are `vc-<first 12 UUID hex>-chief` and `vc-<first 12 UUID hex>-worker`.

The current runtime model is role-based: one chief profile and one shared worker profile per department. Inventory is configured at the department level and narrowed by role before it is applied to those two profiles. Vibe City does not currently persist a roster of individually configurable worker profiles, hiring proposals, reporting relationships, or per-worker RPG inventories.

An explicitly associated existing profile requires per-profile confirmation before Vibe City may change toolsets, skills, model default, or its delimited `SOUL.md` block.

## 6. Inventory and enforcement — Implemented

Inventory contains:

- allowed skill IDs
- allowed MCP tools
- allowed model IDs
- allowed toolsets
- shared-context references
- requested maximum concurrent workers: 1–10
- optional task runtime cap: 10–86,400 seconds
- delegation depth fixed at 1

Effective capability states:

| State | Meaning | Guarantee |
|---|---|---|
| `enforced` | Applied, read back, and restriction behavior tested against real Hermes | Yes |
| `configured` | Applied and read back, but runtime behavior not verified | No |
| `unverified` | Not applied or not observable | No |
| `unsupported` | Hermes cannot enforce it through the supported integration | No |

Known limitations:

- Local workspace boundaries are not enforced when file/terminal tools are available.
- Allowed model lists are not enforceable; only the profile default can be configured.
- MCP tool-level policy is unverified on the current installation.
- Per-department concurrency is not enforceable independently. Hermes has a host-wide per-profile cap read at gateway startup.
- Worker delegation depth is instructed, not technically enforced.

## 7. Provisioning and reconciliation — Implemented

Provisioning steps are:

`health → validate → board → chief → worker → inventory → verify`

Expected transitions:

```text
unconfigured → provisioning → ready
                         ↘ disconnected  (temporary Hermes availability)
                         ↘ error         (configuration, auth, validation, or verification failure)
ready → disconnected → ready
ready → unconfigured    (inventory/profile/name/purpose/workspace changes requiring reapply)
```

Properties:

- Provisioning is idempotent.
- Deterministic resources are adopted after interrupted creation rather than duplicated.
- Verification timestamps and resource origins are persisted as each step succeeds.
- A stuck provisioning state becomes a retryable interrupted error after restart.
- Reconciliation checks only ready/disconnected departments, restores verified state, and heals managed resources.
- Associated profiles are never recreated and are never modified without consent.

## 8. Quests — Implemented

### 8.1 Mapping

| Vibe City | Hermes |
|---|---|
| Quest | Top-level task assigned to department chief |
| Planning | Chief task/run |
| Worker task | Descendant assigned to department worker |
| Result | Summary/error plus attachments |
| Activity | Normalized task events |
| Cancellation intent | Durable root comment by `vibe-city` |

A valid quest must be on the department board, have no parent, and be assigned to the verified chief profile.

**Board ownership.** The player manages quests only on the **company quest board**. Department boards belong to the agents: the chief plans and delegates there. The company board is a client-side view over every active department's quest list. It has no Hermes board or store of its own, so invariant 1 still holds. Rules:

- Every quest belongs to exactly one department, chosen when the quest is created. There is no unassigned company backlog yet.
- A department whose quest list was never loaded is reported as **missing**, never as having zero quests. A list that loaded once and then failed to refresh is shown as **out of date**.
- Only `ready` departments can receive a quest while Hermes is reachable. A stopped gateway is a warning, not a block: the quest is created and waits in Queued.
- Department panels list their quests read-only and link to the company board.

A real Hermes company board, for a backlog, Executive Office routing or quests spanning departments, is deferred. It would need Hermes to support links between boards; see §15.

### 8.2 Creation

Quest input contains:

- client-generated UUID `clientRequestId`
- title, maximum 200 characters
- objective, maximum 8,000 characters
- optional instructions, maximum 8,000 characters

The Hermes idempotency key is `vibe-city:<departmentId>:<clientRequestId>`. Retrying the same request must return the existing non-archived task.

The chief is instructed to create self-contained child tasks assigned to the worker with `parents=[quest]`. Hermes parent links are dependencies, so children wait until the chief task is done.

### 8.3 Aggregated states

Quest states are:

- `queued`
- `planning`
- `running`
- `awaiting_input`
- `in_review`
- `failed`
- `completed`
- `cancelling`
- `cancelled`

Status is derived from the whole task tree, not the root task alone. The current traversal is bounded to 200 tasks and 8 levels and reports truncation.

Tasks assigned outside the department chief/worker profiles are shown as violations. This is detection, not prevention.

### 8.4 Results and attachments

Results include chief summary and per-task status, summary, error, and authorized attachments. Downloads must:

- verify department → board → quest tree → attachment
- force download as `application/octet-stream`
- use `nosniff`, sandbox CSP, and `no-store`
- never expose Hermes storage paths

The implemented artifact surface is quest-scoped results and attachments. There is no department-wide artifact index, bookshelf browser, file preview service, or duplicated artifact store. A future library may aggregate authorized Hermes attachments, but it must preserve quest/task provenance and must not scan arbitrary workspace paths by default.

### 8.5 Cancellation

Vibe City records `[vibe-city] cancel-requested` on the root, then archives every unfinished task, running tasks first and descendants deepest first. It re-reads state before acting and repeats while the chief may still create tasks.

Cancellation becomes `confirmed` only when every task is `done` or `archived` and no run is open. Finished results are retained. Hard delete, terminate-only, reclaim-only, and block-only are not cancellation implementations.

## 9. Live data and truthful rendering — Implemented

The backend keeps one resumable Hermes board WebSocket per department with browser subscribers. It persists the last event cursor, deduplicates by event ID, and relays only:

- normalized event identity: department, event ID, task ID, kind, timestamp
- connection state: `connected`, `reconnecting`, `dashboard_offline`, `gateway_unavailable`
- `resync` after connection/reconnection

Events are refresh hints. REST snapshots remain authoritative.

On refresh failure, the frontend retains the last good snapshot and marks it stale. It must not clear real work or replace it with simulated data.

The city derives floors, agents, desk slots, effects, and status from backend DTOs. At most six worker desks are drawn; additional tasks remain counted but are not rendered as agents.

The renderer is the integrated custom Canvas 2D renderer under `apps/web/src/town`; PixiJS is not part of the current implementation contract. The office shelf is presently scenery, not an artifact-library interaction.

## 10. Public backend surface — Implemented

### Company and departments

- `GET /api/company`
- `GET /api/departments`
- `POST /api/departments`
- `GET/PATCH/DELETE /api/departments/:id`
- `GET/PATCH /api/departments/:id/inventory`

### Hermes resources

- `GET /api/runtime/health`
- `POST /api/runtime/reconcile`
- `POST /api/departments/:id/provision`
- `POST /api/departments/:id/provision/retry`
- `GET /api/departments/:id/provisioning`
- `GET /api/departments/:id/profiles`
- `GET /api/departments/:id/effective-inventory`

### Quests

- `GET/POST /api/departments/:id/quests`
- `GET /api/departments/:id/quests/:questId`
- `GET /api/departments/:id/quests/:questId/tasks`
- `GET /api/departments/:id/quests/:questId/activity`
- `GET /api/departments/:id/quests/:questId/results`
- `GET /api/departments/:id/quests/:questId/attachments/:attachmentId`
- `POST /api/departments/:id/quests/:questId/cancel`
- `GET /api/departments/:id/quests/:questId/cancellation`
- WebSocket `GET /api/live?departmentId=<UUID>`

Unknown fields in request and response contracts are rejected by strict schemas where defined.

## 11. Heartbeat integration — Planned

### 11.1 Scope and terminology

Hermes exposes several unrelated heartbeat concepts. Vibe City must keep them separate:

1. **Kanban worker heartbeat:** task/run liveness (`last_heartbeat_at`, `claim_expires`) and `heartbeat` task events.
2. **Gateway/backend heartbeat:** runtime process health; this contributes to global Hermes availability, not a worker's activity.
3. **Session `/heartbeat` automation:** periodic prompts attached to an interactive Hermes session. This is not part of quest execution.

The first integration target is **Kanban worker heartbeat and liveness**. Session `/heartbeat` automation remains out of scope until a separate product use case is approved.

### 11.2 Supported Hermes evidence

The installed Hermes dashboard exposes:

- `GET /api/plugins/kanban/workers/active?board=<slug>` with `run_id`, `task_id`, profile, start time, `claim_expires`, `last_heartbeat_at`, and runtime cap
- `GET /api/plugins/kanban/runs/:runId?board=<slug>`
- `GET /api/plugins/kanban/runs/:runId/inspect?board=<slug>` for diagnostic process inspection
- board events of kind `heartbeat`

Vibe City currently filters heartbeat events from the human activity feed. That is correct: repetitive liveness signals are telemetry, not user activity.

### 11.3 Required product behavior

Backend task/run views will expose a normalized liveness object without process IDs, command lines, claim locks, or raw payloads:

```ts
interface RunLiveness {
  state: 'active' | 'stale' | 'unknown' | 'ended';
  lastHeartbeatAt: string | null;
  claimExpiresAt: string | null;
  observedAt: string;
}
```

Rules:

- `ended` is based on an ended run, never heartbeat age alone.
- `active` requires an open run and current Hermes evidence that its lease/heartbeat is valid.
- `stale` requires an open run whose Hermes lease is expired or which Hermes itself reports as lost/stale.
- `unknown` is used when Hermes is unavailable, fields are absent, or evidence is contradictory.
- Vibe City must not invent a fixed stale timeout when Hermes already supplies lease/expiry semantics.
- A stale heartbeat does not automatically change the task status. Task status and liveness are shown as separate facts until Hermes records recovery/failure.
- `heartbeat` events continue to be omitted from activity lists and visual effect logs.
- Live heartbeat updates are coalesced; they must not trigger one browser render or REST fan-out per raw heartbeat event.
- Last heartbeat timestamps are scrubbed telemetry and may be relayed; raw event payloads may not.

### 11.4 City behavior

- A running agent with active liveness may animate as working.
- A running task with stale liveness shows a visible warning and stops the confident typing animation; it must not be labelled failed unless task state says failed.
- When Hermes is disconnected, agents show disconnected/unknown rather than stale.
- UI copy must distinguish “last signal received” from “task completed.”

### 11.5 Heartbeat acceptance criteria

- Unit tests cover active, stale, unknown, ended, missing fields, dashboard outage, and gateway outage.
- Heartbeat events remain absent from the activity feed.
- No worker PID, command line, claim token, raw payload, or host path reaches browser DTOs.
- An integration test observes a real running worker heartbeat, then a terminal run state.
- UI tests prove stale liveness is not displayed as failure or completion.

## 12. Hermes Project integration — Planned, spike required

### 12.1 Hermes Project facts

Hermes Projects are first-class, per-profile named workspaces. A project may contain multiple folders and has:

- ID, slug, name, description, icon, color
- one primary path
- zero or more folders
- optional bound Kanban board slug
- active and archived state

Supported operations exist through profile-scoped gateway RPC (`projects.list/get/create/update/add_folder/remove_folder/set_primary/archive/delete/set_active/for_cwd`) and the `hermes project` CLI. A bound board can use the project's primary repository for deterministic worktrees and branches.

Project state is **per profile**. Vibe City must not assume a project created for one profile exists for the department's chief or worker profile.

### 12.2 Product mapping

A Vibe City department may have one logical Project binding. Because Hermes stores Projects per profile, the backend represents it as role-specific verified resources behind one user-facing project:

```ts
interface DepartmentProjectBinding {
  configured: boolean;
  name: string | null;
  slug: string | null;
  primaryFolderLabel: string | null;
  chiefProjectRef: string | null;
  workerProjectRef: string | null;
  boardSlug: string | null;
  origin: 'created' | 'associated' | null;
  verified: boolean;
  verifiedAt: string | null;
}
```

Host paths remain server-side. Browser DTOs receive labels, never absolute paths.

### 12.3 Required integration behavior

- Project support is optional; departments without a Project continue to work.
- The default managed flow creates/adopts equivalent role-local Projects for chief and worker, with deterministic naming, the configured primary folder, and the department board binding.
- Associating an existing Project requires explicit user selection and must not mutate its folders, primary path, board binding, or metadata without confirmation.
- Provisioning verifies project existence, folder membership, primary path, and board binding through supported interfaces.
- Reconciliation detects missing or drifted managed Projects and repairs them idempotently; associated Projects are reported as drifted and are not silently rewritten.
- Quest and worker task creation uses the verified Project reference so Hermes can select project-aware workspaces/worktrees.
- Explicit scratch work remains possible and means no Project for that task.
- Project archive/delete in Hermes is never inferred from archiving a Vibe City department. Vibe City retains Hermes resources unless the user invokes a separate explicit cleanup operation.
- The existing department workspace setting becomes the seed/primary folder for a Project, but remains advisory unless Hermes executes the task in an actually isolated backend.
- The UI must not describe a Project as a sandbox. A Project organizes sessions, folders, boards, worktrees, and branches; it does not restrict filesystem access.

### 12.4 Required discovery spike before implementation

The adapter must verify against the installed Hermes version:

1. Which supported server-side interface Vibe City can use for profile-scoped Project operations without direct DB access.
2. Whether project IDs are stable or role-local when equivalent Projects are created for chief and worker.
3. How a chief-created child task propagates `project_id` across profiles.
4. Whether board-level `project_id` metadata is enough, or task creation must always set `project_id` explicitly.
5. Exact behavior for non-git folders, git repositories, existing worktrees, dirty trees, and branch collisions.
6. Whether board binding is one-to-one or may safely be mirrored across profile-local Projects.
7. Cleanup and recovery behavior after interrupted Project creation.

No UI may claim Project-backed execution until this spike passes with a real chief → worker quest.

### 12.5 Project acceptance criteria

- Managed and associated Project flows have separate tests.
- Two profiles with role-local Project state can execute one chief → worker quest against the intended repository.
- Project and board creation are idempotent across retries and backend restarts.
- Browser responses contain no absolute host paths.
- A task shows its workspace mode (`scratch`, `dir`, or `worktree`) and Project label truthfully.
- Worktree branch selection is reported from Hermes, not guessed.
- Archiving a department does not delete its Project, board, profiles, worktrees, or results.
- Hermes outage produces disconnected/unknown Project verification rather than deleting the last verified binding.

## 13. Security and privacy

- Dashboard token stays server-side.
- Browser WebSocket connections are origin-checked and connect only to Vibe City.
- Hermes WebSocket payloads are normalized; payload bodies are never relayed.
- Validation errors never echo host paths.
- CLI integration uses argument arrays without a shell and validates identifiers.
- Existing profile/Project mutation requires explicit confirmation.
- Attachment authorization includes board and quest-tree membership.
- Vibe City never holds signing keys or moves funds.

## 14. Testing contract

`npm test` must remain independent of a live Hermes instance and use fakes for unit/domain/API behavior. Live suites are separate and explicit.

Required local gates for a product change:

1. workspace typecheck
2. unit tests
3. web build
4. schema and route tests for changed DTOs
5. security regression tests for host-path and raw-payload leakage

Live Hermes gates are required when changing:

- provisioning or profile policy
- board/task semantics
- cancellation
- heartbeat/liveness
- Projects or worktrees
- gateway/dashboard compatibility

A live gate must record the Hermes version tested. Unsupported behavior must be labelled honestly rather than simulated as success.

## 15. Current gaps and next milestones

| Priority | Work | Status |
|---|---|---|
| P0 | Keep this specification synchronized with schemas and behavior | Active rule |
| P0 | Worker heartbeat/liveness DTO, adapter, aggregation, and UI | Planned |
| P0 | Hermes Project discovery spike across chief and worker profiles | Planned |
| P1 | Project provisioning, verification, reconciliation, and task linkage | Blocked on spike |
| P1 | Update stale architecture language now that the city renderer is integrated | Partially addressed by this spec |
| P1 | Per-department worker settings: how many ephemeral chief-copies a chief may use, and permanent specialized workers (hiring process to be designed) | Next, design required |
| P2 | Real Hermes company board (backlog, Executive Office routing, quests spanning departments): spike on links between boards first | Deferred |
| P1 | Add automated contract/drift checks for public routes and schemas | Planned |
| P2 | Decide whether persistent worker rosters, hiring approvals, and an organization chart belong in the product model | Decision required |
| P2 | Decide whether to add a department artifact library over authorized quest attachments | Decision required |
| P2 | Decide whether interactive session `/heartbeat` automation has a Vibe City product use case | Decision required |
| P2 | NEAR AI Cloud model catalogue | Not implemented |
| P2 | NEAR Agent Market assignments and payouts | Not implemented |
| P2 | Treasury/Trezu/Sputnik DAO read and draft flows | Not implemented |

## 16. Explicitly out of scope today

- Fabricated demo state in the production/live path
- Direct browser access to Hermes
- Direct Hermes SQLite access
- Claims of filesystem sandboxing on the local backend
- Agent-held wallet keys or autonomous fund transfers
- Session `/heartbeat` automation until its user story is defined
- Project deletion as a side effect of department archive
- Automatic modification of existing profiles or Projects without consent
- Persistent employee records, chief-proposed hiring, and executive hiring approvals
- Per-worker profile inventories; the implemented policy is department inventory narrowed to chief/worker roles
- A centralized organization chart or cross-department quest coordinator
- A department-wide artifact index, workspace crawler, or interactive bookshelf
- Replacing the working Canvas 2D renderer with PixiJS without a separate approved migration
