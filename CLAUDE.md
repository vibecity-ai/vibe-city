# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Vibe City: working notes for agents

Vibe City is a city UI over Hermes (Nous Research's agent runtime): a department is a floor, an agent is a Hermes
profile, a quest is a task tree on the department's Kanban board. Read `ARCHITECTURE.md` (10 minutes) before
touching code. The hackathon plan and the brief for your workstream are in `docs/briefs/`.

## Commands

```
npm install
npm run typecheck        # tsc for every workspace
npm test                 # backend (FakeHermes, no live Hermes) + web unit tests; must stay green
npm run build            # web app
npm run dev              # Hermes in Docker + backend :4100 + Vite :4200 (needs .env, see DEPLOYMENT.md)

# one test file (no build step; Node runs TS directly via --experimental-strip-types)
cd apps/backend && node --experimental-strip-types --test src/quests.test.ts
cd apps/web && node --experimental-strip-types --test src/town/data/derive.test.ts
# add --test-name-pattern="<regex>" to run a single test

# offline demo with the fakes, no Docker or API keys
npm run demo             # builds the web app, then http://127.0.0.1:4199
```

Node 26 (what CI uses). No transpile step for backend or tests, so TS must stay strip-types compatible (no enums,
no namespaces, no parameter properties). CI runs typecheck, test and build on every PR. A PR that turns any of them red is not done.

## Layout

```
packages/shared/src/schemas.ts   every API body and response, zod; the contract between backend and web
apps/backend/src/app.ts          route registration + error mapping (keep it a hub; new routes go in src/routes/)
apps/backend/src/routes/         route modules (company, market, wallet, game, ipo, templates, ai)
apps/backend/src/domain/         services (company, department, provisioning, quests, chat, hiring, schedules, money,
                                 market, wallet, game)
apps/backend/src/live/           Hermes Kanban WebSocket per board -> refresh hints on /api/live
apps/backend/src/near/, model/   NEAR RPC, NEAR AI chat model + prices
apps/backend/src/hermes/         ports.ts = HermesRuntime interface; realRuntime.ts = dashboard REST + `hermes` CLI
apps/backend/src/mcp/            the MCP server Hermes agents call back into
apps/backend/src/db/db.ts        MIGRATIONS (append-only) + openDb
apps/backend/src/testing/        FakeHermes / FakeKanban used by tests
apps/web/src/town/               the city: data/live.ts (only data source), data/derive.ts (pure), ui/Panels.tsx
docs/briefs/                     one brief per hackathon workstream; docs/hermes.md = verified Hermes behaviors
```

## Rules that are not negotiable

- **Schemas first.** Any new route or field starts in `packages/shared/src/schemas.ts`. Backend parses requests
  and responses with the same schema the web client parses with. Unknown fields are rejected (`.strict()`).
- **Hermes only through the `HermesRuntime` port.** Never read Hermes' SQLite or files, never call Hermes
  internals. New capability = a method on `ports.ts`, implemented in `realRuntime.ts` AND `testing/fakeHermes.ts`.
- **Vibe City owns no quest data.** Hermes Kanban is the source of truth for tasks; we store references and cursors.
- **Secrets stay server-side.** Hermes tokens, API keys and wallet keys never reach the browser or an API response.
  Keys an agent needs go into its profile `.env` via `setProfileEnv`, the way `API_SERVER_KEY` does today.
- **Error messages never echo host paths.** Free text from Hermes goes through `domain/scrub.ts`.
- **Honest labels.** A capability is `enforced` only if we applied it, read it back and tested it holds. Do not
  describe anything as isolated, secured or guaranteed unless the code proves it.
- **Migrations are append-only** entries in `MIGRATIONS`; never edit an existing one.
- **Tests use the fakes.** `npm test` must never need Docker, Hermes, a network or an API key. New logic ships
  with a test next to it (`*.test.ts`).
- **Commits:** imperative subject, short body saying why. No `Co-Authored-By`, no "Generated with" lines.

## How to work a brief

1. Branch from `main`, one branch per brief, your own git worktree.
2. Read the brief's "files you own" and "do not touch" lists. If the task needs a file you don't own, stop and
   say so in the PR instead of editing it.
3. Land schema changes first in a small commit so other workstreams can rebase on them.
4. Smallest change that fully works. No options, wrappers or "for later" code. Delete beats add.
5. Add the brief's acceptance test. Run `npm run typecheck && npm test && npm run build`.
6. Open the PR against `main` with the brief's name in the title and a 5-line summary: what, how to see it, what
   you skipped.

## Hackathon context (until 2026-11-14)

Judges' AI screener runs the repo from the README and checks it does what the README says. Prefer a working
narrow path over a wide half-working one. Anything not in `docs/briefs/` waits until after 2026-11-18.
