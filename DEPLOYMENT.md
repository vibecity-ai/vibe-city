# Deployment (Docker, CI/CD)

Status: the container builds and runs from a clean checkout with no `.env` (last checked 2026-11-11, see "Verification record"). It is not built in CI: after a change to the `Dockerfile`, `docker/` or the compose file, run `./scripts/docker-smoke.sh`.

## What runs

One container (`Dockerfile`), three processes supervised by Hermes' own s6-overlay:

| Process | How | Listens |
|---|---|---|
| Hermes gateway | container CMD (`gateway run`), the "main program" | none (it dispatches workers) |
| Hermes dashboard | upstream s6 service, enabled by `HERMES_DASHBOARD=1` | `127.0.0.1:9119` inside the container only |
| Vibe City (API + built web app) | s6 service added in `docker/s6-rc.d/vibe-city` | `0.0.0.0:4100` in the container, published on host loopback |

Why one container: the backend drives the `hermes` CLI (profile creation and per-profile config) and reads the data the gateway uses, so it needs the Hermes binary and the same `HERMES_HOME` volume. Sharing one network/PID namespace also keeps the dashboard on loopback (it stores API keys) and lets the dashboard's gateway status see the gateway process. The base image is the upstream Hermes image plus `gh`; the backend runs on the Node 26 that Hermes bundles (`node:26-trixie-slim` only builds the web app).

State lives in one volume (`/opt/data`): Hermes home (profiles, Kanban boards, config) and Vibe City's SQLite (`/opt/data/vibe-city/vibe-city.sqlite`).

## Run locally

```
docker compose up -d --build      # then open http://127.0.0.1:4100
```

No `.env` is needed. `HERMES_DASHBOARD_SESSION_TOKEN`, the shared secret between the Hermes dashboard and the backend, is generated at every start when it is not set (`docker/cont-init.d/00-vibe-city-token`): both of its users live in the container, so it never has to leave it. `.env.example` lists what can be set.

Two composes, one `Dockerfile`: `docker-compose.yml` is the product (everything in one container, runs anywhere Docker does). `docker-compose.dev.yml` runs only the Hermes stage, for development with hot reload (below). They share the compose project name `vibe-city`, so each warns about the other's container as an orphan; never pass `--remove-orphans`.

### Develop (only Hermes in Docker)

Hermes runs in Docker (the `hermes` stage of the `Dockerfile`), the backend and web app run on the host with Node and reload on save. Linux only (host networking). Here the token is required, because the backend is outside the container: `cp .env.example .env` and set `HERMES_DASHBOARD_SESSION_TOKEN=$(openssl rand -hex 24)`. Stop the full container first (`docker compose down`): both want port 4100. The dev scripts pin `DOCKER_CONTEXT=default` (native engine): Docker Desktop on Linux runs containers in a VM whose "host" network can't reach the backend, and a second Hermes on the same `.dev/hermes` corrupts its SQLite files.

```
npm run dev:hermes        # Hermes gateway + dashboard (docker-compose.dev.yml), data in ./.dev/hermes
npm run dev:backend       # http://127.0.0.1:4100, restarts on save
npm run dev:web           # http://localhost:4200, hot reload, proxies /api to the backend
npm run dev:hermes:down   # stop Hermes (data stays in ./.dev/hermes; delete it for a fresh Hermes)
```

