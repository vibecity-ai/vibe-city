# 03 OutLayer wallet and department sub-keys

**Goal.** The company has one custody wallet whose keys live in OutLayer's TEE; the user sets its spend policy
and funds it with small amounts; departments that spend (Trading Desk, Prediction Desk) get a sub-key written into
their profiles. Agents then use OutLayer's own skills (`agent-custody`, `hyperliquid-connector`,
`polymarket-connector`, `github-connector`); we write no wallet or trading code.

## Facts (skills.outlayer.ai, read 2026-11-07)

- Mainnet host `https://api.outlayer.ai`, connectors account `connectors.outlayer.near`. We go mainnet with small
  amounts; `https://testnet-api.outlayer.ai` only to rehearse (no Intents there).
- `POST /register` with an empty body returns `{ api_key: 'wk_...', wallet_id, near_account_id, handoff_url,
  trial }`. The key is shown once. Claim the 50-call trial in the same breath: `POST /trial-key` with
  `Authorization: Bearer wk_...`.
- Policy is set by the owner at `handoff_url` (= `https://app.outlayer.ai/wallet?key=wk_...`): limits, whitelists,
  allowed tokens, rate limits, capability toggles (`swap`, `cross_chain_withdraw`, `evm_sign`... default deny).
- Fund link: `https://app.outlayer.ai/wallet/fund?to={near_account_id}&amount=&token=&dest=intents`.
- Balances: `GET /wallet/v1/balance?chain=near`, `...?token=<id>&source=intents`, `GET /wallet/v1/confidential/balance`.
- Sub-agents for a custody wallet: `PUT /wallet/v1/api-key` with the Bearer `wk_`. **Read
  `~/.claude/skills/agent-custody/references/register-and-auth.md` ("Create Sub-Agents") first and record in the PR
  whether a sub-key can carry a narrower policy or inherits the owner's.** If it inherits, one sub-key per spending
  department is still what we do; the per-department budget then lives in the city (brief 05), labelled `configured`.
- Connector calls: `POST /call/connectors.outlayer.near/<connector>` with `X-Payment-Key` (a payment key the wallet
  owns; the trial key works) and `X-Wallet-Id`. Agents do this themselves from the skills; we only need to put
  `OUTLAYER_API_KEY=<sub-key>`, `OUTLAYER_WALLET_ID`, `OUTLAYER_PAYMENT_KEY` into the profile `.env`.
- Confidential: `/wallet/v1/confidential/shield|unshield|transfer|swap`, settles on private shard `intents.far`.

## Backend

- `domain/walletService.ts`: `register()` (once; stores `wk_`, `wallet_id`, `near_account_id`, trial payment key
  in `company_settings`), `state()` -> `WalletStateSchema` (balances, cached 15 s, best effort with `error`),
  `shield(token, amount)`, `subKeyFor(departmentId)` (mints via `PUT /wallet/v1/api-key`, stores a reference in
  `department_wallet`, returns the plaintext once).
- Routes in `routes/wallet.ts`: `POST /api/wallet/register`, `GET /api/wallet`, `POST /api/wallet/shield`.
  Responses never include `wk_` or sub-keys; `handoffUrl` is returned only from `register` (it embeds the key)
  and the UI opens it immediately.
- Provisioning hook: in `afterProvision`, if the department's template says `wallet: 'sub-key'`, call
  `subKeyFor` and `setProfileEnv(profile, { OUTLAYER_API_KEY, OUTLAYER_WALLET_ID, OUTLAYER_PAYMENT_KEY })` for each
  profile. Reuse the existing hook; do not add a second one.
- `MoneyService`: add the OutLayer balance as a fourth pot next to wallets, treasury, credits.

## Web

- Executive Office: "Treasury" card with register button (opens handoff URL), fund link, balances by source,
  shield toggle, and per-floor "has wallet key" badge. CEO quest hooks come from brief 05.

## Files you own

`apps/backend/src/domain/walletService.ts` (new), `apps/backend/src/routes/wallet.ts`,
`apps/backend/src/domain/moneyService.ts` (one new pot), the sub-key branch in the `afterProvision` hook
(coordinate with brief 02, which edits the same hook for the market MCP entry: land 02 first, rebase),
`apps/web/src/town/ui/TreasuryCard.tsx` (new).

## Do not touch

`provisioningService.ts`, `hermes/realRuntime.ts`, `schemas.ts`.

## Acceptance

- `wallet.test.ts` with a fake fetch: register stores the key and never returns it from `GET /api/wallet`;
  provisioning a `trading-desk` department writes the three env vars to every profile of that department and none
  to a `software` department (assert on FakeHermes' recorded `setProfileEnv`).
- Manual, on mainnet with $10: register, set policy, fund, see balance, shield $1, see confidential balance.
