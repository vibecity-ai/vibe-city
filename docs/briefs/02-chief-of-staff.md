# 02 Chief of Staff and the NEAR AI Agent Market

**Goal.** The company earns. The executive assistant becomes the Chief of Staff: it still drafts departments, and
it also runs the company's listing on the Agent Market: picks up assignments, hands them to the right department
as quests, submits the results, and the USDC lands in the treasury.

## Facts (docs.market.near.ai, read 2026-11-07)

- Listing is done once by the user in the market UI: Building, Your agents, New agent, hosting = self-hosted
  with **no webhook** (poll mode), price in **USDC** (USD needs Stripe Connect), SLA, then "Create token". The
  `aat_` token is shown once, with a webhook signing secret next to it. Confirmed email required. There is no API
  to create the listing, so the Chief of Staff **drafts** it and the user pastes it in (below).
- The market's own template (`github.com/fadeevab/market-agent-template`, read 2026-11-07) is webhook-only: an
  `eve` agent on Vercel with its own NEAR AI model (`MARKET_AGENT_TOKEN`, `MARKET_WEBHOOK_SECRET`,
  `NEARAI_API_KEY`), webhooks signed `HMAC-SHA256(secret, "<timestamp>." + body)` in `x-market-signature`. The
  listing form offers "Deploy on Vercel", which "fills in the names and connects the webhook for you". A job
  taken by that deployment is done on Vercel and never reaches Vibe City's departments, so it is not our path;
  the walkthrough names it only to say why. Vercel's free plan is non-commercial; an earning agent needs Pro.
- No endpoint reports whether a listing is live. The template's only self call is `GET
  https://market.near.ai/v1/agents/me/assignments?limit=100&offset=0` with `Authorization: Bearer aat_...`; a
  200 proves the token is valid and the agent exists. That is the check we use, labelled "token verified", never
  "listing live". REST also covers the worker side without MCP: `POST /v1/assignments/{id}/submit
  { deliverableMarkdown }` (250,000-byte cap), `/messages { body }` (4,000 chars), `/decline { reason, detail }`. No sandbox; hiring your own draft agent from a second
  account is the test mode and is allowed.
- MCP server `https://market.near.ai/mcp`, `Authorization: Bearer aat_...`. Worker tools:
  `marketplace__list_my_assignments`, `marketplace__start_assignment`, `marketplace__read_messages`,
  `marketplace__send_message`, `marketplace__report_progress` (max one per 30 s), `marketplace__submit_deliverable`
  (`deliverableMarkdown` up to 256 KiB), `marketplace__list_open_jobs`, `marketplace__place_bid`.
- Poll every 30 to 60 s. States: `in_progress` (after start) -> `submitted` -> `accepted` | request-changes (back to
  `in_progress`) | `disputed`. Buyer silence auto-accepts after 3 to 7 days. Payout minus 5% fee, "usually within
  seconds" of acceptance, withdrawable as USDC on NEAR with no minimum.

## Design (smallest that works)

The Chief of Staff is a **department** created automatically with the company: template `chief-of-staff`
(hidden from the hire grid, one lead seat, toolsets `web` only, MCP tools from the market server). It gets a board
and a profile like any floor, so `ScheduleService`, quests and the MCP identity all work unchanged. The Executive
Office panel renders it instead of a floor.

- `assistantService.character()` returns the Chief of Staff's persona (rename title; keep the seeded name so
  existing installs don't change person). `draftDepartment` stays.
- `assistantService.draftListing()` -> `ListingDraftSchema` (brief 00): the same direct `model.complete` call
  `draftDepartment` makes, no Hermes task. Context is the company name and purpose and every non-hidden
  department's name, purpose and seat titles; the prompt asks for a listing a buyer on market.near.ai would hire:
  name, one-line tagline, description with what each department delivers, a USDC price per job, an SLA in hours,
  and the deliverables list. `POST /api/company/listing-draft` returns it (503 `ModelUnavailableError` when no
  model key, same as the other drafts). Nothing is stored: the user copies it into the market UI, then saves
  `marketAgentHandle` and `marketAgentToken` through the settings PATCH.
- **The "Set up the Agent Market" walkthrough** (CEO quest `market`, brief 05) is the Chief of Staff card in
  setup mode: the Chief of Staff's persona introduces four numbered steps, static copy in `data/views.ts`, each with
  the control it needs. 1) Create a market.near.ai account and confirm the email (link). 2) Ask for the listing
  draft (button above) and open "Building, Your agents, New agent" (link): paste the draft, choose hosting
  **self-hosted, no webhook**, price in USDC, SLA; one line says "Deploy on Vercel" runs a separate agent that
  bypasses your departments, so do not pick it. 3) Press "Create token" and paste the handle and the `aat_` token
  here (fields). 4) Vibe City verifies the token. Questions in between go to the existing assistant dialogue.
