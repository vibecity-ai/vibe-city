# Vibe City

A city UI over Hermes, the Nous Research agent runtime.

Vibe City turns an agent runtime into a company you can watch and run from one screen. It draws the company as a tower: each department is a floor, each agent is a Hermes profile (a lead plus up to 10 teammates), and each quest is a task tree on that department's Hermes Kanban board. You build a floor, sync it, hand the lead a quest, and follow the work as it descends from the lead to the desks. Vibe City stores no quest data of its own — Hermes runs everything, and Vibe City is the window onto it.

## Highlights

- **A live city, not a dashboard.** `apps/web/src/town/world/City.ts` renders the tower with Canvas 2D; each floor is a department, each desk an agent whose status comes from its live task. The view model is derived by the pure, tested `apps/web/src/town/data/derive.ts`.
- **One data source, honest refresh.** `apps/web/src/town/data/live.ts` loads REST snapshots, listens on `/api/live`, and turns snapshot diffs into animations. A failed refresh keeps the last good data and marks it stale; an older response never overwrites newer state.
- **Department provisioning with a real "Sync".** `apps/backend/src/domain/provisioningService.ts` applies the department inventory (toolsets, skills, model, a delimited `SOUL.md` block) to every agent profile, reads it back, and only then reports the department `ready`.
- **A quest board over Hermes Kanban.** `apps/backend/src/domain/questService.ts` treats a quest as a top-level task on the department board, assigned to the lead; `apps/backend/src/domain/questAggregation.ts` computes quest status from the whole task tree (`queued`, `planning`, `running`, `in_review`, `awaiting_input`, `failed`, `cancelling`, `cancelled`, `completed`) with counts, not percentages.
- **Cross-department requests, and chat that can read but not act.** `apps/backend/src/mcp/server.ts` exposes the `vibecity` server — `list_departments`, `request_quest`, `check_request` — to agents, replacing Hermes' delegation toolset so cross-department work goes through Vibe City's rules (a quest on the other board, or a wait for the CEO's approval). A second entry, `vibecity-chat`, gives the dialogue chat only `list_task_files` and `read_task_file`, so chat can read past work but cannot start any.
- **Guarantees are proven, or labeled.** `apps/backend/src/domain/inventoryPolicy.ts` reports each capability as `enforced` (applied, read back, and tested to hold at runtime), `configured`, `unverified`, or `unsupported`. Only `enforced` counts as a guarantee; file isolation and delegation depth are labeled advisory.
- **Hiring that provisions for real.** `apps/backend/src/domain/hiringService.ts` (AR) scouts candidates from what Hermes actually has — its models and installed skills — and an accepted offer adds one agent and re-provisions the department through the normal path, which creates that agent's Hermes profile.
- **An offline demo with fakes.** `apps/backend/scripts/demo-server.ts` runs the real backend and web app against `FakeHermes`, `FakeKanban` and a scripted chat model, with no Docker, Hermes, network or API key.

## Architecture at a glance

The repo is an npm workspace. `packages/shared` holds the zod schemas and types that are the single contract between backend and web: every request and response body is parsed with the same schema on both sides, and unknown fields are rejected. `apps/backend` is a Fastify API over SQLite via `node:sqlite`, wired to Hermes through a `HermesRuntime` port, plus the MCP server agents call back into. `apps/web` is a React + Vite app whose town UI (`src/town`) is the whole product.

Two rules shape the backend. Hermes is reached only through the `HermesRuntime` port (`src/hermes/ports.ts`) — `realRuntime.ts` is the real one, `src/testing/fakeHermes.ts` the fake — so a new capability is a method on the port implemented in both, and tests never need Hermes, Docker or a network. And every route lives behind `src/app.ts` as a hub, with new endpoints in `src/routes/`; error mapping and validation happen there.

```
packages/shared      zod schemas + types shared by backend and web
apps/backend         Fastify API, SQLite (node:sqlite), Hermes adapter
  src/db             migrations + openDb
  src/domain         company, department, provisioning, quest and chat services
  src/hermes         ports.ts (HermesRuntime interface), realRuntime.ts
                     (dashboard REST + `hermes` CLI), kanbanClient.ts
  src/mcp            the Vibe City MCP server that Hermes agents call
  src/testing        FakeHermes / FakeKanban, used by tests and the offline demo
  src/app.ts         routes + validation + error mapping
  scripts/           demo-server.ts (offline demo with fakes)
apps/web             React + Vite. src/town = the city (Canvas 2D, Zustand)
```

**Hub and spokes.** The backend is the only thing that talks to Hermes. A department's Hermes board is `vc-<department uuid>` and each agent is its own Hermes profile (`vc-<12 hex>-chief` for the lead, `-w01`, `-w02`… for teammates), cloned from Hermes' `default` profile. Quests never live in Vibe City: a quest id *is* a Hermes task id, every quest route resolves the board and profiles from the stored department rather than from the request, and creation uses the idempotency key `vibe-city:<departmentId>:<clientRequestId>` so a retry returns the same task.

**The mapping.** The vocabulary maps one-to-one onto Hermes:

| Vibe City | Hermes |
|---|---|
| Quest | top-level task on the department board, assigned to the lead's profile |
| Teammate task | any descendant task, assigned to one of the department's agent profiles |
| Result | task result / latest run summary, plus attachments |
| Activity | task events |

**Live updates.** The backend holds one token-authenticated WebSocket per watched board to Hermes' Kanban event stream and relays normalized refresh hints over `/api/live`; the browser then refetches REST snapshots. Snapshots are the truth, events are only hints.

**The city.** The city at `/` is the whole product. A floor shows a department, and its desks show agents; panels cover the Executive Office, department setup and settings, the agent view and chat, the company quest board, and quest detail with tasks, results and cancellation. Copy and rules live in `apps/web/src/town/data/views.ts`; the pure derivations are tested next to their source. `docs/briefs/` holds the hackathon plan behind the wider features (templates, hiring, money, the game loop, the IPO).

## Data ownership

- **SQLite** (`VIBE_CITY_DB`, default `apps/backend/data/vibe-city.sqlite`) holds only Vibe City's own data: the company, departments and their inventory, agents (one row per seat), chat transcripts and event cursors. Migrations are append-only; a DB newer than the build is refused.
- **Hermes** owns everything that runs: profiles, boards, tasks, runs, results and attachments. Vibe City has no quest or task table and never reads Hermes' databases; it talks to Hermes only through the `HermesRuntime` port (the dashboard REST API with the session token held server-side, and the `hermes` CLI via `execFile`, no shell).
- **The browser** talks only to the Vibe City backend (`/api`, `/api/live`). It never sees the Hermes URL, token or raw payloads; every body goes through the shared zod schemas, and unknown fields are rejected.

## Getting started

Prerequisites:

- **Node 26** (the backend uses `node:sqlite` and `--experimental-strip-types`; CI pins `node-version: 26` and the image builds on `node:26-trixie-slim`; the repo declares no `engines` field).
- **Docker + Docker Compose** — optional. Needed only for the full container and for `npm run dev` (which runs Hermes in Docker); the unit tests and the offline demo need no Docker.

Commands (from the root `package.json` scripts, run at the repository root):

```
npm install              # installs all workspaces
npm test                 # backend + web unit tests, no Hermes needed
npm run build            # builds the web app (@vibe-city/web)
npm run dev              # Hermes in Docker (docker-compose.dev.yml) + backend :4100 + Vite :4200
```

`npm run dev` starts: Hermes gateway + dashboard in Docker from `docker-compose.dev.yml` (Hermes data in `./.dev/hermes`), the backend on `http://127.0.0.1:4100` (`npm run dev:backend`), and Vite on `http://localhost:4200` (`npm run dev:web`, hot reload, proxies `/api` to the backend). Ctrl+C stops the backend and web app; Hermes keeps running — stop it with `npm run dev:hermes:down`. This path needs Linux (the dev compose file uses host networking) and a `.env` with `HERMES_DASHBOARD_SESSION_TOKEN` set; see Configuration below and `DEPLOYMENT.md`.

## Offline demo

The real backend and web app with in-memory fakes for Hermes, Kanban and the chat model — for UI work without Docker or API keys.

```
npm run build && WEB_DIST=../web/dist PORT=4199 npm run demo -w @vibe-city/backend
```

Then open <http://127.0.0.1:4199> in a browser. Nothing here talks to a real service: no Docker and no API keys are needed (set `NEAR_AI_API_KEY` only if you want to chat with the real model instead of the scripted one).

## Deployment

The whole stack ships as **one container** (`Dockerfile`): Hermes gateway (the CMD), the Hermes dashboard (loopback `127.0.0.1:9119` inside the container) and Vibe City — API + built web app — as an s6 service listening on `0.0.0.0:4100`, published on host loopback (`127.0.0.1:${VIBE_CITY_PORT:-4100}:4100`).

Create `.env` from the example, set a session token in it (for example `openssl rand -hex 24`), then start the stack:

```
cp .env.example .env
docker compose up -d --build
```

Then open <http://127.0.0.1:4100> in a browser.

State lives in one volume (`/opt/data`): the Hermes home and Vibe City's SQLite (`/opt/data/vibe-city/vibe-city.sqlite`). Deployment is not automated (no target chosen); CI (`ci.yml`) runs `npm ci`, typecheck, tests and the web build. See `DEPLOYMENT.md` for the full runbook, the Hermes image pin and known risks — it records that the container has not yet been built or run end to end, so treat the first `docker compose up --build` plus `scripts/docker-smoke.sh` as the real test.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HERMES_URL` | `http://127.0.0.1:9119` | Base URL of the Hermes dashboard REST API. |
| `HERMES_DASHBOARD_SESSION_TOKEN` | — (required) | Shared secret/auth token for the Hermes dashboard; held server-side, never sent to the browser. |
| `HERMES_BIN` | `hermes` | The `hermes` CLI the backend drives; the dev setup sets it to `../../scripts/hermes-docker`, a `docker exec` wrapper. |
| `NEAR_AI_API_KEY` | — | Key for the OpenAI-compatible model endpoint (NEAR AI Cloud); server-side only. |
| `VIBE_CITY_DB` | `data/vibe-city.sqlite`, relative to the backend's working directory (`apps/backend/data/vibe-city.sqlite` in the host dev flow; the container sets `/opt/data/vibe-city/vibe-city.sqlite`) | Path to Vibe City's own SQLite database. |
| `VIBE_CITY_MCP_URL` | `http://127.0.0.1:<PORT>/mcp` | Where Hermes reaches the Vibe City MCP server; empty string disables registration. |
| `VIBE_CITY_PORT` | `4100` | Host port the container's `4100` is published on. |
| `PORT` | `4100` | The backend's listen port. |
| `ALLOWED_ORIGINS` | `http://127.0.0.1:4100,http://localhost:4100` | Comma-separated browser origins allowed to open the live WebSocket. |
| `WEB_DIST` | — (unset = API only) | Directory of the built web app for the backend to serve. |
| `NEAR_AI_BASE_URL` | `https://cloud-api.near.ai/v1` | OpenAI-compatible chat endpoint. |
| `NEAR_AI_MODEL` | `deepseek/deepseek-v4.1-flash` | Default model for a fresh Hermes home. |

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the pieces fit: data ownership, quests, the MCP server, the city UI.
- [DEPLOYMENT.md](DEPLOYMENT.md) — the container, local dev, model configuration and risks.
- [CLAUDE.md](CLAUDE.md) — working notes for agents, commands.
- [docs/hermes.md](docs/hermes.md) — verified Hermes behaviours, checked against a live instance.
- [docs/briefs/](docs/briefs/) — the hackathon plan and per-workstream briefs.

## Repository layout

```
.github           CI workflow (typecheck, tests, web build)
apps/             backend (Fastify API + SQLite) and web (React + Vite town UI)
docker/           s6 service for Vibe City and the NEAR AI Cloud cont-init script
docs/             hermes.md (verified Hermes behaviour) and briefs/ (the hackathon plan)
packages/         shared zod schemas + types
scripts/          hermes-docker wrapper, docker-smoke.sh, build-hermes-image.sh
```

Root files include `package.json` (the workspace scripts above), `.env.example`, `Dockerfile`, `docker-compose.yml`, `docker-compose.dev.yml`, `ARCHITECTURE.md`, `CLAUDE.md`, `DEPLOYMENT.md` and `tsconfig.base.json`. `docker/skills/` is a vendored copy of third-party agent skills, each with its own licence file.
