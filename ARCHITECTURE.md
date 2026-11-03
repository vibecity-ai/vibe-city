# Vibe City: Architecture (through Milestone 3 and the city UI merge)

> This document records implementation architecture through Milestone 3 and the city UI merge.

## Layout

```
packages/shared      zod schemas + types shared by backend and (later) web
apps/backend         Fastify API, SQLite (node:sqlite), Hermes adapter
  src/db             migrations + openDb
  src/domain         company/department services, workspace validation
  src/hermes         ports.ts (HermesRuntime interface + error classes), realRuntime.ts (dashboard REST + `hermes` CLI),
                     kanbanClient.ts (Kanban REST)
  src/testing        FakeHermes (in-memory, fault injection) used only by tests
  src/app.ts         routes + validation + error mapping
  scripts/           Phase 0 integration scripts (need live Hermes; NOT in `npm test`)
apps/web             React + Vite. src/town = the city (imported from the vibeytown prototype, Canvas 2D, Zustand)
```

## Data ownership (Milestone 1)

SQLite (`VIBE_CITY_DB`, default `apps/backend/data/vibe-city.sqlite`) holds Vibe City's own data only:
`company` (singleton row), `department`, `department_inventory`. No Hermes Kanban tables are copied.
Schema changes are append-only entries in `MIGRATIONS` (`PRAGMA user_version`); a DB newer than the build is refused.

## Decisions

