# Deployment (Docker, CI/CD)

Status: **the container has still not been built or run.** See "Verification record" below for exactly what was and was not executed. Treat the first CI run of `docker.yml` as the real test (see "Known risks").

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

The key itself is never written to disk; Hermes reads it from the environment when it calls the model. Without the key, nothing is configured: provisioning and the UI still work, but quests cannot run.

The city's model pickers list what Hermes reports for the authenticated providers. Restart the container after changing the key.

Other providers: put their variables in `.env.hermes` (optional, read by compose, never baked into the image), using the names Hermes documents for that provider.

### Pinning Hermes

`HERMES_IMAGE` is pinned by digest to `nousresearch/hermes-agent@sha256:d27689bc6e8581ec884a7227c9101fdaebf6c853cff8859020dac14f21452b4d` (Hermes 0.22.6, the image the container was tested with; it was `latest` on 2026-11-03). The pin is the default in the Dockerfile, `docker-compose.yml` and `docker.yml`. To move to a newer Hermes, update all three together (or set `HERMES_IMAGE` / the repository variable), then rebuild and run the smoke test.

The runtime reuses the Node 26 that Hermes bundles (`/usr/local/bin/node` -> `/opt/hermes/tools/node-*`) instead of adding its own copy; the build fails if that Node is missing or is not Node 26.

About 97% of the image (roughly 4.6 GB) is the Hermes base: bundled Chromium, ffmpeg, Python and Node, apt packages, and a `uv` cache. Vibe City adds about 35 MB.

## CI/CD (`.github/workflows`)

- `ci.yml`: on every push to `main` and every PR: `npm ci`, typecheck, tests (backend against FakeHermes + web), web build. Needs no Hermes.
- `docker.yml`: runs only when something that goes into the image changes (`Dockerfile`, `docker/`, `apps/`, `packages/`, lockfiles, the smoke script, the workflow itself), and always for `v*` tags. A newer run on the same ref cancels an older one.
  - It pulls the pinned Hermes base and builds with the daemon's own BuildKit (`driver: docker`), so the 4.7 GB image is never exported from a builder container and re-imported.
  - It runs `scripts/docker-smoke.sh` against that image (web served, dashboard reachable with the shared token, a department provisioned through the CLI and the shared volume).
  - Only then does it tag and push that same image to `ghcr.io/<owner>/<repo>` (tags: `sha`, branch, semver for `v*` tags), without building it again. PRs build and smoke-test but never publish.
  - There is no build cache across runs: Vibe City's own layers (npm install, web build) take about a minute to rebuild, and the Hermes base is pulled either way.
- Deployment itself is not automated: no target (VM, Fly, Kubernetes) has been chosen. Publishing the image is the CD boundary; deploying is `docker compose pull && docker compose up -d` on the host.
- The repository is on GitHub (`origin`); the workflows run there.

## Isolation: what Docker does and does not change

Agents run with Hermes' local terminal backend *inside this container*. That confines them to the container and the data volume (the host is out of reach), which is a real improvement. It does **not** make workspace scoping per department: any agent with file tools can still reach other departments' files in the same volume. The UI therefore keeps labelling workspaces as advisory. A real per-department sandbox would need Hermes' docker terminal backend (Docker-in-Docker or a mounted socket), which is a separate decision with its own security cost.

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
| WebSocket reconnect, quest screens, one real chief -> worker quest | **not run**: needs a running Hermes dashboard + gateway and model credentials. Covered by unit tests (`live.test.ts`) only. |

To reproduce the local part: `npm ci && npm run typecheck && npm test && npm run build`, then `WEB_DIST=../web/dist PORT=4199 VIBE_CITY_DB=/tmp/vc.sqlite node --experimental-strip-types src/server.ts` in `apps/backend` and open `http://127.0.0.1:4199/`. Restart the backend after every rebuild (static files are registered at startup).
