# 05 Game loop: CEO quests, decisions, runway

**Goal.** The city stops being a dashboard. The player has a quest log, real decisions the agents hand back, and a
runway number that goes up when the company earns and down when it burns. Everything is **derived** from state
we already have; no new tables beyond what brief 00 added.

## `domain/game.ts` (pure, tested)

`deriveGame(input): GameState` where `input` is a plain object assembled by the route from existing services:

```
{ settings: CompanySettings, wallet: WalletState, departments: DepartmentView[], templates: Template[],
  usage: AiUsageSummary, questsByDept: Record<deptId, QuestSummary[]>, chiefResults: string[] /* task results */,
  pendingApprovals: Array<{ departmentId, agentKey, title }>, now: Date }
```

### CEO quests (in order; each `done` is a boolean from input)

| id | title | done when | unlocks |
|---|---|---|---|
| `connect-ai` | Connect NEAR AI Cloud | `settings.nearAiApiKeySet` | hiring |
| `fund` | Fund the treasury | `wallet.registered && any balance > 0` | tier 1 (Trading Desk) |
| `hire` | Hire your first department | departments (excluding chief-of-staff) >= 1 | |
| `policy` | Set the spend policy | the user clicked "I set the policy" (`settings.policyConfirmedAt`); we cannot read it | |
| `list` | List the company on the Agent Market | `settings.marketAgentHandle` set and token set | |
| `first-job` | Win your first job | a Chief of Staff result contains `[earned usd=` | tier 2 (Software, Social, Prediction) |
| `first-swap` | First trade | a Trading Desk quest result contains a tx or order id | Prediction Desk |
| `profit` | First profitable day | `earnedToday > burnedToday` | tier 3 (Red, Blue) |
| `shield` | Shield the treasury | `wallet.shielded` | |
| `ipo` | IPO | runway > 0 for 3 consecutive days (from `ai_usage` days + earnings) and >= 3 departments ready | IPO button |

`templates.locked` = tier not yet unlocked. `GET /api/templates` (brief 01) calls `deriveGame` for this.

### Decisions

- `approval`: Hermes approval waiting on an agent turn (`pendingApprovals`, from the chat stream state we already
  track; if Kanban tasks don't expose it, only chat approvals count: say so in the UI copy).
- `owner_confirm`: a quest result or activity line containing `awaiting_owner` (GitHub connector writes the owner
  marked "confirm first"); `href` = the quest.
- `answer`: quests in `awaiting_input` (already aggregated).
- `budget`: `usage.byDepartment[].overBudget`; `href` = the department's settings.

### Runway

`earnedCents` = sum of `[earned usd=<n>]` markers in Chief of Staff results (+ trading PnL markers
`[pnl usd=<n>]` if the Trading Desk prompt emits them). `dailyBurnCents` = `usage.companySevenDayAvgCents`.
`creditsRemainingCents` = `settings.nearAiCreditsLoadedCents - totalMeteredCents` (null if credits never entered).
`days = remaining / dailyBurn` (null when burn is 0). Always `estimated: true`.

## Backend

`routes/game.ts`: `GET /api/game` assembles the input and returns `deriveGame(...)`. Cache 5 s. No writes except
`POST /api/game/confirm-policy` which sets `policyConfirmedAt`.

## Web

- Executive Office: **Quest log** (the CEO quests with done ticks, the next one highlighted, its hint and a button
  that opens the relevant panel), **Decisions** list (one row each, click opens the target), **Runway** card
  (days, earned vs burned today, per-floor burn bars from `usage.byDepartment`). Reuse the existing panel styles.
- Hire grid: locked templates show "unlocks after <quest title>".
- Cosmetics only if everything above is done: desk title badge by tasks done (Junior < 5, Senior < 20, Lead),
  city-news ticker from `describeEvent` lines.

## Files you own

`apps/backend/src/domain/game.ts` + test (new), `apps/backend/src/routes/game.ts`,
`apps/web/src/town/ui/QuestLog.tsx`, `DecisionsList.tsx`, `RunwayCard.tsx` (new), one mount point each in
`Panels.tsx` (rebase on brief 01's panel changes).

## Do not touch

Any service in `domain/` other than `game.ts`; `data/live.ts` beyond adding the `/api/game` fetch to the existing
refresh cycle.

## Acceptance

- `game.test.ts`: table-driven: for each quest, an input where it is not done and one where it is; locked tiers
  follow; runway null without credits, computed with; a department over budget yields a `budget` decision;
  `awaiting_input` yields an `answer` decision.
- Web: the quest log renders from a fixture and the next quest's button opens the right panel.