- **Executive Office** is logical, not a row: it appears first in `GET /api/company` `floors` and has no routes, so it can't be deleted or edited.
- **Floor order** (changed in Milestone 2): `floor_order` is a stable *creation id* (monotonic, UNIQUE, never renumbered or reused). The visible `floorPosition` is computed from active departments, newest first: a new department appears directly below the Executive Office and older ones shift down. Archiving removes a floor and closes the gap; reloading yields the same order.
- **Department state** = provisioning state, written only by the provisioning service: `unconfigured | provisioning | ready | error | disconnected` (see below). Setting profile refs or editing the PATCH body never makes a department ready.
- **Board slug** = `vc-<department uuid>` (immutable; valid under Hermes' slug rule). Never derived from the name.
- **Delete = archive.** Row, inventory and Hermes refs are kept; nothing in Hermes is touched. Names of archived departments can be reused; slugs and floor numbers can not.
- **Inventory** is department-level only: skills, MCP tools (`server:tool`), models, toolsets, shared context refs, limits. Agent-level permissions will be derived (department ∩ role ∩ task), not stored.
- **Workspace**: the host path is stored server-side and never returned; the API exposes `{configured, label, isolation}`. `isolation` is always `unverified`: Hermes' local backend does not confine file access (see compat doc), so a configured workspace is advisory.
- **Concurrency**: `limits.maxConcurrentWorkers` is a *requested* limit. Hermes has only a host-wide per-profile cap (read at gateway start), so it is not guaranteed per department.
- **Validation**: all request bodies and responses go through the shared zod schemas; unknown fields are rejected (400). Error messages never echo host paths.

## REST API

| Route | Notes |
|---|---|
| `GET /api/company` | company, Executive Office, ordered `floors` |
| `GET /api/departments[?includeArchived=true]` | ordered by floor |
| `POST /api/departments` | `{name, purpose?, workspace?, inventory?}` -> 201; 409 on duplicate active name |
| `GET /api/departments/:id` | archived ones included |
| `PATCH /api/departments/:id` | `name, purpose, workspace, chiefProfileRef, workerProfileRef`; 409 if archived |
| `DELETE /api/departments/:id` | archive; returns `hermesResourcesRetained` |
| `GET/PATCH /api/departments/:id/inventory` | PATCH merges; `limits` merged field by field. Editing a provisioned department's inventory sets it back to `unconfigured` until re-provisioned |
| `POST /api/departments/:id/provision` | idempotent; runs synchronously; 409 if already in progress |
| `POST /api/departments/:id/provision/retry` | only from `error`/`disconnected` (409 otherwise) |
| `GET /api/departments/:id/provisioning` | state, structured error, per-resource verified flags, inventory sync |
| `GET /api/departments/:id/profiles` | chief/worker profiles with live Hermes data (`reachable:false` + stored refs when Hermes is down) |
| `GET /api/departments/:id/effective-inventory` | per-role capability report (`enforced | configured | unverified | unsupported`) |
| `GET /api/runtime/health` | dashboard, token and gateway status (separate fields) |
| `POST /api/runtime/reconcile` | one reconciliation sweep (also runs every `RECONCILE_INTERVAL_MS`, default 30s) |

PATCH `/api/departments/:id` still accepts `chiefProfileRef` / `workerProfileRef`. Meaning: `null` (default) = Vibe City creates a managed profile `vc-<12 hex of uuid>-chief|worker` (cloned from the default profile); a name = *associate* an existing Hermes profile (must exist; not `default`; not shared with another department; chief != worker). Changing a ref resets verification.

### Safeguard: existing profiles are never modified silently

Provisioning applies department restrictions (toolsets, skills, model default, a SOUL.md block) to the department's chief and worker profiles. For an **associated** profile that would also change how it behaves outside Vibe City, so it is refused until the user consents: `PATCH /api/departments/:id { "confirmModifyProfiles": ["<profile>"] }`. Rules:

- Without consent, provisioning stops in the `validate` step with `error.code = confirmation_required` (not retryable), before anything is created or changed in Hermes (no board, no profile writes). `GET .../provisioning` shows `modificationConfirmed: false` on that profile (`null` for Vibe City-created profiles, where it does not apply).
- Consent is per profile name. Changing the ref revokes it; confirming a name that is not the department's chief/worker is a 400.
- Background reconcile never "heals" an associated profile without consent; it reports the drift.
- Withdrawing consent does not undo earlier changes to the profile; it only prevents further ones.
- The recommended path is the default (a Vibe City-managed clone), which needs no consent. The UI should present "use a managed profile" as the default and show the consent as a clear warning naming the profile.

### Safeguard: guarantees versus configuration (UI requirements)

Every capability entry has `status` and `guarantee`. `guarantee` is true **only** for `enforced`. The Department Inventory UI must follow these rules:

1. Show `enforced` (a restriction that was applied, read back from Hermes, and tested to hold at runtime) separately from `configured` ("set in Hermes, behavior not tested"), `unverified`, and `unsupported`. Use different wording, not just different colors, and never a lock/shield style for anything with `guarantee: false`.
2. **Workspace isolation** and **worker delegation depth** are never guarantees. Verified: an agent with file tools can write outside its workspace; workers keep the Kanban tools and can create tasks. Label them as advisory ("configured path, not a sandbox", "instructed, not enforced"). Do not describe a workspace as "isolated" or "secured", and do not offer "depth limit" as a safety setting.
3. Enforceable controls to offer prominently: disabling toolsets (notably terminal, file, web, browser, code_execution). Even these are tested restrictions on one Hermes version, not a hard sandbox; show the tested-on version where space allows.
4. The requested worker limit is a request unless it equals the host-wide Hermes cap; show the host-wide value next to it.
5. Render the entry `detail` text; it states the limitation in plain words. Do not summarize "everything is secured" from an overall state of `ready`: `ready` means resources exist and match the inventory, not that every inventory item is enforced.

## Running

Container/CI deployment: see `DEPLOYMENT.md` (written, not yet run).

```
npm install
npm test                                  # no Hermes needed
npm run dev:backend                       # http://127.0.0.1:4100 (WEB_DIST=apps/web/dist also serves the built web app) (HOST, PORT, VIBE_CITY_DB to override)
npm run gate0 -w @vibe-city/backend       # integration scripts: need Hermes dashboard + gateway + profiles
```

## Hermes integration (Milestone 2)

Vibe City talks to Hermes only through the `HermesRuntime` port. `RealHermesRuntime` uses supported interfaces: the dashboard REST API (`X-Hermes-Session-Token`, token held server-side, never serialized) for health, profile listing, boards and tasks, and the `hermes` CLI (`execFile`, no shell, validated names) for profile creation and per-profile configuration. It never reads or writes Hermes' databases or source. CLI stderr (which can contain host paths) goes to the server log, not API errors.

Configuration (env): `HERMES_URL` (default `http://127.0.0.1:9119`), `HERMES_DASHBOARD_SESSION_TOKEN` (must equal the token the dashboard was started with), `HERMES_BIN`, `RECONCILE_INTERVAL_MS`. Vibe City does not start or reconfigure Hermes services; the dashboard and gateway must be running.

### Provisioning lifecycle

```
unconfigured --provision--> provisioning --ok--> ready
                                 |--Hermes unreachable / drops--> disconnected --retry or reconcile--> provisioning/ready
                                 |--invalid config / auth / verification failure--> error --retry--> provisioning
ready --Hermes down--> disconnected --Hermes back & verified--> ready
ready --resource missing or drift--> (reconcile re-runs provisioning) 
ready --inventory/profile/name/purpose edit--> unconfigured
```

`disconnected` = temporary availability problem. `error` = something must change (token, missing associated profile, archived board) or verification failed; `error.retryable` says whether a plain retry can help. Steps are `health -> validate -> board -> chief -> worker -> inventory -> verify`; each verified resource is persisted immediately (`*_verified_at`, `*_origin`), and every run re-verifies against Hermes. Resources have deterministic names (`vc-<uuid>` board, `vc-<12hex>-chief|worker`), and an existing derived resource is adopted, so a crash between "create" and "record" cannot cause duplicates. A department is `ready` only after the final verification step; concurrent provisioning of one department is refused. A restart turns a stuck `provisioning` into a retryable `error: interrupted`.

Reconcile (background + `POST /api/runtime/reconcile`) only touches `ready`/`disconnected` departments: it marks them `disconnected` when Hermes is down, returns them to `ready` when everything verifies, and re-runs the idempotent provisioning when something vanished or drifted (an *associated* profile that vanished is an error; it is never recreated).

### Inventory application

Policy is `Department ∩ Role` (task-level narrowing is Milestone 3), applied per profile and read back from Hermes:

- **Toolsets**: every toolset Hermes lists is set explicitly (enabled iff effective). `kanban` is always on (required for task reporting). Chief and worker both get the department allowance minus `delegation, cronjob` (sub-agents and cron jobs would run outside the department board). Workers are optional: `limits.maxConcurrentWorkers` defaults to 0, and then no worker profile is provisioned and the chief is instructed to do the work itself. The create-department form pre-fills toolsets, skills and model from Hermes' `default` profile (`GET /api/runtime/defaults`); the values are copied into the department inventory once, at creation.
- **Skills**: installed skills not in `allowedSkillIds` are disabled (`skills.disabled`).
- **Models**: the inventory holds one `model: { provider, id }` (or null = leave the profile alone), chosen from Hermes' model picker data (`GET /api/runtime/models`, proxied from the dashboard's `GET /api/model/options`: authenticated providers only). Provisioning sets the pair through the dashboard's `POST /api/model/set?profile=` (scope `main`), which validates it against the provider; drift is checked on the model id. Inventories stored with the older `allowedModelIds` list are migrated on read by dropping the list (a bare id has no provider).
- **Instructions**: department purpose, role rules and shared-context *references* go into a delimited block in the profile's `SOUL.md`; everything else in the file is preserved.
- **MCP tools**: not applied (no MCP server available to verify against); reported `unverified`.

