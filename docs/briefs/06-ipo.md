# 06 IPO: Sputnik DAO, the city token, revenue share

**Goal.** The endgame button. When the game loop says `ipoUnlocked`, the CEO presses IPO: the company wallet creates
a Sputnik DAO (the CEO and the company wallet on the council) and a NEP-141 city token whose whole supply sits in the
DAO. Then the DAO shares revenue with token holders, one council-approved payout proposal at a time. The DAO shows up
in Trezu automatically.

Revised 2026-11-10 after reading mainnet: the old plan (5 to 10 NEAR for the DAO, deploy our own `city-token.wasm`)
was wrong on cost and not possible with the signer we chose.

## Facts (verified on mainnet 2026-11-10, read-only)

- **DAO factory `sputnik-dao.near`** exists (2,116 DAOs). Every recent `create` attached **0.09 NEAR**, 300 Tgas
  (`sponsor.trezu.near` creates DAOs the same way). New DAOs hold about 6 KB of storage, so the deposit is small.
  Args: `{ name, args: base64({ config: { name, purpose, metadata }, policy }) }`. Trezu's own calls pass a full
  policy object (roles, `default_vote_policy`, `proposal_bond: "0"`, `proposal_period`); copy that shape. The short
  form `policy: [accounts]` works too but defaults to a 1 NEAR bond per proposal, so do not use it.
- **The company wallet cannot deploy contracts.** OutLayer's `POST /wallet/v1/call` only calls methods on contracts
  that already exist. So we do not ship our own token wasm.
- **Token factory `tkn.near`** is live. `get_required_deposit` returns 2.23 NEAR for 1,000,000 tokens with 6
  decimals. Recent successful launches, one from an implicit (hex) account like an OutLayer wallet:
  `storage_deposit {}` (0.1 NEAR, 100 Tgas), then
  `create_token { args: { owner_id, total_supply, metadata: { spec: "ft-1.0.0", name, symbol, decimals, icon } } }`
  (about 2.5 NEAR, 200 Tgas). The token account is `<symbol lowercase>.tkn.near`, so the symbol must be free.
  `owner_id = <dao>` puts the whole supply in the DAO.
- **Voting.** With a ratio threshold of 1/2, Sputnik requires more than half the weight. A council of 2 means both
  vote: the company wallet proposes and votes, the CEO approves (Trezu or our UI). The proposer does not vote
  automatically.
- **No dividends in Sputnik.** Revenue share is a `FunctionCall` proposal on the payout token with one `ft_transfer`
  per holder (about 15 Tgas each, so about 15 holders per proposal). Every receiver needs `storage_deposit` on the
  payout token first. Token-weighted voting needs the separate staking contract; out of scope.
- NEP-141 has no holder enumeration. Our holders are the accounts the DAO allocated VCT to, which we record.
- Trezu has no API; it lists every `*.sputnik-dao.near`. meme.cooking has no documented contract; not code.
- **Budget:** about 3 NEAR (0.1 DAO, about 2.5 token, gas), mainnet.

## Who signs

The company OutLayer wallet, through a public `walletService.callContract(receiverId, method, args, gas, deposit)`
over `POST /wallet/v1/call` (brief 03 owns `walletService.ts`: the method is a thin wrapper over its private
`call`). Vibe City never holds the CEO's key. Council = the CEO's primary linked account (`near_wallet`,
`is_primary = 1`) + the OutLayer account.

## Backend (`domain/ipoService.ts`, `routes/ipo.ts`)

The backend runs the IPO, not the Treasury Ops agent: it is deterministic, testable with a fake caller, and the
trailer does not depend on an LLM getting base64 args right.

- `GET /api/ipo` -> `IpoStateSchema` (`locked` until brief 05 says unlocked).
- `POST /api/ipo` (409 if locked or done). Each step checks existence first (`view_account`), so a retry never
  creates a second DAO or token:
  1. `create` on `sputnik-dao.near`, name `<company-slug>`, purpose from the company, full policy with
     `proposal_bond: "0"`, council as above, deposit 0.1 NEAR, 300 Tgas.
  2. `storage_deposit` then `create_token` on `tkn.near`: name `<Company> City Token`, symbol `VCT` (or the
     Tokenomics Analyst marker below; 409 with a clear message if `<symbol>.tkn.near` is taken), supply 1,000,000,
     6 decimals, `owner_id = <dao>`.
  3. Store accounts and tx hashes in `ipo.state_json`; `moneyService.setSettings({ daoAccountId })` so the existing
     treasury mirror shows the DAO.
