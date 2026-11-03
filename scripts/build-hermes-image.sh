#!/usr/bin/env bash
# Builds the Hermes image from the exact commit Vibe City was developed and tested against (2026.9.24),
# instead of pulling a moving tag. Then: HERMES_IMAGE=hermes-agent:fcc26fb docker compose up -d --build
set -euo pipefail
SHA=fcc26fbd9f1641755e49793d7ed608f3b7214c3d
docker build -t "hermes-agent:${SHA:0:7}" "https://github.com/NousResearch/hermes-agent.git#${SHA}"
echo "built hermes-agent:${SHA:0:7}"