- `PATCH /api/company/settings { marketAgentToken }` calls `GET /v1/agents/me/assignments` with the token before
  storing it: 200 stores the token and sets `marketVerifiedAt`; 401 or 403 answers 422 "market.near.ai refused
  this token" and stores nothing; a network error stores the token with `marketVerifiedAt: null` and the card
  says "not verified yet" (the schedule's first successful tick sets it). The base URL comes from env
  `MARKET_BASE_URL` (default `https://market.near.ai`) so tests point it at a fake.
- `PATCH /api/company/settings { marketAgentToken }` stores the token in `company_settings` (write-only) and
  provisioning registers an MCP server entry `near-agent-market` = `{ url: 'https://market.near.ai/mcp', headers:
  { Authorization: 'Bearer <token>' } }` on the Chief of Staff's profile only, via the existing
  `setMcpServer` path in `app.ts`'s `afterProvision` hook (extend it; do not duplicate it).
- One schedule on the Chief of Staff's board, cron `*/2 * * * *`, enabled when the token is verified. Its objective
  is the loop, as a prompt:
  1. `list_my_assignments`; for each new one, `start_assignment`, then `request_quest` (our MCP) to the department
     whose purpose matches (the prompt lists departments by name and purpose, pulled from `list_departments`).
  2. For each quest it created earlier that is `completed`, read the result via our MCP (`read_task_file` /
     `check_request`) and `submit_deliverable`; on `request-changes`, create a follow-up quest.
  3. Record what it did in its task result.
  Because the lead's task finishes before its children, the follow-up happens on the next tick, not in one run.
- `QuestRequestService` already has approve/reject policy; set the Chief of Staff's requests to auto-approve.
- Earnings: the market pays the owner's market balance, not a chain address we can read. The Chief of Staff
  reports the accepted amount in its task result; brief 05 parses `[earned usd=<n>]` from Chief of Staff results
  for the runway card. When the user withdraws USDC to the OutLayer wallet, brief 03 shows the real balance.

## Files you own

`apps/backend/src/domain/assistantService.ts`, `apps/backend/src/domain/companyService.ts` (auto-create),
`packages/shared/src/templates/chief-of-staff.ts`, `apps/backend/src/routes/company.ts`, the `afterProvision` hook
body in `app.ts`, `apps/web/src/town/ui/ExecOffice*.tsx` (Chief of Staff card: "Draft the listing" button showing the draft with a
copy button per field and a link to the market's New agent page, then handle and token fields; token set?, last
tick, jobs won).

## Do not touch

`scheduleService.ts`, `questRequests.ts` (use their APIs), `mcp/server.ts`.

## Acceptance

- `assistant.test.ts`: a new company has a Chief of Staff department with one lead and no schedule until the
  token is set; setting the token enables the schedule and registers the MCP entry on exactly that profile
  (assert on FakeHermes).
- A test that feeds a fake "accepted" result and checks the earned amount is parsed.
- `draftListing` with the fake model: the prompt names every department and the reply parses with
  `ListingDraftSchema`; `GET /api/company/settings` never contains the token.
- Token verification with a fake fetch: 200 sets `marketVerifiedAt` and enables the schedule; 401 answers 422 and
  leaves settings unchanged; a thrown fetch stores the token unverified and the schedule stays disabled.

## Trailer moment (setup)

The CEO opens the quest, the Chief of Staff drafts the listing, the CEO pastes it into market.near.ai, creates the
token, pastes it back, and the quest ticks "token verified" while the Chief of Staff's schedule lights up.

## Trailer moment

From a buyer account, hire our listed agent for a small USDC job; watch the Chief of Staff hand it to the Software
Department, the PR appear, the deliverable submitted, accept it, payout lands.

## Revised 2026-11-08 (what was built)

The market has self-registration (`POST /v1/agents/register`, returns `agentId`, `handle` and the `aat_` token once)
so setup runs from the quest card (the adoption link was tried and dropped). The `market` quest is
done when the token is verified, and unlocks the **Marketplace Agency** template (`templates/marketplace-agency.ts`:
Agency Lead with `marketplace-worker`, Researcher, Writer, Builder). Its profiles get the token as
`MARKET_AGENT_TOKEN`; no other floor does. Price, currency and `listing_status: live` are account-session calls, so
the `first-job` card links the CEO to market.near.ai to go live, and to hiring the agency.

There is no Chief of Staff department, MCP entry or schedule: `domain/marketService.ts` polls
`/v1/agents/me/assignments?status=all` every 45 s from the backend, starts each new assignment, creates a quest on
the Marketplace Agency, submits the completed quest's results as `deliverableMarkdown`, opens a revision quest on
request-changes, and records accepted jobs in `market_job`. `first-job` reads those earnings. The agency is told
(not enforced) never to start, submit, decline or bid itself. No webhook (needs public HTTPS; polling is required
anyway). Not built: bidding on open jobs, declining a job whose quest failed (the SLA refund covers it).
