# 06 IPO: Sputnik DAO, the city token, revenue share

**Goal.** The endgame button. When the game loop says `ipoUnlocked`, the CEO presses IPO: the company wallet creates
a Sputnik DAO (the wallet may propose, the CEO approves) and a NEP-141 city token whose whole supply sits in the
DAO. Then the DAO shares revenue with token holders, one CEO-approved payout proposal at a time. The DAO shows up
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
  `create_token { args: { owner_id, total_supply, metadata: { spec: "ft-1.0.0", name, symbol, decimals, icon } } }`
  (200 Tgas). The token account is `<symbol lowercase>.tkn.near`; `get_token({ token_id: <lowercase> })` returns its
  `owner_id`. `owner_id = <dao>` puts the whole supply in the DAO.
- **tkn.near safety.** Its tokens have no access keys and export only NEP-141 methods plus `new` (no mint, upgrade
  or owner method); all recent ones run code `4AVV1KUV…`. The factory itself (code `GqJ8R7fW…`) has one full-access
  key, and **no refund path**: overpayment is kept. So: check the factory's code hash before paying, attach exactly
  `get_required_deposit` (2.2337 NEAR for our args), and after creation check `owner_id`, code hash and zero keys.
  Label: "tkn.near factory token, no keys at check time", never "immutable" or "secure".
- **A 0.09 NEAR DAO cannot pay for anything.** `jvrs4.sputnik-dao.near` (created with 0.09) has
  `get_available_amount` = 0.0035 NEAR. With a zero bond the DAO pays proposal storage and every registration its
  proposals make, so we attach **1 NEAR** to `create` (the factory forwards the deposit to the DAO).
- **DAOs are global contracts now:** `code_hash` is all ones, the real hash is `global_contract_hash`
  (`DtHZA1mU…`). Check a DAO by its policy, not its code hash.
- **Roles, copied from Trezu's DAOs:** Requestor (may only `AddProposal`), Admin and Approver, each kind with
  threshold `"1"`. Ours: Requestor = CEO + company wallet; Admin and Approver = CEO only. The agent wallet proposes,
  one CEO vote passes, and an OutLayer outage cannot lock the DAO that holds the whole supply. (A 2-of-2 council
  would need both votes: `min(1*2/2+1, 2) = 2`, and give the agent wallet a veto.)
