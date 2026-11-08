# Deployment (Docker, CI/CD)

Status: **the container has still not been built or run.** See "Verification record" below for exactly what was and was not executed. Treat the first local `docker compose up --build` plus `scripts/docker-smoke.sh` as the real test (see "Known risks").

## What runs

One container (`Dockerfile`), three processes supervised by Hermes' own s6-overlay:

| Process | How | Listens |
|---|---|---|
| Hermes gateway | container CMD (`gateway run`), the "main program" | none (it dispatches workers) |
| Hermes dashboard | upstream s6 service, enabled by `HERMES_DASHBOARD=1` | `127.0.0.1:9119` inside the container only |
| Vibe City (API + built web app) | s6 service added in `docker/s6-rc.d/vibe-city` | `0.0.0.0:4100` in the container, published on host loopback |

Why one container: the backend drives the `hermes` CLI (profile creation and per-profile config) and reads the data the gateway uses, so it needs the Hermes binary and the same `HERMES_HOME` volume. Sharing one network/PID namespace also keeps the dashboard on loopback (it stores API keys) and lets the dashboard's gateway status see the gateway process. The base image is the upstream Hermes image, unmodified; Node is copied in from `node:26-trixie-slim`.

State lives in one volume (`/opt/data`): Hermes home (profiles, Kanban boards, config) and Vibe City's SQLite (`/opt/data/vibe-city/vibe-city.sqlite`).

## Run locally

```
cp .env.example .env              # set HERMES_DASHBOARD_SESSION_TOKEN=$(openssl rand -hex 24)
docker compose up -d --build
open http://127.0.0.1:4100
```

### Develop (only Hermes in Docker)

No image build: Hermes runs from the pinned upstream image, the backend and web app run on the host with Node and reload on save. Linux only (host networking). Uses the same `.env`. Stop the full container first (`docker compose down`): both want port 4100.

```
npm run dev:hermes        # Hermes gateway + dashboard (docker-compose.dev.yml), data in ./.dev/hermes
npm run dev:backend       # http://127.0.0.1:4100, restarts on save
npm run dev:web           # http://localhost:4200, hot reload, proxies /api to the backend
npm run dev:hermes:down   # stop Hermes (data stays in ./.dev/hermes; delete it for a fresh Hermes)
```