How the host backend reaches the container: HTTP on loopback (host networking; Hermes also reaches the backend's MCP server at 127.0.0.1:4100), the `hermes` CLI through `scripts/hermes-docker` (`HERMES_BIN`, a `docker exec` wrapper). Hermes' data is bind-mounted at `./.dev/hermes` so it survives container rebuilds; the container runs Hermes with uid/gid 1000 so those files stay yours; set `DEV_UID`/`DEV_GID` if yours differ. The backend's dev database is `apps/backend/data/vibe-city.sqlite`, separate from the container's.

The Vibe City API has **no login**. It is published on loopback only. For remote use, tunnel (`ssh -L 4100:127.0.0.1:4100`) or put an authenticating reverse proxy in front, and set `ALLOWED_ORIGINS` to the public origin.

### Models: NEAR AI Cloud (default)

The container uses [NEAR AI Cloud](https://cloud.near.ai) as its model provider. NEAR AI Cloud is an OpenAI-compatible endpoint (`https://cloud-api.near.ai/v1`). The key can come two ways: paste it in the game's first quest ("Set up your Chief of Staff", together with the Chief of Staff's model), or set it in `.env`. A key pasted in the game wins; it is stored server-side and never returned by the API.

```
NEAR_AI_API_KEY=...
# optional
NEAR_AI_MODEL=deepseek-ai/DeepSeek-V4.1-Flash-1017
NEAR_AI_BASE_URL=https://cloud-api.near.ai/v1
NEAR_AI_REASONING_EFFORT=high
```

The default model is NEAR AI's own snapshot of DeepSeek V4.1 Flash, served from its attested TEE (`verifiable` in NEAR AI's model list), so prompts stay private. `deepseek/deepseek-v4.1-flash` is the same model routed through OpenRouter: same price, not attested. Claude models on NEAR AI cannot run Hermes agents (they reject the `reasoning_effort` Hermes always sends), so Vibe City never offers them. How the Chief of Staff picks models: `docker/skills/vibe-city-models`.

On every start, `docker/cont-init.d/03-vibe-city-near` does three things before any Hermes service runs:

- It writes a `providers.near-ai` block (name, `api`, `key_env: NEAR_AI_API_KEY`, `transport: chat_completions`) into the Hermes config, with or without the key in `.env` (the block only names the variable).
- It writes the same block into every existing profile, so department profiles created before the key was set can use it too.
- While no provider has been chosen yet (`model.provider` unset or `auto`), it makes `near-ai` with `NEAR_AI_MODEL` the default. A provider chosen later is never overwritten.
- Where `agent.reasoning_effort` is unset (Hermes then uses `medium`), it sets `NEAR_AI_REASONING_EFFORT` (default `high`), in the main config and every profile. DeepSeek V4.x on NEAR rejects `medium` with HTTP 400 ("reasoning_effort must be low, high, xhigh, max …"). Departments created later inherit the setting, because their profiles are cloned from `default`.

**Metering proxy.** Agents do not call NEAR AI Cloud directly and do not hold the company key. The backend points each department profile's `providers.near-ai.api` at `VIBE_CITY_PUBLIC_URL/ai/v1` (default `http://127.0.0.1:<PORT>`, right for both composes: Hermes and the backend share the host's or the container's loopback) and gives it a per-department key (`vc_ai_…`). The backend checks the department's daily budget (HTTP 429 once reached), forwards the call to `NEAR_AI_BASE_URL` with the company key, and records tokens and an estimated cost (tokens times the listed price) per department. That is what "Burned today" and the runway read. Prompts therefore pass through the Vibe City backend, on the same host as Hermes, before they reach NEAR AI. Departments on another provider (`.env.hermes`) are not metered.

Under the gateway's profile multiplexing a profile reads credentials **only from its own `.env`**. So the backend writes that per-department `NEAR_AI_API_KEY` into every agent profile's `.env`: when the floor is provisioned, whenever the key is saved in the game (every existing floor at once), and with the profile's `API_SERVER_KEY` the first time someone chats with an agent. Without any key, provisioning and the UI still work, hiring stays locked behind the first quest, and quests cannot run.

The Chief of Staff (who drafts floors and hires) is not a Hermes agent: the backend calls NEAR AI directly with the model chosen in the first quest (changeable later in the Executive Office), else `CHAT_MODEL` / `NEAR_AI_MODEL`, else `deepseek-ai/DeepSeek-V4.1-Flash-1017`. Saving a key or a model first makes one tiny NEAR AI call with both, so a wrong key is refused instead of saved.

The city's model pickers list what Hermes reports for the authenticated providers. A key pasted in the game works at once, with no restart: checked 2026-11-11 on a container started without a key (the Chief of Staff answered, a custom floor was built and its lead answered through the metering proxy, and the pickers listed NEAR AI's models).

Other providers: put their variables in `.env.hermes` (optional, read by compose, never baked into the image), using the names Hermes documents for that provider.

### Pre-installed skills

`docker/skills/` holds vendored skills (OutLayer, NEAR, cursor-team-kit, OpenAI, Trail of Bits, Solana Foundation, CoinGecko, ponytail, trading and a DefiLlama skill of our own; sources, commits and licenses in `docker/skills/SOURCES`), and `docker/skills/HERMES_OPTIONAL` names Hermes' own optional skills to take from the image (Hyperliquid, Polymarket, Solana, …). On every start `docker/cont-init.d/04-vibe-city-skills` copies any that are missing into the default profile and every existing profile (category `vibe-city`), with no network. Which department enables which skill is set in `packages/shared/src/templates/`; `templates.test.ts` fails if a template names a skill the container does not install. They are vendored rather than installed with `hermes skills install` because that resolves GitHub skills through `api.github.com`, which hangs with no timeout when unreachable and would block container start.

