# HERMES_COMPATIBILITY.md

Phase 0 spike findings. Status: **Phase 0 complete. Gate 0 PASSED** (real chief -> worker delegation, result retrieved via API) **with documented limitations** (section 6).

- Date: 2026-10-29
- Hermes: `Hermes Agent vgit.fcc26fb (2026.9.24)`, git install at `~/.hermes/hermes-agent`, Python 3.14.8
- Node: v26.12.0, npm 11.20.0 (pnpm not installed)
- Note: the first `hermes` invocation finished an interrupted self-update (rebuilt TUI/web UI, synced bundled skills). Default model shown by `hermes profile list` afterwards was `gpt-6.1-sol` (`hermes status` earlier showed `anthropic/claude-opus-4.6`); check which one is intended.

## 1. Integration surfaces (confirmed)

| Surface | Detail | Verdict |
|---|---|---|
| **Kanban REST API** | Dashboard plugin `plugins/kanban/dashboard/plugin_api.py`, mounted at `/api/plugins/kanban/*` on `hermes dashboard` (default `127.0.0.1:9119`). Thin wrapper over `hermes_cli.kanban_db` (same code path as CLI). | **Use this as the primary adapter.** |
| **Kanban events** | WebSocket `/api/plugins/kanban/events?since=<event_id>&board=<slug>`, tails append-only `task_events` (polling server-side). Resumable by event id. | Use for live updates; dedupe by event id. |
| **CLI** | `hermes kanban ... --json` (`list`, `show`, `runs`, `attachments`, `dispatch`, `tail`, ...), `hermes profile create/list/describe`, `hermes tools enable/disable`. | Fallback / profile management. |
| Direct SQLite | `~/.hermes/kanban.db`, `~/.hermes/kanban/boards/<slug>/kanban.db` | **Forbidden** by spec; not used. |

### Authentication (confirmed)
- Dashboard REST requires header `X-Hermes-Session-Token: <token>`; unauthenticated requests return `401 {"detail":"Unauthorized"}`.
- By default the token is minted per process start and only injected into the SPA HTML. For a backend client, **start the dashboard with `HERMES_DASHBOARD_SESSION_TOKEN=<token>`** (or `file:<path>`); the Vibe City backend holds the same token server-side only (spec §8.1: never in the browser).
- The WebSocket uses the dashboard's WS gate (`?token=` / `?ticket=`); not yet exercised.
- Vibe City must supervise/start the dashboard process (`hermes dashboard --no-open --port N`) or document it as a prerequisite.

### Worker execution requires the gateway (confirmed, important)
- The dispatcher runs **inside the gateway** (`hermes kanban daemon` is deprecated). Workers are spawned and then run via an RPC "owner" in the gateway.
- Creating a `ready` task with an assignee while no gateway runs returns a `warning` in the create response ("No gateway is running").
- One host gateway serves all profiles (`hermes gateway status`). It was auto-launched during the spike; Vibe City's runtime health check should report gateway state separately from dashboard state.
- Observed failure: two early runs crashed with `Kanban owner refused: Kanban execution unknown; retained by owner` and the task auto-blocked after 2 crashes (`kanban.failure_limit`, default 2). Cause was never isolated, because the user deleted the spike profile in the meantime and the task then showed `skipped_nonspawnable`. After recreating the profile and re-dispatching, the next run completed. Treat as an unresolved flake and re-test with the gateway running from the start.

## 2. Capability matrix vs spec

