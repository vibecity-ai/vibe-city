# 03 OutLayer wallet

**Goal.** The company has one custody wallet whose keys live in OutLayer's TEE. The CEO quest "Set up the
treasury" (brief 05) offers two ways to make it the treasury, and both end in the same `WalletState`:

- **Create a treasury:** register the wallet, set its policy at the handoff URL, fund it through the fund link.
  Done when a balance is above zero.
- **Connect my wallet:** register the wallet, then bind it to one of the user's already-linked NEAR accounts
  (`MoneyService` wallets, linked through the wallet selector today) so it acts as that account under the
  account's policy. The user signs one transaction at the connect URL. Done when the binding is `active`; the
  treasury balance is then the bound account's.

Departments that spend (Trading Desk, Prediction Desk, Token & Treasury) get the company wallet key written into
their profiles. Agents then use OutLayer's own skills (`agent-custody`, `hyperliquid-connector`,
`polymarket-connector`); we write no wallet or trading code.

**Scope decided 2026-11-07:** only the custody wallet and the `hyperliquid` and `polymarket` connectors. No
Gmail or GitHub connector, and no OutLayer project (WASI module) of our own. **No sub-wallets** (also decided
2026-11-07, see the verified note below): spending floors share the company key, and the UI labels the floor
badge "shared company wallet". The per-floor budget is brief 04's credit budget, not a wallet limit.

**Blocker before funding:** the company wallet is not owner-bound to the NEAR account that holds the connector
policy rows, so the trading connectors report `policy.present: false` (wide-open defaults). Bind the owner at the
handoff URL and re-check before any funds go in.

## Facts (skills.outlayer.ai, read 2026-11-07)

- Mainnet host `https://api.outlayer.ai`, connectors account `connectors.outlayer.near`. We go mainnet with small
  amounts; `https://testnet-api.outlayer.ai` only to rehearse (no Intents there).
- `POST /register` with an empty body returns `{ api_key: 'wk_...', wallet_id, near_account_id, handoff_url,
  trial }`. The key is shown once. Claim the 50-call trial in the same breath: `POST /trial-key` with
  `Authorization: Bearer wk_...`.
- Policy is set by the owner at `handoff_url` (= `https://app.outlayer.ai/wallet?key=wk_...`): limits, whitelists,
  allowed tokens, rate limits, capability toggles (`swap`, `cross_chain_withdraw`, `evm_sign`... default deny).
- Fund link: `https://app.outlayer.ai/wallet/fund?to={near_account_id}&amount=&token=&dest=intents`.
- Binding (`agent-custody/references/account-binding.md`): `PUT /wallet/v1/binding { asset_account_id, kind:
  'personal_account' }` records it (`binding_status: pending`); the user signs once at
  `https://app.outlayer.ai/wallet/connect?key=wk_...` (under 0.1 NEAR, refuses if the connected wallet is not that
  account; `409` from the setup kit means the account already runs a contract: pick another, never override);
  `GET /wallet/v1/binding` until `active`. A bound wallet has two accounts: its own (`/wallet/v1/balance`,
  `/transfer`, `/call`) and the bound one (`/wallet/v1/binding/balance`, `/binding/transfer`). Policy rows and
  connector `secrets_ref` are keyed by the wallet's own hex account, not the bound name. The owner-binding
  blocker above is this step.
- Balances: `GET /wallet/v1/balance?chain=near`, `...?token=<id>&source=intents`, `GET /wallet/v1/confidential/balance`.
- **Verified 2026-11-07 on mainnet (why there are no sub-wallets):** `PUT /wallet/v1/api-key` with `{ seed, key_hash }` (sub-key =
  `wk_` + sha256(`<seed>:0:<parent wk_>`)) answers 200 `{ wallet_id, near_account_id }` with a **new wallet_id and
  its own NEAR address**, balance 0, no payment key (`404 no_payment_key`), empty `pending_approvals`. So a
  department sub-key is a separate wallet, not a scoped key on the company wallet: it must be funded by a
  transfer from the company wallet, and it pays for connectors with its own trial/payment key or with the
  company's. Whether its policy is set separately (at `app.outlayer.ai/wallet?key=<sub wk_>`) or inherited is
  still unverified; no agent-side endpoint reads policy. Three extra mainnet steps per floor for no isolation we
  could prove, so we dropped it.
