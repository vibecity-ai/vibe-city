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
| `connect-github` | Connect GitHub | `settings.githubConnected`; the hint takes a GitHub token (a fine-grained PAT) and stores it; brief 04's provisioning writes it as `GITHUB_TOKEN` into the Software profiles' `.env` | Software Department |
| `treasury` | Set up the treasury | `wallet.registered && (wallet.binding.status === 'active' \|\| any balance > 0)`; the CEO creates the wallet at app.outlayer.ai/wallet/new, pastes its agent key in the safe and funds it (binding is not offered: OutLayer cannot build that transaction on mainnet yet) | Treasury Ops (swaps and cross-chain moves through NEAR Intents: what the custody wallet does without a connector) |
| `connect-hyperliquid` | Connect Hyperliquid | `settings.hyperliquidConnectedAt`: the CEO stored the `HYPERLIQUID_POLICY` caps (max order, daily volume, leverage) for the company wallet at app.outlayer.ai/connect/hyperliquid, and a Check (one free `status` call to the connector, paid from the wallet's trial key) read `policy.present: true` | Trading Desk |
| `connect-polymarket` | Connect Polymarket | `settings.polymarketConnectedAt`: same, with `POLYMARKET_POLICY` (max order, daily volume) at app.outlayer.ai/connect/polymarket | Prediction Desk |
| `hire` | Hire your first department | departments (excluding chief-of-staff) >= 1 | |
| `market` | Set up the Agent Market | `settings.marketVerifiedAt` set (brief 02: the `aat_` token answered 200 on `GET /v1/agents/me/assignments`; there is no "listing live" signal, so the tick reads "token verified"). The hint opens the Chief of Staff card in setup mode, whose four steps (account, listing draft pasted into "New agent" as self-hosted without webhook, token, verify) are the walkthrough | |
| `first-job` | Win your first job | a Chief of Staff result contains `[earned usd=` | Token & Treasury |
| `first-swap` | First profitable trade | a Treasury Ops or Trading Desk result contains `[pnl usd=<n>]` with `n > 0` (a positive realized PnL marker; any trade with a tx or order id but no positive PnL does not count) | |
| `first-ship` | First code shipped | a Software Department result or activity line shows a merged pull request or push: a `[pr url=<github url>]` marker from the Coder, or an activity line carrying a `github.com/.../pull/` URL | Red Team, Blue Team |
| `ipo` | IPO | `earnedCents > 0` (any `[earned usd=]` or `[pnl usd=]` marker) and >= 3 departments `ready` (relaxed 2026-11-07 from "3 profitable days": unreachable before the trailer) | IPO button |

The quests are shown in this order, but `first-swap` and `first-ship` are **parallel**, not sequential: one needs
a money floor (Treasury Ops, opened by `treasury`, or the Trading Desk, opened by `connect-hyperliquid`), the other the Software Department (opened by `connect-github`), and either can
come first. `deriveGame` sets each template's `locked` from its own `unlock` quest (brief 00/01), so the quest
log's "next" highlight is cosmetic; the real gate is per department.

`profit` ("first profitable day") was the tier-3 gate until 2026-11-07; replaced by `first-ship` because the
security floors defend the company's own code, so shipping code is the event that should summon them. `shield` was
a quest until 2026-11-07 too; removed because it gated nothing and the early game is public. The confidential move
lives on in brief 06 as a recommended pre-IPO action, and `wallet.shielded` / `shield()` in brief 03 are unchanged.
`policy` ("Set the spend policy") was a quest until 2026-11-08; removed because a click on "I set the policy" proved
nothing. The connector quests replace it: they gate the trading floors on a policy OutLayer actually reports.

`templates.locked` = tier not yet unlocked. `GET /api/templates` (brief 01) calls `deriveGame` for this.

### Decisions

- `approval`: Hermes approval waiting on an agent turn (`pendingApprovals`, from the chat stream state we already
  track; if Kanban tasks don't expose it, only chat approvals count: say so in the UI copy).
- `owner_confirm`: a quest result or activity line containing `awaiting_owner`, i.e. an action the agent staged
  for the CEO to approve: a Sputnik proposal from the Token & Treasury DAO Secretary, or an X launch post from the
  Community Manager (the `x.com/intent/post` link is the confirm action); `href` = the quest.
- `answer`: quests in `awaiting_input` (already aggregated).
- `budget`: `usage.byDepartment[].overBudget`; `href` = the department's settings.

### Runway

`earnedCents` = sum of `[earned usd=<n>]` markers in Chief of Staff results (+ trading PnL markers
`[pnl usd=<n>]` if the Trading Desk prompt emits them). `dailyBurnCents` = `usage.companySevenDayAvgCents`.
`creditsRemainingCents` = `settings.nearAiCreditsLoadedCents - totalMeteredCents` (null if credits never entered).
`days = remaining / dailyBurn` (null when burn is 0). Always `estimated: true`.

## Backend

`routes/game.ts`: `GET /api/game` assembles the input and returns `deriveGame(...)`. Cache 5 s. No writes. The
connector quests are written by `POST /api/wallet/connectors/:name/check` (`routes/wallet.ts`), which stamps
`settings.<name>ConnectedAt` only when the connector reports the policy. `GET
/api/templates` fills `locked` and `unlocks` (brief 00 declared them) from the same derivation.

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
