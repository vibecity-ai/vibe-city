# Hackathon briefs

One brief per workstream, derived from the plan (Claude doc "Vibe City – NEAR Hackathon Plan"). Each brief owns a
set of files; two agents never edit the same file at once. Order:

| # | Brief | Depends on | Owner files (summary) |
|---|---|---|---|
| 00 | Foundation: schemas, migrations, route modules | nothing; lands first | `packages/shared`, `db/db.ts`, `routes/*.ts` stubs |
| 01 | Templates and the hire flow | 00 | `shared/templates`, `routes/templates.ts`, web hire panel |
| 02 | Chief of Staff + Agent Market | 00 | `assistantService.ts`, market MCP entry, company schedule |
| 03 | OutLayer wallet and sub-keys | 00 | `domain/walletService.ts`, provisioning hook, money panel |
| 04 | Metering proxy for NEAR AI | 00 | `routes/ai.ts`, `domain/aiUsage.ts`, provisioning env |
| 05 | Game loop: CEO quests, decisions, runway | 01-04 for real data; can start on fakes | `domain/game.ts`, web quest log |
| 06 | IPO: DAO + city token | 03, 05 | `domain/ipoService.ts`, `routes/ipo.ts` |

Shared conventions every brief inherits are in `/CLAUDE.md`. Hermes facts are in `/docs/hermes.md`.
A brief is done when its acceptance test passes in `npm test`, the web build is green, and the PR says what was
skipped.

Known collision points: `apps/backend/src/app.ts` (register your route module with one line, nothing else),
`apps/web/src/town/ui/Panels.tsx` (briefs 01 and 05 both add a panel; 01 lands first, 05 rebases), and
`packages/shared/src/schemas.ts` (00 lands the skeletons; later briefs only fill in fields they declared there).
