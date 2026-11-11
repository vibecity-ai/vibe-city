# Vibe City: Architecture

Vibe City is a city UI over Hermes (the Nous Research agent runtime): each department is a floor, each agent is a Hermes profile, and each quest is a task tree on the department's Hermes Kanban board.

## Layout

```
packages/shared      zod schemas + types shared by backend and web; src/templates = the department templates
apps/backend         Fastify API, SQLite (node:sqlite), Hermes adapter
  src/db             migrations + openDb
  src/domain         services: company, department, provisioning, quests, chat, hiring, schedules, the Chief of Staff
                     (assistantService), market, wallet, IPO, and game.ts (the CEO quest log, pure)
  src/hermes         ports.ts (HermesRuntime interface), realRuntime.ts (dashboard REST + `hermes` CLI), kanbanClient.ts
  src/mcp            the Vibe City MCP server that Hermes agents call
  src/model, near    the NEAR AI chat model and its prices; NEAR RPC reads
  src/testing        FakeHermes / FakeKanban, used by tests and the offline demo
  src/app.ts         the older routes (departments, quests, chat, hiring, schedules, live) + validation + error mapping
  src/routes         the newer route modules: company, templates, game, wallet, market, ipo, ai (the metering proxy)
  scripts/           demo-server.ts (offline demo with fakes)
apps/web             React + Vite. src/town = the city (Canvas 2D, Zustand)
contracts            the city token and its factory (Rust, NEAR); built wasm in contracts/res
docker               what the container adds to the Hermes image: cont-init scripts, the s6 service, vendored skills
```

## Data ownership

- **SQLite** (`VIBE_CITY_DB`, default `apps/backend/data/vibe-city.sqlite`) holds only Vibe City's own data: the company and its settings (including the secrets the CEO pastes: NEAR AI key, OutLayer wallet key, market tokens), departments and their inventory (toolsets, skills, model, limits), agents (one row per seat), chat transcripts, model usage per department, the IPO's state, and event cursors. Migrations are append-only (`PRAGMA user_version`); a DB newer than the build is refused.
- **Hermes** owns everything that runs: profiles, boards, tasks, runs, results and attachments. Vibe City has no quest or task table and never reads Hermes' databases. It talks to Hermes only through the `HermesRuntime` port: the dashboard REST API (session token held server-side) and the `hermes` CLI (`execFile`, no shell, validated names).
- The browser talks only to the Vibe City backend (`/api`, `/api/live`). It never sees the Hermes URL, token or raw payloads. All request and response bodies go through the shared zod schemas; unknown fields are rejected.

**Departments and agents.** A department's board is `vc-<department uuid>`. Every agent is its own Hermes profile (`vc-<12 hex>-chief` for the lead, `-w01`, `-w02`... for teammates, at most 10), cloned from Hermes' `default` profile. "Sync" applies the department inventory to every profile (toolsets, skills, model, a delimited `SOUL.md` block) and reads it back; a department is `ready` only after that verification. Deleting a department archives it: its row is kept and nothing in Hermes is deleted.

## Quests

| Vibe City | Hermes |
|---|---|
| Quest | top-level task on the department board, assigned to the lead's profile |
| Teammate task | any descendant task, assigned to one of the department's agent profiles |
| Result | task result / latest run summary, plus attachments |
| Activity | task events |

A quest id is a Hermes task id. Every quest route resolves the board and profiles from the stored department, never from the request, and accepts an id only if it is a root task on that board assigned to the lead. Creation uses the idempotency key `vibe-city:<departmentId>:<clientRequestId>`, so a retry returns the same task. The lead plans by creating child tasks for teammates (parent links are dependencies), then completes its own task with the plan.

