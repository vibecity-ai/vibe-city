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

Model/provider credentials: put them in `.env.hermes` (optional file, read by compose, never baked into the image) using the variable names Hermes documents for your provider. Not configured yet; without them Hermes cannot run quests but provisioning and the UI work.

### Pinning Hermes

`HERMES_IMAGE` defaults to `nousresearch/hermes-agent:latest`. Vibe City was developed against Hermes 2026.9.24 (commit `fcc26fb`). For reproducible builds either set `HERMES_IMAGE` to a digest, or build the tested commit yourself: `scripts/build-hermes-image.sh`, then `HERMES_IMAGE=hermes-agent:fcc26fb docker compose up -d --build`. In CI set the repository variable `HERMES_IMAGE`.

## CI/CD (`.github/workflows`)

- `ci.yml`: on every push to `main` and every PR: `npm ci`, typecheck, tests (backend against FakeHermes + web), web build. Needs no Hermes.
- `docker.yml`: builds the image once, runs `scripts/docker-smoke.sh` against it (web served, dashboard reachable with the shared token, a department provisioned through the CLI and the shared volume), and only then publishes `ghcr.io/<owner>/<repo>` (tags: `sha`, branch, semver for `v*` tags). PRs build and smoke-test but never publish.
- Deployment itself is not automated: no target (VM, Fly, Kubernetes) has been chosen. Publishing the image is the CD boundary; deploying is `docker compose pull && docker compose up -d` on the host.
- The repository is on GitHub (`origin`); the workflows run there.

## Isolation: what Docker does and does not change

Agents run with Hermes' local terminal backend *inside this container*. That confines them to the container and the data volume (the host is out of reach), which is a real improvement. It does **not** make workspace scoping per department: any agent with file tools can still reach other departments' files in the same volume. The UI therefore keeps labelling workspaces as advisory. A real per-department sandbox would need Hermes' docker terminal backend (Docker-in-Docker or a mounted socket), which is a separate decision with its own security cost.

## Known risks (verify on first run)

1. `nousresearch/hermes-agent:latest` is the upstream published name taken from its CI config; the tag was not verified and `latest` can drift from the tested version.
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
| Hermes image pin | **none yet**: still `nousresearch/hermes-agent:latest` (unverified tag). Record the digest of the first image that passes `docker.yml` here and set it as `HERMES_IMAGE`. |
| WebSocket reconnect, quest screens, one real chief -> worker quest | **not run**: needs a running Hermes dashboard + gateway and model credentials. Covered by unit tests (`live.test.ts`) only. |

To reproduce the local part: `npm ci && npm run typecheck && npm test && npm run build`, then `WEB_DIST=../web/dist PORT=4199 VIBE_CITY_DB=/tmp/vc.sqlite node --experimental-strip-types src/server.ts` in `apps/backend` and open `http://127.0.0.1:4199/`. Restart the backend after every rebuild (static files are registered at startup).
