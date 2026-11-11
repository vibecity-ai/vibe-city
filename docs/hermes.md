# Hermes: verified behaviors (0.22.x, dev image in docker-compose.dev.yml)

Things we learned by testing against a live Hermes. Check here before changing the adapter; do not rediscover
them with live calls.

## Services and auth

- Kanban REST lives in the dashboard plugin: `/api/plugins/kanban/*`, header `X-Hermes-Session-Token`. The
  dashboard must be started with `HERMES_DASHBOARD_SESSION_TOKEN` so we know the token. The event WebSocket takes
  the token in the query string.
- Workers run only while the **gateway** is up (the dispatcher lives there). Dashboard up + gateway down = tasks
  queue forever. `GET /api/runtime/health` reports them separately; the UI shows `gateway_unavailable`.
- A dashboard busy with CLI calls can time out once; GETs are retried once with a 15 s timeout.

## Profiles and configuration

- Profile creation is CLI-only: `hermes profile create --clone default <name>`. Per-profile config:
  `hermes -p X tools enable|disable`, `config set skills.disabled '[...]' --force`, `config set model.default`.
  CLI calls take 2 to 5 s each. The `hermes-agent` skill can never be disabled.
- The CLI's toolset view is what is enforced; the dashboard's toolset view differs. Read toolsets through the CLI.
- Hermes can install bundled skills into a profile in the middle of a sync; provisioning re-reads up to 3 rounds.
- `setProfileEnv` writes a profile's `.env` (`hermes -p X config set`). Under `gateway.multiplex_profiles` a
  profile reads secrets only from its own `.env`; a named profile never sees the owner's `API_SERVER_KEY`.
- Provider base URLs follow the `<PROVIDER>_BASE_URL` pattern in `.env`. Verify the exact NEAR AI name before
  pointing profiles at the metering proxy (brief 04).
- **NEAR AI + DeepSeek V4.x:** Hermes' default `agent.reasoning_effort: medium` is rejected by NEAR AI (HTTP 400,
  must be low | high | xhigh | max). The dev image sets `high`. `hermes config get` warns the key is "not
  recognized" but Hermes does read it.
- `hermes -p X -z "..."` (one-shot) resolves a `key_env` custom provider as `custom` and gets a 401; it is not a
  valid way to test NEAR AI calls. Test through a real Kanban task.
- **Never call Hermes' `hermes_cli.tools_config*` functions inside the container to "test in memory":** they save
  to the real `/opt/data/config.yaml`. This destroyed the dev config once (2026-11-06). Read the code instead, or
  use a throwaway `HERMES_HOME`.

## Kanban semantics

- Parent links are **dependencies**: a child waits for its parent. So the lead's task is done before teammates
  start, and quest status must be computed from the whole tree (`domain/questAggregation.ts`).
- Stopping a task: only `PATCH status=archived` is atomic (terminal + kills the worker). `DELETE /tasks/{id}` is a
  hard delete; terminate/reclaim only re-queue. Archive has no compare-and-set and promotes children of archived
  parents, so cancellation re-reads and repeats (max 5 passes).
- Concurrency is one host-wide `kanban.max_in_progress_per_profile`, read at gateway start. No per-department cap
  is possible; we report agents x cap and never call it a guarantee. The dev config sets it to 0 (no cap).
- Workspace paths are **not** isolation: an agent with the file tool can write anywhere the Hermes process can.
- Attachment records carry an absolute `stored_path`; it is dropped at the adapter boundary and never exposed.
  Attachment ids are per board.
- Uploading (v0.22.6): `POST /tasks/{id}/attachments?board=` takes multipart `file` plus optional `uploaded_by`,
  caps a file at 25 MB (413), keeps only the basename and picks a free name on collision. The worker's context lists
  a task's attachments with their paths; agents also have the `kanban_attachments` tool. There is no way to create
  a task held until its files arrive (triage tasks may be auto-decomposed), so the CEO's reference files are uploaded
  right after creation, the brief names them and tells the lead to wait for any not listed yet.
- Task events include plumbing (heartbeats); `domain/activity.ts` filters them.
- Profile env (v0.22.6): `hermes -p <profile> config set NAME value` writes any UPPER_SNAKE name to that profile's
  `.env` (Hermes refuses its own denylist, e.g. PATH); `config unset NAME` removes it and exits non-zero when the name
  is not there. A floor's own variables (`domain/departmentEnv.ts`) use both.

## MCP and chat

- Chat (`api_server` platform) gets **every** enabled MCP server unless the platform's list names one; naming a
  server turns the list into an allowlist. `tools enable` rejects MCP names, but later saves preserve them.
- Each department has one MCP bearer token, issued after every sync that changed something and registered in all
  of its profiles. The MCP server resolves the department from the token (`mcp/server.ts`).
- Skill loads in chat (v0.22.6, read in `gateway/platforms/api_server.py`, not a live call): the session chat stream sends
  `tool.started` with `tool_name`, `preview` and `args`; loading a skill is `tool_name: "skill_view"`, `args.name` = the
  skill. `tool.completed` carries no args.
- A chat turn Hermes did not finish (`completed: false`) is an error, never a reply. Reading Hermes' stream to the
  end even when the browser leaves matters: disconnecting would interrupt the run.

## Blueprints and cron

- A Hermes "automation blueprint" is a skill with a `metadata.hermes.blueprint` block in `SKILL.md`; filling it in
  creates an ordinary Hermes cron job, standalone and off the Kanban board, with no REST API. Vibe City's loops use
  `ScheduleService` (cron to quest on the board) so they show in the city; `cronjob` stays disabled on agents.
