# 04 Metering proxy for NEAR AI Cloud

**Goal.** One NEAR AI API key, pasted once. Every department's model calls go through Vibe City, which prices
them, records burn per department, and enforces the department's daily budget. No NEAR AI dashboard work, no
per-department keys, no JWT.

## Why a proxy

NEAR AI Cloud has no OAuth; its balance endpoint needs a session JWT and its usage endpoints need an org reporting
token. The inference key can only infer and call `POST /v1/billing/costs { requestIds }`. So we meter ourselves.

## Backend

### `routes/ai.ts`: `ALL /ai/v1/*`

- Auth: `Authorization: Bearer vc_ai_<department token>`; resolve the department from a per-department pseudo key
  stored hashed in `department_inventory` (or a new column; brief 00 did not add one, so use `company_settings`
  json `aiKeys: { [hash]: departmentId }`). Unknown key -> 401.
- Budget check before forwarding: `todayCents(departmentId) >= limits.dailyBudgetCredits` -> `429` with an
  OpenAI-style error body `{ error: { message: 'Vibe City: daily budget reached', type: 'budget' } }`. Null
  budget = unlimited.
- Forward to `NEAR_AI_BASE_URL` (default `https://cloud-api.near.ai/v1`) with the company key from
  `company_settings.nearAiApiKey` (fallback env `NEAR_AI_API_KEY`), same method, path, body. Pass through status
  and headers except hop-by-hop.
- Non-streaming: read the JSON, record `usage`, return it. Streaming (`stream: true`): inject
  `stream_options: { include_usage: true }` into the request body, pipe the SSE through untouched, and parse the
  final chunk's `usage` (and `id`, `model`) as it passes. If Hermes rejects `stream_options`, fall back to
  counting the last chunk without it and record tokens as null with a cost estimate from the model's price.
- Price: `nearPrices.ts` already loads `GET /v1/model/list` (`inputCostPerToken`, `outputCostPerToken`, scale 9).
  cost_nano_usd = input*inPrice + output*outPrice. Store a row in `ai_usage` per response. Nightly (or on demand)
  `POST /v1/billing/costs` with the stored request ids to replace estimates with exact costs; optional, do last.

### `domain/aiUsage.ts`

`record(row)`, `todayCents(departmentId)`, `summary()` -> `AiUsageSummarySchema` (by department: today, 7-day,
budget, overBudget; company today and 7-day average). Dates in UTC.

### Provisioning

In the existing env-writing path (`chatService` writes `API_SERVER_KEY` + `agentEnv` on first chat; provisioning
should do the same for Kanban workers), set `NEAR_AI_API_KEY=vc_ai_<dept>` and `NEAR_AI_BASE_URL=<backend
origin>/ai/v1` for every profile of the department. **Verify the exact env names Hermes reads for the NEAR AI
provider** (see `docs/hermes.md`) before relying on them; if the provider is configured under another name in the
dev image's `config.yaml`, use that. The backend origin comes from a new env `VIBE_CITY_PUBLIC_URL` (default
`http://host.docker.internal:4100` for the Docker dev setup; document it in DEPLOYMENT.md).

### Settings

`PATCH /api/company/settings { nearAiApiKey, nearAiCreditsLoadedCents }` (brief 00 route stub). `GET` returns
`nearAiApiKeySet: true` and the credits figure, never the key.

## Web

Settings sheet: "Connect NEAR AI Cloud": key field (masked, write-only), "credits loaded" amount, and a line per
department with today's burn vs budget. Brief 05 renders runway; this brief only exposes the numbers.

## Files you own

`apps/backend/src/routes/ai.ts`, `apps/backend/src/domain/aiUsage.ts` (new), `apps/backend/src/routes/company.ts`
(settings handlers; coordinate with brief 02, which adds `marketAgentToken` to the same route: split the handler
by field, land whichever is first), the env-writing call in `provisioningService.ts` (one call site),
`apps/web/src/town/ui/SettingsSheet*` (one section).

## Do not touch

`model/chatModel.ts` (our own assistant keeps calling NEAR AI directly), `mcp/server.ts`, `schemas.ts`.

## Acceptance

- `ai.test.ts` with a fake upstream: a non-streaming completion is forwarded with the company key, recorded with
  the right cost, and attributed to the right department; a streaming completion records usage from the final
  chunk; a department over budget gets 429 and nothing is forwarded; an unknown pseudo key gets 401.
- `provisioning.test.ts`: profiles receive the two env vars (FakeHermes records).
- Manual: one Kanban task through the proxy on the dev stack, row appears in `ai_usage`.

## Honesty note for the README

Prompts pass through the Vibe City backend on the same host as Hermes before reaching NEAR AI's TEE. Say so.
