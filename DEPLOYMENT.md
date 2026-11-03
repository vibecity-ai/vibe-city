# Deployment (Docker, CI/CD)

Status: **written, not yet run.** The author's user cannot talk to the Docker daemon on the development machine, so neither the image build, the container, nor the CI workflows have been executed. `docker compose config` and `bash -n` pass; everything else is unverified until the first CI run. Treat the first run as the real test (see "Known risks").

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
- Repo prerequisite: the project is not a git repository yet. `git init`, add a GitHub remote, then the workflows apply.

## Isolation: what Docker does and does not change

Agents run with Hermes' local terminal backend *inside this container*. That confines them to the container and the data volume (the host is out of reach), which is a real improvement. It does **not** make workspace scoping per department: any agent with file tools can still reach other departments' files in the same volume. The UI therefore keeps labelling workspaces as advisory. A real per-department sandbox would need Hermes' docker terminal backend (Docker-in-Docker or a mounted socket), which is a separate decision with its own security cost.

## Known risks (verify on first run)

1. `nousresearch/hermes-agent:latest` is the upstream published name taken from its CI config; the tag was not verified and `latest` can drift from the tested version.
2. Extra s6 service: it depends on the base image's s6 layout (`/etc/s6-overlay/s6-rc.d`, `user/contents.d`), copied from the version tested locally.
3. The gateway needs model credentials to run workers; `health.gateway` may read `stopped` in the smoke test (reported, not asserted).
4. The smoke test provisions a department, which creates real profiles by cloning the default profile; if upstream changes that, the smoke test is where it will show.
