# 01 Templates and the hire flow

**Goal.** "Hire a department" from a list of six templates instead of filling a blank form. A template is
configuration only: inventory, purpose, a lead plus teammate seats, the skills the agents may load, whether the
floor gets the company wallet key (`wallet: 'company'`, decided 2026-11-07: no sub-wallets), and the quest that unlocks it. Every floor is a team: the lead takes the quest and hands parts
of it to teammates by profile name (the delegation path that already exists), so each seat has a distinct job the
lead can name.

## The templates (`packages/shared/src/templates/*.ts`)

| id | name | unlocked by | loop | lead title | teammates | wallet | budget |
|---|---|---|---|---|---|---|---|
| `trading-desk` | Trading Desk | `treasury` quest | yes | Head of Trading | Market Analyst, Perps Trader, Risk Officer | company | 500 |
| `software` | Software Department | `connect-github` quest | no | Engineering Manager | Coder, QA & Testing, DevOps | none | 1000 |
| `token-treasury` | Token & Treasury | `first-job` quest | yes | Head of Treasury | Tokenomics Analyst, DAO Secretary, Community Manager | company | 300 |
| `prediction-desk` | Prediction Desk | `connect-polymarket` quest | yes | Head of Research | Forecaster, Position Trader | company | 300 |
| `red-team` | Red Team | `first-ship` quest (first PR/push) | no | Red Team Lead | Recon Analyst, Hardening Engineer | none | 300 |
| `blue-team` | Blue Team | `first-ship` quest (first PR/push) | no | Blue Team Lead | Detection Engineer, Patch Engineer | none | 300 |

Unlocks are a dependency graph, not a ladder. The Software Department is foundational and opens early, as soon as
the user connects GitHub (`connect-github`), because almost any direction the company takes needs code. Prediction
opens once the Trading Desk turns a profitable trade, and the two security floors open once the Software Department
ships code. Each template's `unlock` is the quest id; brief 05 computes `locked`.

Budget = `inventory.limits.dailyBudgetCredits` (1 credit = 1 US cent, enforced by brief 04). The Chief of Staff
(brief 02) is a seventh, hidden template with one seat.

Each seat is `{ title, model, skills, toolsets }` (schema from brief 00) and becomes one `department_agent` row and
one Hermes profile. `model` is null (department default) except the Red Team seats, which use
`deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated` on provider `near-ai`. Skills are referenced by id and loaded
by the agents, never written by us; an id Hermes does not know makes the capability report say `unverified`, which
is correct. Toolsets come from `TOOLSETS`.

## Seats per template

**Trading Desk** — toolsets web, terminal; skills `agent-custody`, `hyperliquid-connector`.
- Head of Trading: splits the objective into research, execution and review; writes `[pnl usd=<n>]` in its result
  (brief 05 reads it).
- Market Analyst (web): prices, funding and news; a one-page brief with a recommended position and size.
- Perps Trader (`hyperliquid-connector`): opens, protects and closes positions inside the OutLayer policy.
- Risk Officer (`agent-custody`, balance and position reads): checks exposure against the purpose's limits and
  tells the lead to cut. The floor shares the company wallet key, so this split is enforced by the prompt, not
  OutLayer; the purpose text says so.