`docker/cont-init.d/05-vibe-city-mcp` registers CoinGecko's official keyless MCP (`https://mcp.api.coingecko.com/mcp`, two tools, shared rate limits) in every profile. Kanban workers get it; chat stays on its `vibecity`-only allowlist. DefiLlama's official MCP needs a paid plan and an OAuth login, so the `defillama` skill uses its free public API instead.

In dev the scripts and `docker/skills` are bind-mounted: a change to a script needs `npm run dev:hermes:down && npm run dev:hermes` (a single-file mount keeps the old file until the container is recreated).

### The Agent Market

The Agent Market quest lists floors on <https://market.near.ai>: each floor the CEO lists (with the Chief of Staff) is registered as its own agent (`POST /v1/agents/register`), with its own `aat_` token in the `market_agent` table. A listed floor's agents holding its token completes the quest. Each token is stored server-side, never returned, and written as `MARKET_AGENT_TOKEN` into that floor's profiles only (for the `marketplace-worker` skill). A self-registered agent sits under a fresh market account: the CEO claims it into theirs with a one-time code from the floor's Marketplace board, then sets a USDC price and goes live under Building → Agents (account-session calls). One poller checks every listed agent's assignments every 45 s, each with its own token: a new job is started and becomes a quest on the listed floor (origin `market`), a completed quest is submitted as the Markdown deliverable, request-changes opens a revision quest, and an accepted job counts as earnings after the 5% fee. No webhook: it needs a public HTTPS URL, and the market asks for polling either way. `MARKET_BASE_URL` overrides the base URL.

### The company wallet (OutLayer)

The safe in the Executive Office holds one OutLayer custody wallet; its keys stay in OutLayer's TEE. You create the wallet at <https://app.outlayer.ai/wallet/new>, set its policy there, and paste its agent key (`wk_…`) in the safe; it is checked against OutLayer before it is stored. Binding the wallet to your own NEAR account (`POST /api/wallet/bind`, tested, not shown in the UI) is not offered: on mainnet OutLayer cannot build that transaction yet (its wallet contract is not published there, checked 2026-11-08). The key is stored server-side, never returned, and written as `OUTLAYER_API_KEY` / `OUTLAYER_WALLET_ID` into the profiles of the floors whose template has `wallet: 'company'` (Trading Desk, Prediction Desk, Treasury Ops) only. Mainnet (`https://api.outlayer.ai`); set `OUTLAYER_API_URL=https://testnet-api.outlayer.ai` to rehearse. Spending limits are set in OutLayer and cannot be read back.

### Pinning Hermes

`HERMES_IMAGE` is pinned by digest to `nousresearch/hermes-agent@sha256:d27689bc6e8581ec884a7227c9101fdaebf6c853cff8859020dac14f21452b4d` (Hermes 0.22.6, the image the container was tested with; it was `latest` on 2026-11-03). The pin is the default in the Dockerfile and `docker-compose.yml`. To move to a newer Hermes, update both together (or set `HERMES_IMAGE`), then rebuild and run the smoke test.

The runtime reuses the Node 26 that Hermes bundles (`/usr/local/bin/node` -> `/opt/hermes/tools/node-*`) instead of adding its own copy; the build fails if that Node is missing or is not Node 26.

The image is about 3.2 GB, nearly all of it the Hermes base: bundled Chromium, ffmpeg, Python and Node, apt packages, and a `uv` cache.

## CI (`.github/workflows`)

- `ci.yml`: on every push to `main` and every PR: `npm ci`, typecheck, tests (backend against FakeHermes + web), web build. Needs no Hermes.
- There is no Docker workflow: the image is not built, smoke-tested or published in CI until there is a deployment target. Build and test it locally with `./scripts/docker-smoke.sh`: it builds the image and runs it under its own compose project (`vibe-city-smoke`, port 4190), so its final `down -v` cannot delete the volume of a real run.
- Deployment is not automated: no target (VM, Fly, Kubernetes) has been chosen.
- The repository is on GitHub (`origin`); the workflow runs there.

## Isolation: what Docker does and does not change

Agents run with Hermes' local terminal backend *inside this container*. That confines them to the container and the data volume (the host is out of reach), which is a real improvement. It does **not** scope files per department: any agent with file tools can still reach other departments' task folders in the same volume.