The effective-inventory endpoint labels each capability: `enforced` (applied, read back, and behavior tested against real Hermes: terminal/file/web/browser/code_execution), `configured` (read back, behavior untested), `unverified`, or `unsupported` (workspace isolation, model restriction, delegation depth for workers, per-department concurrency). Concurrency: Hermes has one host-wide per-profile cap; a requested limit is reported `configured` only if it equals that cap, otherwise `unsupported`.

### Run references

`run_reference` stores Hermes task/run ids (plus role, profile, observed state) for correlation; `RunTracker.observe` records the runs of a quest and its children and flags any run whose profile is not the department's chief/worker. Hermes Kanban remains the source of truth; there is no Vibe City scheduler.

### Tests

`npm test` (no Hermes; uses `FakeHermes`): schema, API, floors, policy, parsers, provisioning state machine, reconciliation. `npm run m2:integration -w @vibe-city/backend` and the Phase 0 scripts need a live Hermes and are never run by `npm test`.

## Quests (Milestone 3)

**Hermes Kanban is the only store of quest data.** Vibe City has no quest or task table. The only new SQLite object is `event_cursor` (board slug -> last relayed event id) so the live stream can resume. Everything below is derived from Hermes on each request.

### Model

| Vibe City concept | Hermes object |
|---|---|
| Quest | top-level task (no parents) assigned to the department's chief profile, on the department's board |
| Worker task | any descendant task; expected to be assigned to the department's worker profile |
| Result | task `result` / latest run summary, plus attachments |
| Activity | task events (plumbing events such as heartbeats are dropped) |
| Cancellation intent | a comment on the quest root, `[vibe-city] cancel-requested`, authored by `vibe-city` |