**Software Department** — toolsets terminal, file, code_execution, web; no OutLayer skill. It uses `git` and `gh`
directly from the terminal (a GitHub token in the profile `.env`), not the OutLayer GitHub connector: brief 03 cut
that connector, and a `wallet: none` floor has no payment key to call one. The dev image has no `gh` (checked
2026-11-06): add `gh` to the `Dockerfile` apt list, and brief 03's `afterProvision` env write puts `GH_TOKEN`
(from the backend's `GITHUB_TOKEN` env) into every Software seat's profile `.env`.
- Engineering Manager: turns a quest into issues, assigns, merges when QA passes.
- Coder: implements on a branch, opens the PR with `gh`, and writes a `[pr url=<github url>]` marker in its task
  result (the game loop reads it for the `first-ship` quest that unlocks the security floors; brief 05).
- QA & Testing: runs the suite, writes missing tests, reviews the PR.
- DevOps: CI, Docker and deploy scripts.

**Token & Treasury** — toolsets web, terminal; skills `agent-custody`, `near-cli-rs`. Replaces Social Media. It
prepares the IPO (brief 06), runs the DAO after it, and handles public announcements.
- Head of Treasury: a weekly treasury report (OutLayer balances, DAO balance, burn from `ai_usage` via our MCP)
  and the list of open proposals. It does not press IPO; that stays a CEO button.
- Tokenomics Analyst (web): token name, symbol, supply and allocation as the task result, with a
  `[token symbol=.. supply=..]` marker that brief 06 reads to pre-fill the IPO form.
- DAO Secretary (`agent-custody`): drafts Sputnik proposals and submits `add_proposal` through the OutLayer wallet
  once the CEO approves (an `owner_confirm` decision in brief 05); reads `get_proposals` for status.
- Community Manager: drafts the launch announcement and thread as its task result. Posting is a CEO decision
  (brief 05) that opens a pre-filled `x.com/intent/post?text=...` link, same manual pattern as meme.cooking and
  Trezu. No X API keys, no server code, no MCP tool.

**Prediction Desk** — toolsets web, terminal (the OutLayer API is curl with a bearer token); skills `agent-custody`, `polymarket-connector`.
- Head of Research: picks markets that fit the purpose, sizes the position, writes `[pnl usd=<n>]`.
- Forecaster (web): the evidence and probability estimate for a market.
- Position Trader (`polymarket-connector`): buys, sells and claims outcome shares inside the policy.

**Red Team** — toolsets terminal, web, browser; skills scoped to our own repositories; model abliterated DeepSeek.
Finds weaknesses in the company's own code and infrastructure only. The purpose text names the in-scope repos and
says findings go to the Blue Team, never outside.
- Red Team Lead: scopes the engagement to our assets, collects findings, writes the report.
- Recon Analyst (web, browser): maps our own surface from public information.
- Hardening Engineer (terminal): reproduces a finding against our code so the fix can be verified.

**Blue Team** — toolsets terminal, file, web; defensive skills.
- Blue Team Lead: triages Red Team findings, assigns fixes, signs off.
- Detection Engineer: adds logging, alerts and tests that catch the issue.
- Patch Engineer: writes and verifies the fix.

## Backend

- `GET /api/templates` returns the list with `locked: boolean` per template, computed by brief 05's game state;
  until that lands, everything is unlocked.
- `POST /api/departments { template }`: `departmentService.create` copies the template's inventory and purpose,
  creates every seat with `insertAgent` (already there: model and skills per seat), stores `template_id`, and
  stores each seat's title through `savePersona` (the persona already carries `title`; the city reads it, so no new
  column), then runs the normal provision flow so each seat gets a profile.
- A template with `loop: true` creates one disabled schedule (`ScheduleService.create`) named after the template
  with a placeholder objective; the user enables it from the department panel.

## Web

- Replace the create-department form's first step with a template grid (name, purpose, seat titles, the unlock chip,
  "locked until <quest>" when locked). Selecting one pre-fills the existing form so the user can still edit.
- Desk labels show seat titles. No other UI changes.

## Files you own

`packages/shared/src/templates/*`, `apps/backend/src/routes/templates.ts`, `apps/backend/src/domain/departmentService.ts`
(create path only), `Dockerfile` (the `gh` package), `apps/web/src/town/ui/HirePanel.tsx` (new), the create-form
call sites in `Panels.tsx`.

## Do not touch

`provisioningService.ts`, `hiringService.ts` beyond extracting the seat-creation helper, `schemas.ts` (brief 00 owns it).

## Acceptance

- `templates.test.ts`: every template parses with `TemplateSchema`; creating a department from `software` yields
  four `department_agent` rows with the right titles (one lead, three teammates); creating from `trading-desk`
  yields one disabled schedule and four rows.
- Web test in `derive.test.ts`: seat titles appear on desks.

## Note on desk count

`MAX_DESKS = 6` in `derive.ts` draws up to six teammate desks per floor; four seats fit. No change needed.
