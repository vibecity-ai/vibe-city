#!/usr/bin/env bash
# End-to-end smoke test of the container: web app served, Hermes dashboard reachable with the shared token,
# and a department provisioned through the Hermes CLI + shared volume (the riskiest integration point).
# Needs no model credentials: provisioning creates a board and profiles, it does not call a model.
set -euo pipefail
cd "$(dirname "$0")/.."
# Its own compose project and port: the `down -v` below must never reach the volume of a real run (project vibe-city).
export VIBE_CITY_PORT="${VIBE_CITY_PORT:-4190}"
BASE="http://127.0.0.1:$VIBE_CITY_PORT"
COMPOSE=(docker compose -p vibe-city-smoke)
cleanup() { status=$?; if [ $status -ne 0 ]; then "${COMPOSE[@]}" logs --no-color --tail=200 || true; fi; "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true; exit $status; }
trap cleanup EXIT

"${COMPOSE[@]}" up -d --build
echo "waiting for the backend..."
for i in $(seq 1 90); do curl -fsS "$BASE/api/company" >/dev/null 2>&1 && break; sleep 2; [ "$i" = 90 ] && { echo "backend never came up"; exit 1; }; done

curl -fsS "$BASE/" | grep -q '<div id="root">' || { echo "web app not served"; exit 1; }

echo "waiting for the Hermes dashboard..."
for i in $(seq 1 90); do
  h=$(curl -fsS "$BASE/api/runtime/health")
  [ "$(echo "$h" | jq -r .hermes.dashboard)" = up ] && [ "$(echo "$h" | jq -r .hermes.auth)" = ok ] && break
  sleep 2; [ "$i" = 90 ] && { echo "dashboard not reachable/authorized: $h"; exit 1; }
done
echo "health: $h"   # gateway state is informational: without model credentials it may report stopped

id=$(curl -fsS -XPOST "$BASE/api/departments" -H 'content-type: application/json' -d '{"name":"Smoke","purpose":"container smoke test"}' | jq -r .id)
prov=$(curl -sS -XPOST "$BASE/api/departments/$id/provision")
state=$(echo "$prov" | jq -r .state)
[ "$state" = ready ] || { echo "provisioning ended in '$state': $prov"; exit 1; }
echo "provisioned ok"