How the host backend reaches the container: HTTP on loopback (host networking; Hermes also reaches the backend's MCP server at 127.0.0.1:4100), the `hermes` CLI through `scripts/hermes-docker` (`HERMES_BIN`, a `docker exec` wrapper). Hermes' data is bind-mounted at `./.dev/hermes` so it survives container rebuilds; the container runs Hermes with uid/gid 1000 so those files stay yours; set `DEV_UID`/`DEV_GID` if yours differ. The backend's dev database is `apps/backend/data/vibe-city.sqlite`, separate from the container's.

The Vibe City API has **no login**. It is published on loopback only. For remote use, tunnel (`ssh -L 4100:127.0.0.1:4100`) or put an authenticating reverse proxy in front, and set `ALLOWED_ORIGINS` to the public origin.

### Models: NEAR AI Cloud (default)

The container uses [NEAR AI Cloud](https://cloud.near.ai) as its model provider. NEAR AI Cloud is an OpenAI-compatible endpoint (`https://cloud-api.near.ai/v1`). Set the key in `.env`:

```
NEAR_AI_API_KEY=...
# optional
NEAR_AI_MODEL=deepseek/deepseek-v4.1-flash
NEAR_AI_BASE_URL=https://cloud-api.near.ai/v1
NEAR_AI_REASONING_EFFORT=high
```

On every start, `docker/cont-init.d/03-vibe-city-near` does three things before any Hermes service runs:

- It writes a `providers.near-ai` block (name, `api`, `key_env: NEAR_AI_API_KEY`, `transport: chat_completions`) into the Hermes config.
- It writes the same block into every existing profile, so department profiles created before the key was set can use it too.
- While no provider has been chosen yet (`model.provider` unset or `auto`), it makes `near-ai` with `NEAR_AI_MODEL` the default. A provider chosen later is never overwritten.
- Where `agent.reasoning_effort` is unset (Hermes then uses `medium`), it sets `NEAR_AI_REASONING_EFFORT` (default `high`), in the main config and every profile. DeepSeek V4.x on NEAR rejects `medium` with HTTP 400 ("reasoning_effort must be low, high, xhigh, max …"). Departments created later inherit the setting, because their profiles are cloned from `default`.

Hermes' own workers read the key from the environment. The dialogue window is the exception: it talks to each agent's profile through the gateway API server, where Hermes multiplexes profiles and a profile reads credentials **only from its own `.env`**. So the backend writes `NEAR_AI_API_KEY` (and the profile's `API_SERVER_KEY`) into an agent's profile `.env` the first time someone chats with it, and again once after every restart, so a changed key propagates. Without the key, nothing is configured: provisioning and the UI still work, but quests cannot run.

The city's model pickers list what Hermes reports for the authenticated providers. Restart the container after changing the key.

Other providers: put their variables in `.env.hermes` (optional, read by compose, never baked into the image), using the names Hermes documents for that provider.

### Pre-installed skills

`docker/skills/` holds vendored skills (OutLayer, NEAR, cursor-team-kit, OpenAI, Trail of Bits, Solana Foundation, CoinGecko, ponytail, trading and a DefiLlama skill of our own; sources, commits and licenses in `docker/skills/SOURCES`), and `docker/skills/HERMES_OPTIONAL` names Hermes' own optional skills to take from the image (Hyperliquid, Polymarket, Solana, …). On every start `docker/cont-init.d/04-vibe-city-skills` copies any that are missing into the default profile and every existing profile (category `vibe-city`), with no network. Which department enables which skill is set in `packages/shared/src/templates/`; `templates.test.ts` fails if a template names a skill the container does not install. They are vendored rather than installed with `hermes skills install` because that resolves GitHub skills through `api.github.com`, which hangs with no timeout when unreachable and would block container start.

`docker/cont-init.d/05-vibe-city-mcp` registers CoinGecko's official keyless MCP (`https://mcp.api.coingecko.com/mcp`, two tools, shared rate limits) in every profile. Kanban workers get it; chat stays on its `vibecity`-only allowlist. DefiLlama's official MCP needs a paid plan and an OAuth login, so the `defillama` skill uses its free public API instead.

In dev the scripts and `docker/skills` are bind-mounted: a change to a script needs `npm run dev:hermes:down && npm run dev:hermes` (a single-file mount keeps the old file until the container is recreated).

### GitHub for the Software Department

The Hermes image (Dockerfile stage `hermes`, which `docker-compose.dev.yml` also builds) includes `gh`. The CEO pastes a fine-grained personal access token in the `connect-github` quest (`PATCH /api/company/settings { githubToken }`); the backend stores it in its SQLite, never returns it, and writes it as `GH_TOKEN` into the `.env` of every Software Department profile, at once and after every sync that changes the department. Other departments never get it. `GITHUB_TOKEN` in `.env` is a fallback when nothing was pasted. The token is stored unencrypted on the server, like the other settings secrets.

### Pinning Hermes

`HERMES_IMAGE` is pinned by digest to `nousresearch/hermes-agent@sha256:d27689bc6e8581ec884a7227c9101fdaebf6c853cff8859020dac14f21452b4d` (Hermes 0.22.6, the image the container was tested with; it was `latest` on 2026-11-03). The pin is the default in the Dockerfile and `docker-compose.yml`. To move to a newer Hermes, update both together (or set `HERMES_IMAGE`), then rebuild and run the smoke test.

The runtime reuses the Node 26 that Hermes bundles (`/usr/local/bin/node` -> `/opt/hermes/tools/node-*`) instead of adding its own copy; the build fails if that Node is missing or is not Node 26.

About 97% of the image (roughly 4.6 GB) is the Hermes base: bundled Chromium, ffmpeg, Python and Node, apt packages, and a `uv` cache. Vibe City adds about 35 MB.

## CI (`.github/workflows`)

- `ci.yml`: on every push to `main` and every PR: `npm ci`, typecheck, tests (backend against FakeHermes + web), web build. Needs no Hermes.
- There is no Docker workflow: the image is not built, smoke-tested or published in CI until there is a deployment target. Build and test it locally with `docker compose up -d --build` and `VIBE_CITY_IMAGE=<image> ./scripts/docker-smoke.sh`.
- Deployment is not automated: no target (VM, Fly, Kubernetes) has been chosen.
- The repository is on GitHub (`origin`); the workflow runs there.

## Isolation: what Docker does and does not change

Agents run with Hermes' local terminal backend *inside this container*. That confines them to the container and the data volume (the host is out of reach), which is a real improvement. It does **not** scope files per department: any agent with file tools can still reach other departments' task folders in the same volume. A real per-department sandbox would need Hermes' docker terminal backend (Docker-in-Docker or a mounted socket), which is a separate decision with its own security cost.

## Known risks (verify on first run)

1. The Hermes base is pinned by digest. Upgrading Hermes is a deliberate change (see Pinning Hermes); `scripts/build-hermes-image.sh` can still build a specific Hermes commit from source.
2. Extra s6 service: it depends on the base image's s6 layout (`/etc/s6-overlay/s6-rc.d`, `user/contents.d`), copied from the version tested locally.
3. The gateway needs model credentials to run workers; `health.gateway` may read `stopped` in the smoke test (reported, not asserted).
4. The smoke test provisions a department, which creates real profiles by cloning the default profile; if upstream changes that, the smoke test is where it will show.

## Verification record

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