- Connector calls: `POST /call/connectors.outlayer.near/<connector>` with `X-Payment-Key` (a payment key the wallet
  owns; the trial key works) and `X-Wallet-Id`. Agents do this themselves from the skills; we only need to put
  `OUTLAYER_API_KEY=<sub-key>`, `OUTLAYER_WALLET_ID`, `OUTLAYER_PAYMENT_KEY` into the profile `.env`.
- Confidential: `/wallet/v1/confidential/shield|unshield|transfer|swap`, settles on private shard `intents.far`.

## Backend

- `domain/walletService.ts`: `register()` (once; stores `wk_`, `wallet_id`, `near_account_id`, trial payment key
  under `company_settings.secrets`), `state()` -> `WalletStateSchema` (balances, cached 15 s, best effort with
  `error`; `binding` from `GET /wallet/v1/binding`, and when `active` one `source: 'bound'` balance from
  `/wallet/v1/binding/balance`), `bind(accountId)` (registers first if needed; `PUT /wallet/v1/binding`; returns
  the connect URL once), `shield(token, amount)`, `profileEnv()` (the three env vars below, or null when not
  registered), and `call(receiverId, method, args, deposit, gas)` -> `{ txHash }` through `POST /wallet/v1/call`
  (`agent-custody/references/wallet-ops.md`), which brief 06 uses to create the DAO and deploy the token.
- Routes in `routes/wallet.ts`: `POST /api/wallet/register`, `GET /api/wallet`, `POST /api/wallet/bind
  { accountId }` (409 unless `accountId` is one of `MoneyService`'s linked wallets; replies `{ connectUrl }`),
  `POST /api/wallet/shield`. Responses never include `wk_`; `handoffUrl` and `connectUrl` embed the key, so they
  are returned only from `register` and `bind` and the UI opens them immediately.
- Provisioning hook: in `afterProvision`, if the department's template says `wallet: 'company'`, call
  `setProfileEnv(profile, { OUTLAYER_API_KEY: <company wk_>, OUTLAYER_WALLET_ID, OUTLAYER_PAYMENT_KEY })` for each
  profile; for template `software`, write `GH_TOKEN` from the backend's `GITHUB_TOKEN` env (brief 01). Reuse the
  existing hook; do not add a second one. The key is in the profile's own `.env`, which that agent can read with
  terminal tools anyway; what the hook guarantees is only that `wallet: none` floors never receive it.
- `MoneyService`: add the OutLayer balance as a fourth pot next to wallets, treasury, credits.

## Web

- Executive Office: "Treasury" card. Unregistered: two buttons, "Create a treasury" (register, open handoff URL,
  show fund link) and "Connect my wallet" (pick a linked NEAR account, or link one through the existing wallet
  selector flow in `Money.tsx`, then `bind` and open the connect URL; shows "waiting for your signature" while
  `pending`). Registered: balances by source (the bound account's first when bound), fund link, shield toggle,
  per-floor "shared company wallet" badge. CEO quest hooks come from brief 05.

## Files you own

`apps/backend/src/domain/walletService.ts` (new), `apps/backend/src/routes/wallet.ts`,
`apps/backend/src/domain/moneyService.ts` (one new pot), the env branch in the `afterProvision` hook
(coordinate with brief 02, which edits the same hook for the market MCP entry: land 02 first, rebase),
`apps/web/src/town/ui/TreasuryCard.tsx` (new).

## Do not touch

`provisioningService.ts`, `hermes/realRuntime.ts`, `schemas.ts`.

## Acceptance

- `wallet.test.ts` with a fake fetch: register stores the key and never returns it from `GET /api/wallet`;
  `bind` with an unlinked account is 409, with a linked one PUTs the binding and `GET /api/wallet` reports
  `pending`, then `active` with a `bound` balance once the fake answers so;
  `call` posts the expected body and returns the tx hash; provisioning a `trading-desk` department writes the three
  env vars to every profile of that department and none to a `software` department, which gets `GH_TOKEN` (assert
  on FakeHermes' recorded `setProfileEnv`).
- Manual, on mainnet with $10: register, set policy, fund, see balance, shield $1, see confidential balance; and
  the other path once: bind to the owner's account, sign at the connect URL, see the bound balance.