A quest id is a Hermes task id. Every quest route resolves the board and the chief/worker profiles from the stored, verified department record (never from the request), and a task id is accepted as a quest only if it exists on that board, has no parents and is assigned to that chief. Other ids (worker tasks, other departments' tasks, malformed ids) are `404`. Attachment downloads are authorized against the quest's own task tree.

### Status aggregation (`domain/questAggregation.ts`)

Hermes parent links are execution dependencies, so the chief's task is normally `done` before any worker starts. **Root status says nothing about the quest.** The status is computed from the whole tree (root and all descendants, any depth, bounded to 200 tasks / 8 levels). "Live" = not `done` and not `archived`. First match wins:

1. Cancellation requested: nothing live and no open run -> `cancelled` (or `completed` if everything had already finished); otherwise `cancelling`.
2. Nothing live and no open run: any archived task -> `cancelled`; else `completed`.
3. Any running task or open run -> `planning` if the chief is the only task, else `running`.
4. Any live task that failed (blocked with failure evidence) -> `failed`.
5. Any live task in review -> `in_review`.
6. Any live task blocked without failure -> `awaiting_input`.
7. Only pending tasks remain -> `queued` if nothing ever started, else `running` with `flags.idle = true`.

A running task outranks a failure elsewhere (the quest is still active) but `flags.hasFailures` still reports it. `flags.planningComplete` is the chief task being done; the UI words this as "the chief has finished planning", never as completion. There are no percentages, only counts (`tasks, done, running, pending, blocked, failed, archived`). Tasks assigned outside the department's chief/worker profiles are listed in `violations` and flagged; Hermes cannot prevent the chief from creating them, so this is detection only.

### Creation

`POST /api/departments/:id/quests {clientRequestId, title, objective, instructions?}`: the department must be `ready`. The task is created assigned to the chief with idempotency key `vibe-city:<departmentId>:<clientRequestId>`, so a retry returns the same Hermes task. The body contains the objective and the delegation workflow (create self-contained child tasks for the worker profile with `parents=[this task]`). `limits.maxTaskRuntimeSeconds` is passed as `max_runtime_seconds` (on the quest task only; the chief creates the worker tasks, which therefore do not inherit it). A Hermes warning (e.g. no gateway) is returned in `warnings`.

### Routes

`GET/POST /api/departments/:id/quests`, `GET .../quests/:questId`, `.../tasks`, `.../activity?limit=`, `.../results`, `.../attachments/:attachmentId`, `POST .../cancel` (202), `GET .../cancellation`, and the WebSocket `GET /api/live?departmentId=`.

### Results and attachments

Free text from Hermes (summaries, errors, event details) is passed through `scrubPaths`: absolute host paths become `<path>/<basename>`. Hermes' `stored_path` is dropped at the adapter boundary and never modeled. Downloads stream through Vibe City after authorizing (department -> quest tree -> attachment id), always as `application/octet-stream` with `Content-Disposition: attachment` (sanitized file name), `nosniff`, a sandbox CSP and `no-store`. There is no preview and no artifact browser.

### Cancellation

Hermes' run terminate/reclaim only re-queues a task, and `DELETE /tasks/{id}` is a hard delete; neither is used. The only REST call that both makes a task terminal and stops its worker is `PATCH status=archived`. Sequence (`QuestService.requestCancel`):

1. Write the intent comment on the quest root (once).
2. Archive every unfinished task: running ones first (so the chief stops creating tasks), then deepest first. Archive is atomic: the task becomes `archived` (never dispatched again) and only then Hermes terminates its worker. Immediately before each archive the task is re-read; a task that has finished keeps its result. The tree is re-read and the pass repeated (max 5) because the chief may create tasks meanwhile.
3. Re-read the whole tree. `confirmed` only if every task is `done`/`archived` and no run is still open. Otherwise the API answers `202` with `state: requested` and `remaining` tasks; the UI keeps polling.

Cancellation status is derived from Hermes (marker comment + task/run states), so it survives restarts and reflects outside changes. Concurrent requests for one quest are coalesced. Known residual race: Hermes has no compare-and-set on archive, so a task finishing inside Hermes' archive call ends up `archived`; it is reported under `alreadyFinishedTaskIds` (detected by its `completed` event) and its result is kept.

### Live events

`BoardStream` holds one server-side, token-authenticated WebSocket to `/api/plugins/kanban/events` per department board that has a browser subscriber (ref-counted by `LiveHub`, stopped after a grace period). It resumes with `since=<cursor>` from the persisted cursor, deduplicates by event id, and emits normalized messages only: `hermes.event {eventId, taskId, kind, at}` (no payloads), `connection {connected | reconnecting | dashboard_offline | gateway_unavailable}`, and `resync` after every (re)connect. `dashboard_offline` = Hermes web server unreachable; `gateway_unavailable` = dashboard up but no gateway, so workers cannot run (checked every 10 s while connected). Events are a refresh hint: the frontend refetches REST snapshots on any event or resync. The browser connects only to `/api/live` (origin-checked, loopback by default); it never sees the Hermes URL, token or payloads.

### Frontend (`apps/web`)

React + Vite, no state library. Department picker, quest list, create form (stable `clientRequestId` per form content), quest detail (Overview / Tasks / Activity / Results), cancellation panel, and explicit loading, empty, stale, disconnected and failure states. On a failed refresh the last good data stays visible and is labelled out of date; nothing is invented. `npm run dev:web` serves on :5173 and proxies `/api` (including WebSocket) to the backend on :4100. No PixiJS yet (Milestone 4) and no drag-and-drop board.

### Concurrency and permissions

Unchanged from Milestone 2: the requested worker limit is reported `configured` only if it equals Hermes' host-wide per-profile cap, otherwise `unsupported`; there is no Vibe City scheduler. Quest operations never touch profiles. Associated (pre-existing) profiles still require explicit confirmation before provisioning modifies them.

### Tests

`npm test` runs backend (FakeKanban, FakeHermes, a local WebSocket server standing in for Hermes) and web unit tests. Live suites are separate: `npm run m3:integration -w @vibe-city/backend` (real Hermes, real model calls) alongside the Phase 0 and Milestone 2 scripts.


## The city (apps/web/src/town)

The vibeytown prototype was copied in once (it is no longer synced from that repo) and its demo simulation replaced by a live connector. It uses Canvas 2D, not PixiJS.

- `data/live.ts` is the only data source: REST + `/api/live` (events are refetch hints), derives the view model, writes the Zustand store, and diffs consecutive snapshots into one-shot animation cues. Failed refreshes keep the last data and set `stale`. The browser never talks to Hermes.
- `data/derive.ts` (pure, tested) maps DTOs to floors. There are no persistent workers: **a desk exists only for a real worker-role Kanban task** of a live quest, status from the task (`running`, `done` -> completed, blocked+failure -> failed, everything else -> idle), up to 6 desks, kept stable per task. The chief is `running` only while its own task runs; "planning finished" is idle, never completed.
- Department state: unconfigured/provisioning -> unconfigured, error -> attention, disconnected or Hermes down -> offline, otherwise failed task -> attention, running -> active, else idle.
- Types come from `@vibe-city/shared` (zod-validated in `src/api.ts`). The inventory UI follows the guarantee rules above: enforced, configured, unverified and unsupported are separate groups with their `detail` text; workspace and delegation depth are labelled advisory.
- The department setup panel provisions (managed profiles by default; existing profiles require the explicit consent checkbox, sent as `confirmModifyProfiles`).
- `apps/web/tsconfig.json` turns off `noUncheckedIndexedAccess` because the imported renderer indexes arrays freely.

### UI merge (every backend route usable from the city)

The city at `/` is the complete product surface (the original `#board` view has been removed).

- **Panels** (`ui/Panels.tsx`): Executive Office with an Active/Archived switch (archived departments are read-only, fetched with `includeArchived=true`); department panel; **Settings** sheet (name, purpose, workspace set/clear with advisory copy, the provisioning/profile inspector, archive); inventory sheet (the floor's agents, worker desks = `maxConcurrentWorkers`, task runtime, workspace, MCP tools; the capability report is API-only); **agent view** (click a person on the floor: model, skills, toolsets, recent Hermes sessions, latest activity, shared context; edits change the department inventory shared by both roles); the **company quest board** (top bar and Executive Office; the player's only board, combining every department's quests, see `data/company.ts`; department panels link to it with a department filter); quest detail with expandable task rows (run history included), a cancellation panel and results/activity.
- **Copy and rules** live in `data/views.ts` (pure, tested): what a status means in words, which provisioning action is allowed (retry only for a retryable error or `disconnected`), the settings PATCH diff, archive consequences, cancellation wording (a 202 `requested` is never shown as cancelled).
- **Consistency** (`data/live.ts`, `data/sched.ts`): every fetch takes a ticket from a last-request-wins gate per key (department quests, local data, info, quest detail, cancellation), so an older response never overwrites newer state. Live events are coalesced per department (400 ms after the last event, at most 2 s after the first). Mutations refresh only the affected department (`GET /api/departments/:id` + its data); create and archive refresh everything because floor order changes. Archiving closes the floor's socket, pending refresh and cancellation polls. A cancellation status never regresses from `confirmed`.
- **Cancellation polling**: after a `requested` answer the UI polls `GET .../cancellation` (1, 2, 4, 8, then 10 s; 2 min budget) until confirmed, the quest view closes, Hermes/the backend is unreachable, or the budget runs out. Live events refresh the same status in between.
- **API client** (`src/api.ts`): every response, including list envelopes and the archive response (`DepartmentArchivedSchema`, `QuestTasksSchema`, ... in `packages/shared`), is parsed with a strict schema; the backend parses its responses with the same schemas. Error messages come only from the documented `message`/`issues` fields; non-JSON error bodies are never shown.
- **Accessibility**: tabs with arrow/Home/End keys, modal dialogs trap focus, close on Escape (without also leaving the floor) and restore focus; after navigation focus moves to the new panel's heading; connection, provisioning, cancellation and errors are announced through `aria-live`/`role=alert`; status always has a glyph and a word as well as a color.
- **Static serving**: unknown non-API paths fall back to the app shell only when they have no file extension; a missing `*.js`/`*.css` is a 404. (`@fastify/static` with `wildcard: false` registers the files present at startup, so a running backend does not see a later rebuild's new hashed chunks; restart it after rebuilding.)
