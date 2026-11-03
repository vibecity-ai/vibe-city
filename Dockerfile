# syntax=docker/dockerfile:1.7
#
# One container, three processes, supervised by Hermes' own s6-overlay:
#   - Hermes gateway   (the CMD, "main program": it is what runs workers)
#   - Hermes dashboard (s6 service, bound to 127.0.0.1 only; Vibe City is its only client)
#   - Vibe City        (s6 service added below: API + built web app on :4100)
# They share one network namespace, one PID namespace and one HERMES_HOME volume (/opt/data). That matters:
# the backend drives the `hermes` CLI (profile creation/config) and reads the same Kanban data the gateway uses.
#
# The base is the upstream Hermes image, so Hermes itself is unmodified.
ARG HERMES_IMAGE=nousresearch/hermes-agent:latest
ARG NODE_IMAGE=node:26-trixie-slim

FROM ${NODE_IMAGE} AS node

# ---- build the web app (needs dev dependencies) ----
FROM node AS web
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm ci
COPY packages packages
COPY apps/web apps/web
RUN npm run build -w @vibe-city/web

# ---- production dependencies of the backend only ----
FROM node AS deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev -w @vibe-city/backend

# ---- runtime: Hermes image + Node + Vibe City ----
FROM ${HERMES_IMAGE} AS runtime
USER root
# Same Debian generation as the Hermes base; libstdc++ is the only shared library node needs beyond libc.
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 install -y --no-install-recommends libstdc++6 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node

WORKDIR /opt/vibe-city
COPY --from=deps /src/node_modules node_modules
COPY package.json ./
COPY packages/shared packages/shared
COPY apps/backend/package.json apps/backend/package.json
COPY apps/backend/src apps/backend/src
COPY --from=web /src/apps/web/dist apps/web/dist

# s6 service: declared next to Hermes' own (dashboard, main-hermes) and enabled in the "user" bundle.
COPY --chmod=0755 docker/s6-rc.d/vibe-city/run /etc/s6-overlay/s6-rc.d/vibe-city/run
RUN echo longrun > /etc/s6-overlay/s6-rc.d/vibe-city/type \
 && mkdir -p /etc/s6-overlay/s6-rc.d/vibe-city/dependencies.d \
 && touch /etc/s6-overlay/s6-rc.d/vibe-city/dependencies.d/base /etc/s6-overlay/s6-rc.d/user/contents.d/vibe-city

# The dashboard stays on loopback (it holds API keys). HERMES_DASHBOARD_SESSION_TOKEN must be provided at run time.
ENV HERMES_DASHBOARD=1 \
    HERMES_DASHBOARD_HOST=127.0.0.1 \
    HERMES_DASHBOARD_PORT=9119 \
    HERMES_URL=http://127.0.0.1:9119 \
    HOST=0.0.0.0 \
    PORT=4100 \
    VIBE_CITY_DB=/opt/data/vibe-city/vibe-city.sqlite \
    WEB_DIST=/opt/vibe-city/apps/web/dist

# Keep the upstream working directory (Hermes records the start directory of the main program).
WORKDIR /opt/hermes

EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4100/api/company').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Gateway is the container's main program (when it exits the container exits and is restarted by the orchestrator).
CMD ["gateway", "run"]