- Pre-fill symbol and supply from the Token & Treasury floor's `[token symbol=<s> supply=<n>]` marker if present,
  else the defaults. Convenience read, not a dependency.

### Revenue share (after the IPO)

- `POST /api/ipo/allocate { accountId, amount }`: an `add_proposal` with a `FunctionCall` on the VCT token
  (`storage_deposit` for the receiver, then `ft_transfer`). Records the receiver as a holder. The demo seeds 2 to 3
  investor accounts this way.
- `POST /api/ipo/dividend { token, amount }`: reads `ft_balance_of` for each recorded holder, splits `amount` pro
  rata over circulating supply (the DAO's own VCT excluded), and files one `FunctionCall` proposal on the payout
  token with one `ft_transfer` per holder. The CEO approves it; the DAO pays everyone in one transaction.
- Revenue reaches the DAO by Treasury Ops moving a cut of earnings from the company wallet (`ft_transfer` or a NEAR
  transfer). That is an existing wallet call, no new code.

## Web

Executive Office `IpoCard.tsx`: IPO button (disabled with the unlock rule as tooltip while locked), progress steps,
then the DAO account, token account, tx links to a NEAR explorer and a Trezu link. After the IPO: holders with their
VCT, an "Allocate" form and a "Distribute revenue" button, each showing the proposal it filed and a Trezu link to
approve it. Keep the existing treasury card for balances.

Before the IPO button, when IPO is unlocked but the treasury is not yet shielded, show the recommended "Go private
before you go public" step: brief 03's `shield()` (the confidential move onto `intents.far`). Recommended, not a
gate.

## Honest labels

- Label it "revenue share by DAO vote". Payouts are council-approved proposals, not an automatic stream.
- The council governs, not token holders (no staking contract).
- Holders = accounts allocated by the DAO. If VCT trades elsewhere, switch to a holder index (NearBlocks holders API).
- The token is a `tkn.near` factory token, not our own contract. If the hackathon rules require our own contract,
  deploy it once by hand from a full-access key and have the wallet call `new`; the rest of the flow is unchanged.
- No trailer copy that promises returns.

## Files you own

`apps/backend/src/domain/ipoService.ts` + `ipo.test.ts`, `apps/backend/src/routes/ipo.ts`,
`apps/web/src/town/ui/IpoCard.tsx`, the IPO schemas in `packages/shared/src/schemas.ts` (allocate/dividend bodies,
holders on `IpoStateSchema`).

## Changes in other briefs' files (ask the owner, or note it in the PR)

- `walletService.ts` (brief 03): add the public `callContract(...)`.
- `domain/game.ts` (brief 05): `DAO_FUND_NEAR` 6 -> 3; the `ipo` quest is done when the IPO state is `done`, not on
  the agent's `[dao account=...]` marker.
- `packages/shared/src/templates/treasury-ops.ts` (brief 01): drop the "creates the Sputnik DAO vault" line; Treasury
  Ops instead moves revenue into the DAO when asked.

## Do not touch

`walletService.ts` beyond `callContract`, `moneyService.ts` beyond setting `daoAccountId`.

## Acceptance

- `ipo.test.ts` with a fake NEAR caller: locked -> 409; unlocked -> DAO and token calls made with the expected args
  and deposits, state persisted; a retry after a simulated failure between steps creates neither a second DAO nor a
  second token; dividend splits pro rata over recorded holders, excludes the DAO, and builds one proposal with one
  `ft_transfer` per holder.
- Manual dry run before code: from your own account with `near-cli`, one `create` (0.09 NEAR) and one
  `create_token` (about 2.3 NEAR), and one `/wallet/v1/call` with a deposit from the OutLayer wallet, to confirm its
  policy allows deposits to these two contracts.
- Manual on mainnet once: DAO visible in Trezu, VCT supply on the DAO, one dividend proposal approved and paid.

## Trailer moment

Runway positive, three floors lit, the CEO presses IPO, the city token appears on the building, Trezu shows the DAO.
Then an agent proposes "distribute revenue", the CEO approves, and the holders' balances tick up. If this brief
slips: the DAO and token are created by the button, and the first dividend proposal is created by hand in Trezu.
