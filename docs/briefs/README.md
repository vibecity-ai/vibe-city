# Hackathon briefs

One brief per workstream, derived from the plan (Claude doc "Vibe City – NEAR Hackathon Plan"). Each brief owns a
set of files; two agents never edit the same file at once. Order:

| # | Brief | Depends on | Owner files (summary) |
|---|---|---|---|
| 00 | Foundation: schemas, migrations, route modules | nothing; lands first | `packages/shared`, `db/db.ts`, `routes/*.ts` stubs |
| 01 | Templates and the hire flow | 00 | `shared/templates`, `routes/templates.ts`, web hire panel |
| 02 | Chief of Staff + Agent Market | 00 | `assistantService.ts`, market MCP entry, company schedule |
| 03 | OutLayer wallet | 00 | `domain/walletService.ts`, provisioning hook, money panel |
| 04 | Metering proxy for NEAR AI | 00 | `routes/ai.ts`, `domain/aiUsage.ts`, provisioning env |
| 05 | Game loop: CEO quests, decisions, runway | 01-04 for real data; can start on fakes | `domain/game.ts`, web quest log |
| 06 | IPO: DAO + city token + revenue share | 03, 05 | `domain/ipoService.ts`, `routes/ipo.ts` |

## Step 0 (Nov 8 morning, before any brief)

The repo has no `README.md`, no `LICENSE` and no git tags, and its history starts 2026-11-03 although the code
predates the hackathon. Missing any of these is a disqualification, not a lower score.

1. `LICENSE` (MIT) and a `README.md` written as "do X, see Y" steps for a machine reader, with one paragraph
   disclosing which parts predate 2026-10-19. No marketing.
2. Tag `pre-hackathon` on the cut commit and push it.
3. `docker compose up` on a machine that has never seen the repo; fix whatever breaks before any feature.

## Schedule (decided 2026-11-07)

| Days | Work |
|---|---|
| Nov 8 | Step 0, then brief 00 alone (hours) |
| Nov 8-10 | 01, 03, 04 in parallel worktrees (disjoint files) |
| Nov 10-11 | 02 (needs 01's hidden template; lands before 03 rebases the `afterProvision` hook) |
| Nov 11-12 | 05 |
| Nov 12-13 | 06 (first to drop) |
| Nov 14 | trailer, X post, form; nothing new |

Decisions taken 2026-11-07: spending floors share the company OutLayer key (no sub-wallets); the IPO unlocks
once the company has earned at least once and three departments are ready; the OutLayer wallet signs the IPO
transactions; all six templates ship in brief 01.

Shared conventions every brief inherits are in `/CLAUDE.md`. Hermes facts are in `/docs/hermes.md`.
A brief is done when its acceptance test passes in `npm test`, the web build is green, and the PR says what was
skipped.

Known collision points: `apps/backend/src/app.ts` (register your route module with one line, nothing else),
`apps/web/src/town/ui/Panels.tsx` (briefs 01 and 05 both add a panel; 01 lands first, 05 rebases), and
`packages/shared/src/schemas.ts` (00 lands the skeletons; later briefs only fill in fields they declared there).