The same holds for secrets. The backend, the gateway and every agent run as the `hermes` user on one volume. A process of that user can read Vibe City's SQLite file (the NEAR AI key, the OutLayer wallet key and the market tokens are stored there), every profile's `.env`, and the dashboard session token (checked 2026-11-11 with `docker exec -u hermes`). So "the company key is not in an agent's environment" and "the wallet key goes only to wallet floors" describe what Vibe City configures, not what an agent with terminal or file tools is prevented from reading. Use a NEAR AI key with a spending limit and a wallet whose OutLayer policy caps what it can spend. In development (`docker-compose.dev.yml`) the Hermes container also uses host networking, so agents can reach every service on the host's loopback. A real per-department sandbox would need Hermes' docker terminal backend (Docker-in-Docker or a mounted socket), which is a separate decision with its own security cost.

## Known risks (verify after upgrading Hermes)

1. The Hermes base is pinned by digest. Upgrading Hermes is a deliberate change (see Pinning Hermes); `scripts/build-hermes-image.sh` can still build a specific Hermes commit from source.
2. Extra s6 service and cont-init scripts: they depend on the base image's s6 layout (`/etc/s6-overlay/s6-rc.d`, `user/contents.d`, `/run/s6/container_environment`), as in the pinned image.
3. The gateway needs model credentials to run workers; `health.gateway` may read `stopped` in the smoke test (reported, not asserted).
4. The smoke test provisions a department, which creates real profiles by cloning the default profile; if upstream changes that, the smoke test is where it will show.

## Verification record

**2026-11-11, container from a clean checkout** (Linux x86_64, Docker 29.9, Compose v5.4; the tree exported with `git archive`, no `.env`):

| Gate | Result |
|---|---|
| `docker compose up -d --build` | ok: image builds (43 s with the Hermes base cached, 3.2 GB), container `healthy` within a minute |
| `/api/runtime/health` with no token given | ok: `dashboard: up`, `auth: ok`, `gateway: running`, Hermes 0.22.6. The same image without `00-vibe-city-token` and without a token answers `auth: rejected` |
| `./scripts/docker-smoke.sh` | ok: web app served, a department provisioned to `ready` through the Hermes CLI (93 s for one agent on a fresh container), its own project removed afterwards |
| `npm ci && npm test`, `npm run demo` on Node 24.13 | ok |
| Not run | macOS, Windows and arm64 hosts (the pinned Hermes image has an arm64 variant); a quest with a real model key in this container |

**2026-11-03, city UI merge** (development machine, Node 26.12.0, Hermes CLI 2026.9.24 `fcc26fb` installed but not running):

| Gate | Result |
|---|---|
| `npm ci` | ok |
| `npm run typecheck` | ok (shared, backend, web) |
| `npm test` | ok: backend 145, web 49 |
| `npm run build` | ok |
| Backend serving the built app (`WEB_DIST=apps/web/dist`, scratch DB, no Hermes) | ok: `/` serves the shell, `/api/*` JSON, a missing `/assets/*.js` is 404; the UI was driven in headless Chromium (desktop and 390 px): Executive Office, archived list, settings, workspace validation error, provisioning inspector, archive confirmation (focus trap, Escape, focus restore), inventory and capability report, tab keyboard navigation, no horizontal overflow, no console errors |
| No absolute path in any department/provisioning/profiles/effective-inventory response with a workspace configured | ok (checked with curl against the scratch backend) |
| Docker image build | **not run**: `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock` (the user is not in the `docker` group) |
| `scripts/docker-smoke.sh` | **not run** (same reason) |
| Repository contents | **bug found and fixed locally**: `.gitignore` had `data/`, which also ignored `apps/web/src/town/data/` (the city's data layer: `live.ts`, `derive.ts`, `types.ts`). The first commit therefore lacks those files and a fresh clone cannot build the web app. The rule is now `/apps/backend/data/`; the files must be committed. |
| CI on GitHub | **unknown**: `gh` is not authenticated on this machine, so run results were not checked |
| Hermes image pin | `nousresearch/hermes-agent@sha256:d27689bc6e8581ec884a7227c9101fdaebf6c853cff8859020dac14f21452b4d` (Hermes 0.22.6), verified to be the exact base of the locally tested image (all 39 layers match) |
| WebSocket reconnect, quest screens, one real lead -> teammate quest | **not run**: needs a running Hermes dashboard + gateway and model credentials. Covered by unit tests (`live.test.ts`) only. |

To reproduce the local part: `npm ci && npm run typecheck && npm test && npm run build`, then `WEB_DIST=../web/dist PORT=4199 VIBE_CITY_DB=/tmp/vc.sqlite node --experimental-strip-types src/server.ts` in `apps/backend` and open `http://127.0.0.1:4199/`. Restart the backend after every rebuild (static files are registered at startup).