Quest status is computed from the whole task tree, not the root (the lead's task is normally done before any teammate starts): `queued`, `planning`, `running`, `in_review`, `awaiting_input`, `failed`, `cancelling`, `cancelled`, `completed`, with counts instead of percentages. Tasks assigned to a profile outside the department are flagged (detection only; Hermes cannot prevent it). Cancelling archives every unfinished task in Hermes; the quest shows "cancelled" only after Hermes confirms nothing is still running.

Live updates: the backend holds one token-authenticated WebSocket per watched board to Hermes' Kanban event stream and relays normalized refresh hints over `/api/live`; the browser then refetches REST snapshots.

## The MCP server

Hermes agents call back into Vibe City through an MCP server at `POST /mcp` (Streamable HTTP, JSON responses; URL from `VIBE_CITY_MCP_URL`, default `http://127.0.0.1:<PORT>/mcp`). After each sync, Vibe City issues one bearer token per department and registers it in every agent profile. The token is the agent's identity: the server resolves the calling department from it and rejects anything else with 401. Two server entries are registered:

- `vibecity`: `list_departments`, `request_quest`, `check_request`. These replace Hermes' delegation toolset, so cross-department work goes through Vibe City's rules: a request becomes a quest on the other department's board, or waits for the CEO's approval.
- `vibecity-chat`: `list_task_files`, `read_task_file`, the only MCP tools the dialogue chat gets, so chat can read past work but cannot start any.

## The company: money, market, IPO

Everything here was added for the hackathon (`docs/briefs/`); DEPLOYMENT.md has the operational detail.

- **Templates and the Chief of Staff.** A department is hired from a template (`packages/shared/src/templates`): its inventory, seats, skills, daily budget and whether it gets the wallet. The Chief of Staff is a hidden floor; the backend calls NEAR AI Cloud directly for it (it drafts floors and runs the market listings).
- **Metering proxy** (`routes/ai.ts`, `/ai/v1`). Agents do not call NEAR AI Cloud directly: each department's profiles point at the backend with a per-department key. The backend checks the daily budget (429 once reached), forwards the call with the company key, and records tokens and an estimated cost. Burn and runway are read from that table.
- **Wallet** (`walletService.ts`). One OutLayer custody wallet; its keys stay in OutLayer's TEE. Vibe City stores the wallet's agent key and writes it into the profiles of the floors whose template has `wallet: 'company'`. Spending limits are set in OutLayer and cannot be read back.
- **Agent Market** (`marketService.ts`). A listed floor is its own agent on market.near.ai. One poller turns a new assignment into a quest on that floor and submits the finished quest as the deliverable.
- **Game** (`game.ts`). The CEO quest log, unlocks and runway are derived from existing state by one pure function; nothing is stored for it.
- **IPO** (`ipoService.ts`, `contracts/`). The company wallet creates a Sputnik DAO and the city token from our factory; the token sells its own public float and the NEAR goes to the DAO. Each step reads the chain first, so a retry never creates a second DAO or token. The backend refuses a factory or token whose code hash differs from `contracts/res/*.wasm`. Vibe City holds no NEAR key: the wallet signs, the CEO approves DAO proposals.

## Guarantees vs configuration

Vibe City never says a setting is secure unless it has proven it. Each inventory capability is reported as `enforced` (applied, read back from Hermes, and tested to hold at runtime: disabling terminal, file, web, browser, code execution), `configured` (set in Hermes, behavior not tested), `unverified`, or `unsupported`. Only `enforced` counts as a guarantee. File isolation and delegation depth are labeled advisory ("instructed, not enforced"), concurrency is shown as Hermes' host-wide per-profile cap times the number of agents, and `ready` means the resources exist and match the inventory, not that everything is locked down.

Secrets are scoped by configuration only. The backend and the agents run as the same OS user on the same volume, so which key a floor is handed is a setting, not a boundary: an agent with terminal or file tools could read another floor's keys or the backend's database (DEPLOYMENT.md, "Isolation").

## The city UI (apps/web/src/town)

The city at `/` is the whole product. `data/live.ts` is its only data source: it loads REST snapshots, listens on `/api/live`, derives the view model (`data/derive.ts`, pure and tested) into the Zustand store, and turns snapshot diffs into animations. Each floor shows a department; each desk is an agent whose status comes from its live task. Panels (`ui/Panels.tsx`) cover the Executive Office, department setup and settings, the agent view and chat, the company quest board, and quest detail with tasks, results and cancellation. Copy and rules live in `data/views.ts`. A failed refresh keeps the last data and labels it out of date; an older response never overwrites newer state.

## Running

```
npm install
npm test                 # backend + web unit tests, no Hermes needed
npm run build            # builds the web app
npm run dev              # Hermes in Docker (docker-compose.dev.yml) + backend :4100 + Vite :4200; needs .env
```

Offline demo without Docker or API keys: `npm run demo`, then open http://127.0.0.1:4199. The whole product in one container: `docker compose up -d --build` (README.md, `DEPLOYMENT.md`). Main env: `HERMES_URL` (default `http://127.0.0.1:9119`), `HERMES_DASHBOARD_SESSION_TOKEN`, `HERMES_BIN`, `NEAR_AI_API_KEY`.
