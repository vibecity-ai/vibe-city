# Vibe City

A city UI over [Hermes](https://github.com/NousResearch/hermes-agent), the Nous Research agent runtime. You are the
CEO of a company drawn as a tower: a department is a floor, an agent is a Hermes profile at a desk, and a quest is a
task tree on the department's Hermes Kanban board. The company thinks with NEAR AI Cloud, keeps its money in an
OutLayer custody wallet, earns on the NEAR AI Agent Market, and ends with an IPO: a Sputnik DAO and its own token on
NEAR.

## Run it (judges start here)

Needs Node 24 or newer (CI uses Node 26). No Docker, no API keys, no `.env`.

```
npm install
npm run demo
```

Then open <http://127.0.0.1:4199>. Port taken? `PORT=4300 npm run demo`.

`npm run demo` builds the web app and serves it from the real backend, with in-memory fakes for everything outside
it: Hermes and its Kanban, the chat model, NEAR AI Cloud, OutLayer, NEAR RPC and market.near.ai. The agents are
simulated by a fake Hermes and the chat is scripted. Nothing talks to a real service and nothing is saved: the
company starts again on every run.

## What to try

The company starts with three floors and jobs already queued, running, failed, done and waiting on you.

1. **The tour.** A 6-step tour opens over the tower. Click through it or close it.
2. **The tower.** Floors F1 Research, F2 Growth and F3 Support, plus PH, the Executive office. A red "!" on a floor
   label means the floor needs attention. Click a floor (or its lift button) to walk in; Esc or "Tower" goes back.
3. **The Executive office** (right panel). It shows the current quest with a pink primary button, the money stats,
   and the "In tray": the things waiting for you (answers, approvals, stuck jobs).
4. **Quest 1, Set up your Chief of Staff.** Click "Set it up". The demo prefills a key: pick a model, then "Save and
   continue". This unlocks hiring, and the agents start working their boards.
5. **Quest 2, Set up the treasury.** Click "Open the safe", then "Connect". The wallet pager shows a linked wallet
   and a portfolio.
6. **Quest 3, Hire your first department,** is already done: the seeded floors count.
7. **Quest 4, List on the Agent Market.** The quest opens a chat with the Chief of Staff. Ask, for example, "List the
   Research floor on the Agent Market". A Gazette listing card appears: click "Register as draft". You land on the
   Research floor's Marketplace board: click "Claim it", then "Check claimed".
8. **Act 2, Win your first job.** The simulated buyer hires the listed floor and pays within about a minute. Fund the
   IPO then completes from the wallet balance.
9. **Act 3, IPO.** Click "Open the safe", type any NEAR account (for example `boss.near`) in "Chair · your NEAR
   account", then "Ring the opening bell". The bell goes up on the roof and the panel says "The company is public."

10. **Side quests, Connect Hyperliquid and Connect Polymarket** (optional, at the bottom of the quest log, once the
    wallet is connected). Press "Check" on each: the demo's OutLayer answers that the connector is set, and the quest
    unlocks a new floor template to hire, Trading Desk and Prediction Desk.

Also worth a look:

- "Quests" in the top bar: the quest log, grouped in acts.
- "Ops board" in the top bar: every job in the company as a paper ticket, in columns.
- The phone: when it rings, "Answer" opens a conversation with a character.

## Full stack (optional, the real experience)

Not needed to judge the project. Here the agents are real Hermes profiles and the model, the wallet, the market and
the IPO are real services. It needs Docker with Compose v2 and a NEAR AI Cloud key (<https://cloud.near.ai>), which
you paste in the first quest or set as `NEAR_AI_API_KEY` in `.env`. The first build downloads the Hermes base image
(about 3 GB).

- **Everything in one container:** `docker compose up -d --build`, then open <http://127.0.0.1:4100>. No `.env`
  needed.
- **Development, with hot reload (Linux only):** `cp .env.example .env`, set `HERMES_DASHBOARD_SESSION_TOKEN`, then
  `npm run dev`. It runs Hermes in Docker, the backend on <http://127.0.0.1:4100> and Vite on
  <http://localhost:4200>.

The later quests need accounts of your own: an OutLayer wallet, an account on market.near.ai, and 4 NEAR on mainnet
for the IPO. [DEPLOYMENT.md](DEPLOYMENT.md) has the setup, the models, the wallet and the market.

## Develop

```
npm run typecheck
npm test
npm run build
```

`npm test` runs the backend against the fakes plus the web unit tests: no Docker, no network, no keys. CI
(`.github/workflows/ci.yml`) runs all three on every pull request, on Node 26. Read
[ARCHITECTURE.md](ARCHITECTURE.md) before touching code; the hackathon plan, one brief per workstream, is in
[docs/briefs/](docs/briefs/).

## What is in the repo

```
packages/shared      zod schemas and types: every API body, shared by backend and web; the department templates
apps/backend         Fastify API, SQLite (node:sqlite), the Hermes adapter, the MCP server agents call back into
apps/web             React + Vite; src/town is the city (Canvas 2D)
contracts/           the city token and its factory (Rust, NEAR); the IPO uses the factory at tokens.vibecity.near
docker/              what the container adds to the Hermes image: start scripts and vendored agent skills
docs/briefs/         the hackathon plan, one brief per workstream
```

- [ARCHITECTURE.md](ARCHITECTURE.md): how the pieces fit, who owns which data, what is guaranteed and what is not.
- [DEPLOYMENT.md](DEPLOYMENT.md): the container, the development setup (`npm run dev`), models, the wallet, the market.
- [docs/hermes.md](docs/hermes.md): Hermes behaviours checked against a live instance.
- [contracts/README.md](contracts/README.md): the two contracts, how they are built and deployed.

## Limits you should know

These apply to the full stack; the demo holds no real keys or funds.

- The API has no login. The container publishes it on `127.0.0.1` only; do not expose the port.
- Agents run inside the container, as the same user as the backend and on the same volume. Keys are handed only to
  the floors that need them, but an agent with terminal or file tools could read the others. Use a NEAR AI key with a
  spending limit and a wallet you can afford to lose. Details: DEPLOYMENT.md, "Isolation".
- The wallet, the market and the IPO act on mainnet and spend real funds.

## Built before the hackathon

The project's setup and first design were done before the hackathon. All of it is in the first commit, added in one
piece on 2026-11-03 and marked with the git tag `pre-hackathon` (`f1e1c70`): the backend with its Hermes adapter,
department provisioning, quests on Hermes Kanban, live updates, the first tower UI, the Dockerfile and CI. Everything
after that tag was built for the hackathon and is in the history:
agent chat, hiring, schedules, the MCP server, quests between departments, department templates, the Chief of Staff,
the Agent Market listing, the OutLayer wallet, the NEAR AI metering proxy, the CEO quest log, the IPO and the two
contracts. `git diff pre-hackathon` shows it.

## License

AGPL-3.0-only, see [LICENSE](LICENSE). Vendored agent skills in `docker/skills` keep their own licenses
(`docker/skills/SOURCES`).