- **Approval is in Trezu** (`https://trezu.app/<dao>/requests`, route read from Trezu's bundle). The web app has no
  NEAR wallet connection.
- **No dividends in Sputnik.** Revenue share is a `FunctionCall` proposal on the payout token: per holder a
  `storage_deposit { account_id, registration_only: true }` then an `ft_transfer` (25 Tgas together; at most 8
  holders per proposal inside the approver's 300 Tgas). The batch is atomic, hence the registration in the same
  proposal. The DAO is registered on USDC and wNEAR at IPO so revenue can be sent to it. `add_proposal` attaches
  exactly 0 (bond 0). Token-weighted voting needs the separate staking contract; out of scope.
- NEP-141 has no holder enumeration. Our holders are the accounts the DAO allocated VCT to, which we record.
- Trezu has no API; it lists every `*.sputnik-dao.near`. meme.cooking has no documented contract; not code.
- **Budget:** about 3.3 NEAR (1 DAO, 2.2337 token, 0.025 registrations mostly refunded, gas), mainnet; the
  game asks for 4.

## Who signs

The company OutLayer wallet, through a public `walletService.callContract(receiverId, method, args, gas, deposit)`
over `POST /wallet/v1/call` (brief 03 owns `walletService.ts`: the method is a thin wrapper over its private
`call`). Vibe City never holds the CEO's key. The CEO types their NEAR account in the IPO form (there is no linked
wallet list any more).

## Backend (`domain/ipoService.ts`, `routes/ipo.ts`)

The backend runs the IPO, not the Treasury Ops agent: it is deterministic, testable with a fake caller, and the
trailer does not depend on an LLM getting base64 args right.

- `GET /api/ipo` -> `IpoStateSchema`: `locked` until brief 05 unlocks it, `ready`, `running`, `done`, `error`.
- `POST /api/ipo { ceoAccountId, symbol }` (409 if locked, running or done). Each step reads the chain first, so a
  retry never creates a second DAO or token. A started IPO may resume while locked (it spent the funds that
  unlocked it). The council and the symbol are fixed once they exist on chain.
  1. DAO `<company-slug>.sputnik-dao.near`: `create` with the Trezu-shaped policy, `proposal_bond: "0"`, 1 NEAR,
     300 Tgas. If the account already exists, accept it only if its policy has the CEO as Approver and the wallet as
     Requestor; else 409 (rename the company).
  2. `storage_deposit { account_id: <dao>, registration_only: true }` on USDC and `wrap.near`, unless registered.
  3. Token: check `tkn.near`'s code hash, read `get_required_deposit`, `create_token` with exactly that,
     `<Company> City Token`, the symbol from the form (default from the company name), 1,000,000 supply, 6 decimals,
     `owner_id = <dao>`. If the account already exists, accept it only if `get_token.owner_id == dao`; else 409.
     Then check code hash `4AVV1KUV…` and zero keys; otherwise the IPO is not marked done.
  4. Accounts and tx hashes are stored in `ipo.state_json`.
- `POST /api/ipo/allocate { accountId, amount }`: one DAO proposal on the token (`storage_deposit` + `ft_transfer`).
  The receiver is recorded as a holder. The demo seeds 2 to 3 team-owned accounts this way.
- `POST /api/ipo/dividend { token: USDC | wNEAR, amount }`: checks the DAO holds the amount, reads `ft_balance_of`
  of each recorded holder, splits pro rata over the circulating supply (total minus the DAO's own tokens; shares of
  unknown holders stay in the DAO), and files one proposal with a registration and an `ft_transfer` per holder.
- Revenue reaches the DAO when Treasury Ops sends a cut from the company wallet (its template says how); no new code.

## Web

`IpoCard.tsx`, in the safe (the money screen) under the wallet: the IPO form (CEO account, symbol, the cost in one
line), progress while running, the error and "Retry IPO". After the IPO: DAO and token links (nearblocks), tx links,
"Open in Trezu" and "Approve in Trezu", holders with balances, an Allocate form and a Distribute revenue form, and
the proposals filed. The `ipo` CEO quest points at the safe.

## Game

`DAO_FUND_NEAR` is 4. The `ipo` quest is done when the IPO is done (the old `[dao account=…]` agent marker no longer
counts). `dao-funds` stays done after the IPO spends the funds.

## Honest labels

- "Revenue share by DAO vote". Payouts are proposals the CEO approves in Trezu, not an automatic stream.
- The council governs, not token holders (no staking contract).
- Holders are team-owned demo accounts the DAO allocated tokens to. No sale, no promised returns.
- The token is a "tkn.near factory token, no keys at check time". If the hackathon needs our own contract, deploy it
  once by hand from a full-access key, delete the key, and the rest of the flow is unchanged.

## Cut for the demo

The Tokenomics marker prefill, a "Share revenue" CEO quest, the pre-IPO shield step, token-weighted voting, and
payouts to more than 8 holders.

## Acceptance

- `ipo.test.ts` with a fake chain and wallet: locked -> 409 and no calls; unlocked -> the DAO, registration and
  token calls with the expected args and deposits; a retry after a failure between steps creates no second DAO;
  squatted names and symbols are refused; a changed factory is not paid; the dividend is pro rata, excludes the
  DAO, and is one proposal with a registration and an `ft_transfer` per holder.
- Dry run before the real IPO: one DAO `create` with a throwaway name through the OutLayer wallet (tests that its
  policy allows a deposit and 300 Tgas). Do not dry-run `create_token`: it spends 2.23 NEAR and burns a symbol.
- Manual on mainnet once: DAO in Trezu, the supply on the DAO, one dividend proposal approved and paid.

## Trailer moment

Runway positive, the CEO presses IPO, the city token appears, Trezu shows the DAO. Then the CEO distributes revenue,
approves it in Trezu, and the holders' balances tick up. If this brief slips: the button creates the DAO and the
token, and the first dividend proposal is made by hand in Trezu.
