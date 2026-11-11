# Vibe City

A city UI over [Hermes](https://github.com/NousResearch/hermes-agent), the Nous Research agent runtime. You are the
CEO of a company drawn as a tower: a department is a floor, an agent is a Hermes profile at a desk, and a quest is a
task tree on the department's Hermes Kanban board. The company thinks with NEAR AI Cloud, keeps its money in an
OutLayer custody wallet, earns on the NEAR AI Agent Market, and ends with an IPO: a Sputnik DAO and its own token on
NEAR.

## Run it

The only requirement is Docker with Compose v2. No `.env`, no keys, no Node.

```
git clone https://github.com/urataps/vibe-city.git
cd vibe-city
docker compose up -d --build
```

Then open <http://127.0.0.1:4100>.

What to expect:

- The first build downloads the Hermes base image (about 3 GB). Later builds take under a minute.
- The container is ready about a minute after it starts. Check it:

  ```
  curl http://127.0.0.1:4100/api/runtime/health
  ```

  ```
  {"checkedAt":"...","hermes":{"dashboard":"up","auth":"ok","gateway":"running","version":"0.22.6","detail":"running"}}
  ```

- The browser shows the tower with the Executive Office and a quest log. The first quest is "Set up your Chief of
  Staff".
- Port 4100 taken? `VIBE_CITY_PORT=4300 docker compose up -d --build`, then open port 4300.
- Stop it with `docker compose down`. Add `-v` to also delete the company (the `hermes_data` volume).

## Play it

The quest log leads through the game. Each step needs an account of yours, because the agents, the wallet and the
market are real services and not mocks:

| Quest | What you do | What you need |
|---|---|---|
| Set up your Chief of Staff | Paste a NEAR AI Cloud API key and pick a model | A key from <https://cloud.near.ai> |
| Set up the treasury | Create a wallet and paste its agent key (`wk_...`) in the safe | A wallet from <https://app.outlayer.ai/wallet/new> |
| Hire your first department | Pick a template; its floor and agents are created in Hermes | The key from the first quest |
| List on the Agent Market, Win your first job | Ask the Chief of Staff to list a floor; a buyer hires it | An account on <https://market.near.ai> |
| Fund the IPO, IPO | Hold 4 NEAR in the company wallet and press IPO in the safe | 4 NEAR on mainnet |

Without a NEAR AI key the city, the quest log and the Executive Office work; hiring stays locked and agents cannot
run. Hiring a department takes a few minutes: each agent is a real Hermes profile, created and read back before the
floor is marked ready. Give a floor's lead a quest and the work shows on the desks as the lead hands tasks to
teammates.

Two side quests, Connect Hyperliquid and Connect Polymarket, open the Trading Desk and the Prediction Desk.

The key can also be set before the first start: copy `.env.example` to `.env` and fill `NEAR_AI_API_KEY`.

## See it without Docker or keys

The same backend and web app against in-memory fakes of Hermes, with a seeded company (floors with quests queued,
running, failed and done). Needs Node 24 or newer.

```
npm ci
npm run demo
```

Then open <http://127.0.0.1:4199>. Nothing in the demo talks to a real service.

## Check it

```
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` runs the backend against the fakes plus the web unit tests: no Docker, no network, no keys. CI
(`.github/workflows/ci.yml`) runs these four on every pull request, on Node 26.

`./scripts/docker-smoke.sh` builds the container, starts it under its own compose project on port 4190, checks the web
app and the Hermes dashboard, and creates a department through Hermes. It needs `curl` and `jq`, and takes about three
minutes.

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
