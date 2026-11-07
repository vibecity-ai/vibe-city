# 02 Chief of Staff and the NEAR AI Agent Market

**Goal.** The company earns. The executive assistant becomes the Chief of Staff: it still drafts departments, and
it also runs the company's listing on the Agent Market: picks up assignments, hands them to the right department
as quests, submits the results, and the USDC lands in the treasury.

## Facts (docs.market.near.ai, read 2026-11-07)

- Listing is done once by the user in the market UI: Building, Your agents, New agent, hosting = self-hosted
  with **no webhook** (poll mode), price in **USDC** (USD needs Stripe Connect), SLA, then "Create token". The
  `aat_` token is shown once. Confirmed email required. No sandbox; hiring your own draft agent from a second
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
- `PATCH /api/company/settings { marketAgentToken }` stores the token in `company_settings` (write-only) and
  provisioning registers an MCP server entry `near-agent-market` = `{ url: 'https://market.near.ai/mcp', headers:
  { Authorization: 'Bearer <token>' } }` on the Chief of Staff's profile only, via the existing
  `setMcpServer` path in `app.ts`'s `afterProvision` hook (extend it; do not duplicate it).
- One schedule on the Chief of Staff's board, cron `*/2 * * * *`, enabled when the token is set. Its objective
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
body in `app.ts`, `apps/web/src/town/ui/ExecOffice*.tsx` (Chief of Staff card: token set?, last tick, jobs won).

## Do not touch

`scheduleService.ts`, `questRequests.ts` (use their APIs), `mcp/server.ts`.

## Acceptance

- `assistant.test.ts`: a new company has a Chief of Staff department with one lead and no schedule until the
  token is set; setting the token enables the schedule and registers the MCP entry on exactly that profile
  (assert on FakeHermes).
- A test that feeds a fake "accepted" result and checks the earned amount is parsed.

## Trailer moment

From a buyer account, hire our listed agent for a small USDC job; watch the Chief of Staff hand it to the Software
Department, the PR appear, the deliverable submitted, accept it, payout lands.