| Spec need | Finding | Evidence |
|---|---|---|
| Multiple boards (one per department) | **Supported.** `GET/POST /boards`, `PATCH/DELETE /boards/{slug}`, export/import. Slug is immutable, display name editable. Create is idempotent. Each board has its own DB, workspaces dir and dispatch loop. Per-board `default_workdir` (absolute, existing dir) and optional `project_id`. | Created `vc-spike` via POST; separate DB path returned. |
| Board lifecycle | Create, rename, archive (default) or delete. Archived boards 404. | source |
| Task create | `POST /tasks?board=<slug>` fields: `title, body, assignee, priority, workspace_kind/path, parents[], triage, idempotency_key, max_runtime_seconds, skills[], model_override, provider_override, goal_mode, ...` | Exercised (no parents). |
| Idempotency | `idempotency_key` dedups non-archived tasks. | CLI help + source |
| Parent/child | **Supported via `parents[]` on create and `POST/DELETE /links`** (dependency semantics: child waits on parent). Not exercised in the spike. | source |
| Quest grouping | Plan: quest = parent task, subtasks = children. Because parent means *dependency* (child blocked until parent done), a quest parent that gates its own children may deadlock. Needs a test; fallback is a quest as a top-level task with children linked via `--parent` reversed, or tags/body grouping. | **Open question** |
| Assignment | `assignee` = profile name. Dispatcher skips assignees without a live profile (`skipped_nonspawnable`). `kanban.dispatch_profiles` can restrict which profiles a home may claim. | Observed |
| Task states | `triage, todo, ready, running, blocked, scheduled, review, done, archived` | CLI |
| Run history | `GET /runs/{id}`, `/runs/{id}/inspect`; `hermes kanban runs <task> --json` gives per-attempt `status/outcome/error/summary/pid`. | Observed |
| Results | Task `result`, `latest_summary`, and **attachments** (`GET /tasks/{id}/attachments`, `GET /attachments/{id}`; created by the worker's `kanban_complete`). | Observed: `hello.txt` attached, summary "Created hello.txt containing exactly hello." |
| Workspace | Task `workspace_kind`: `scratch`, `worktree`, `dir:<path>`. Scratch dir was **removed after completion**, so outputs must be read from attachments, not the workspace path. | Observed |
| Comments / activity | `POST /tasks/{id}/comments`, `task_events` per task (`created, claimed, spawned, owner_admitted, worker_bound, heartbeat, attached, completed, crashed, gave_up, ...`). | Observed |
| Cancel / stop | `POST /runs/{id}/terminate` and `POST /tasks/{id}/reclaim` (SIGTERM then SIGKILL, 409 if already ended). Matches spec's "honest cancellation": confirm via run/task state afterwards. | source; not exercised |
| Pagination | Not yet checked. | open |
| Profiles | `hermes profile create <name> --clone --description ...` (CLI only; REST has `GET /profiles`, `PATCH /profiles/{name}`, `describe-auto`). Profile dir `~/.hermes/profiles/<name>/` with own `config.yaml`, `.env`, `SOUL.md`. | Observed |
| Chief concept | No native "chief". Closest native features: `decompose` (`POST /tasks/{id}/decompose`), `specify`, `swarm` (parallel workers, verifier, synthesizer) and profile `description` used for routing. A chief is a profile whose task decomposes work into child tasks assigned to worker profiles. | source; not exercised |

## 3. Chief delegation and policy tests (run 2026-10-29)

**Chief -> worker delegation: PASSED with real Hermes execution.**
Quest task `t_b4a78ed9` (assigned to profile `vc-spike-chief`) created two child tasks via its own kanban tool, each `parents=[quest]` and assigned to `vc-spike-worker`. The chief completed with a summary naming both child ids. Both children then ran and completed with summaries.

Consequences for the mapping:
- `parents` means **dependency**: children stayed gated until the chief's task was `done`. So the quest task is the chief's planning/decomposition step, and the worker tasks run *after* it. Quest status therefore does not equal "all work finished". The Quest Overview must compute progress from the children (`children[]` in `show`), not from the parent status.
- Parent/child links are visible on `show` (`parents[]`, `children[]`), so grouping needs no extra Vibe City schema.

**Policy enforcement (negative test): PARTIAL.**

| Restriction | Mechanism | Result |
|---|---|---|
| Disable tool categories | `hermes -p <profile> tools disable terminal code_execution web browser` (per-profile config, default platform `cli`) | **Enforced.** Worker reported no terminal tool exposed; `echo x` could not be attempted. |
| Confine file writes to the workspace | `workspace_kind=scratch` / `dir:<path>` | **NOT enforced on the local terminal backend.** With `file` enabled, the worker wrote `/tmp/.../outside.txt` outside its task workspace (`verified=true`). |

Therefore, per spec section 3.2, Vibe City must **not present the workspace boundary as effective** with the local backend. Options to evaluate next: (a) disable the `file` toolset for restricted departments, (b) run profiles on the `docker` terminal backend with only the workspace mounted, (c) a Hermes path-allowlist setting if one exists (not yet found). Until one is verified, the UI should label workspace scoping as "advisory".

MCP tool-level allowlisting (`server:tool` syntax) exists in `hermes tools` but has not been tested.

## 3a. Adapter proof (apps/backend)

`apps/backend/src/hermes/kanbanClient.ts` + `npm run gate0 -w @vibe-city/backend` drove the full flow over REST only (no CLI, no UI): create board, create quest for chief, chief created a child for the worker, worker completed, `notes.txt` returned via the attachments API. Observed: the `stored_path` in attachment records is an absolute host path, so Vibe City must serve attachments by id through its own authorized route, never expose that path. `GET /tasks/{id}` nests the summary differently than assumed (the script printed `undefined`); fix in the client when the Results view is built.

## 3b. Runtime checks (scripts: `apps/backend/scripts/phase0-checks.ts`, `concurrency-check.ts`)

| Check | Result |
|---|---|
| WebSocket events | **Works.** `ws://host/api/plugins/kanban/events?since=<id>&board=<slug>&token=<session token>`. Frames are `{"events":[{id,task_id,run_id,kind,payload,created_at}],"cursor":N}`. `since=0` replays full history; `since` omitted starts at the tail. Dedupe by event `id`, store the last cursor to resume after reconnect. The token goes in the query string, so keep the WS connection backend-side only and relay to the browser through Vibe City's own WS. |
| File toolset denial | **Enforced.** `tools disable file` made the worker report no file-writing tool and it did not substitute the terminal. |
| Worker concurrency | **Enforced per profile** by `kanban.max_in_progress_per_profile` in the Hermes home config (3 ready tasks, cap 1: never more than 1 running). **Read only at gateway start**; a change requires `hermes gateway restart --yes`, which interrupts live sessions. The first test without a restart ran 2 at once. The cap is per *profile*, not per department, so each department needs its own worker profile for `maxConcurrentWorkers` to mean what the UI says. It is also a host-wide setting, not per profile, so Vibe City cannot set different limits per department. A per-department limit would need Vibe City to hold back tasks itself (e.g. create them as `triage`/`todo` and promote), which is a design decision for Phase 1/2. |
| Cancellation | `POST /runs/{run_id}/terminate` returned 200 and the task went `running -> ready`, then was **claimed again immediately**. Terminate is "reclaim", not "cancel". A real cancel must also stop re-dispatch (block or archive the task). `block` on a task in a mid-reclaim state failed ("cannot block"); `archive` worked. UI must say "stop requested" until the run state is confirmed, and Vibe City needs a cancel sequence (archive or block first, then terminate, then verify) that still needs to be built and tested. |
| Hermes offline | Dashboard stopped: connections fail at TCP level (curl exit 7 / fetch rejects), no HTTP status. The adapter must map network errors to `offline` (distinct from `failed`). Board data persists in Hermes' SQLite, so state reappears after restart. |
| Docker isolation | **Not tested.** `docker` is installed but the current user cannot reach `/var/run/docker.sock` (permission denied; not in the `docker` group). Adding the user to the group is a system change I did not make. Needed to decide whether a real workspace boundary is achievable. |
| `delegate_task` | Not evaluated; Kanban dispatch met the chief->worker need. |
| Pagination | Not evaluated (boards were small). |

## 4. Proposed minimal mapping (pending items above)

- Department = one Kanban board (slug `vc-<department-id>`; slug immutable, display name editable).
- Chief and worker = named Hermes profiles; worker runs = Kanban task runs.
- Quest = top-level task assigned to the chief; the chief creates worker tasks as children (`parents=[quest]`). Children run after the quest task completes; progress derives from children.
- Results = `result` + `latest_summary` + attachments, served through a Vibe City proxy (never the raw workspace path).
- Vibe City backend talks only to the dashboard REST/WS API with the server-held session token; SQLite holds departments, inventory, and board/profile refs only.

## 5. Spike artifacts and cleanup

- Board `vc-spike` and profiles `vc-spike-worker`, `vc-spike-chief` were removed after the delegation test.
- Spike token and logs live in the session scratchpad, not in this repo.

## 6. Gate 0 verdict and limitations carried into Phase 1

Passed: real quest -> chief delegation -> worker execution -> result retrieval, over authenticated REST, no UI.

Limitations (must be reflected honestly in the product):
1. **Workspace filesystem boundary is not enforced** on the local backend. Offer only: disabling the `file`/`terminal` toolsets (enforced), and label workspace root "advisory" until Docker (or equivalent) is verified. Needs user decision: add the user to the `docker` group, or accept advisory scoping for the MVP.
2. **Concurrency** is a host-wide per-profile cap read at gateway start (see 3b).
3. **Cancel** needs a composite sequence; terminate alone re-queues.
4. **Quest progress** derives from child tasks, since children run after the quest task completes.
5. **Attachments** are served by id through Vibe City, never by host path.
6. Dashboard (with a fixed `HERMES_DASHBOARD_SESSION_TOKEN`) and gateway must both be running; Vibe City should check both.
7. Side effect on the host config: `kanban.max_in_progress_per_profile` was added to `~/.hermes/config.yaml` and left at `0`. It was not present before. Source (`kanban_ops.py`, `kanban_db_dispatch.py`) treats non-positive values as no cap, so `0` is equivalent to the original behavior; you may delete the line.

## 7. Milestone 2 findings (2026-10-29, Hermes 0.22.5 / 2026.9.24)

Verified by `npm run m2:integration -w @vibe-city/backend` (12/12 against real Hermes; creates and removes its own board and profiles).

| Topic | Finding |
|---|---|
| Health | `GET /api/status` is public and reports `gateway_running`/`gateway_state`; `GET /api/plugins/kanban/profiles` with the token verifies auth. Dashboard and gateway are separate processes and must be monitored separately. |
| Profile creation | CLI only: `hermes profile create <n> --clone --no-alias --description ...`. `--clone` copies config, credentials and skills but not sessions/memory history. REST can list and describe profiles, not create them. |
| Toolsets per profile | `hermes -p <n> tools enable/disable ...` and `tools list` (read back). Includes plugin toolsets (e.g. `a2a`). Verified: worker with only `file`+`kanban` had no terminal (agent reported `TERMINAL=unavailable`). |
| Skills per profile | `hermes -p <n> config set skills.disabled '[...]' --force` (key unrecognized by the schema but read by Hermes; confirmed via `skills list`). **`hermes-agent` is an essential skill and can never be disabled.** The `skills list` table truncates long names unless `COLUMNS` is wide; the adapter sets `COLUMNS=250` and refuses truncated output. |
| Model per profile | `config set/get model.default` works (readback only). Hermes cannot stop an agent or task from choosing another model, so allowed-model lists are not enforced. |
| Instructions | Profile directory from `hermes profile show` (`Path:`); the adapter edits only a delimited block in `SOUL.md`. |
| MCP tools | `tools enable/disable server:tool` exists, but this installation has no MCP server: nothing applied, reported `unverified`. |
| Concurrency | Only a single host-wide `kanban.max_in_progress_per_profile` (plus `max_in_progress`, `max_spawn`), read at gateway start. No per-profile or per-department value. Departments have separate worker profiles, so the cap applies per department worker, but a department-specific limit cannot be enforced. |
| Task detail | `GET /tasks/{id}` returns `task`, `links.{parents,children}`, `child_results`, `attachments` and `runs[]` (with `profile`), which is what run tracking uses. Chief run used the chief profile, children used the worker profile. |
| Dashboard under load | One slow answer from the dashboard was enough to look "down" with a single probe; GET requests are now retried once and the timeout is 15 s. |

Delegation with a minimal inventory (chief: `kanban` only; worker: `file`+`kanban`, no optional skills) worked: the chief created two child tasks for the worker, both completed, and `result.txt` was attached.

## 8. Milestone 3 findings (Hermes 0.22.5 / 2026.9.24)

| Topic | Finding |
|---|---|
| Stopping a task | `PATCH /tasks/{id} {status:"archived"}` calls `archive_task`: the task becomes terminal in one transaction (so it can never be claimed again), the open run is closed as `reclaimed`, and only afterwards the worker process is terminated (an `archive_worker_termination` event records the outcome). It also *promotes* children whose parents are now archived, so every unfinished descendant has to be archived too. |
| What not to use | `DELETE /tasks/{id}` is a HARD DELETE of the task, its comments, events and runs. `POST /runs/{id}/terminate` and `/tasks/{id}/reclaim` re-queue the task. `PATCH status=blocked` only works from `running`/`ready` and does not guarantee the worker process stops. None are used for cancellation. |
| No compare-and-set | Archive has no "only if still running" condition (`WHERE status != 'archived'`), so a task that finishes during the call is archived. Vibe City re-reads right before acting and reports the residual case. |
| Task detail | `GET /tasks/{id}` returns `task`, `links.{parents,children}`, `comments`, `events`, `attachments`, `runs`. The board listing (`GET /board?include_archived=true`) returns every task with `link_counts.{parents,children}`, enough to find top-level tasks without N+1 calls. |
| Attachments | `GET /attachments/{id}?board=` streams the file. Attachment listings include the absolute `stored_path`, which the adapter drops. Attachment ids are unique per board, not globally, so authorization must include the board and the quest tree. |
| Comments | `POST /tasks/{id}/comments {body, author}` is durable and comes back in `GET /tasks/{id}`, so it is used to record cancel intent without any extra store. |
| Events | WebSocket frames are `{events:[{id,task_id,run_id,kind,payload,created_at}], cursor}`; `since` resumes. Payloads can contain workspace paths and are never relayed. |
| Idempotency | `idempotency_key` on task creation returns the existing task for a non-archived duplicate. |
| Failures | A task that exhausts retries becomes `blocked` with `last_failure_error` / `consecutive_failures`; a deliberate worker block has `block_kind` (`needs_input`, `dependency`, `capability`, `transient`). The quest status uses the former to distinguish `failed` from `awaiting_input`. |

