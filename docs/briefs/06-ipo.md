# 06 IPO: Sputnik DAO and the city token

**Goal.** The endgame button. When the game loop says `ipoUnlocked`, the CEO presses IPO: Vibe City creates a
Sputnik DAO with the company's NEAR account on the council and deploys a NEP-141 "city token" (our own contract
on NEAR, which the hackathon rules say is enough). The DAO shows up in Trezu automatically.

## Facts

- Sputnik DAO v2 (`github.com/near-daos/sputnik-dao-contract`): `create` on the factory with
  `{ name, args: base64({ config: { name, purpose, metadata }, policy: [council accounts] }) }`, attach about 5 to
  10 NEAR and 150 Tgas. Proposals: `add_proposal` (1 NEAR bond), `act_proposal`, views `get_policy`,
  `get_proposals`. **The mainnet factory account is not in the docs we read** (`sputnik-v2.testnet` is the
  example); confirm it with `near view` before spending, expected `sputnik-dao.near`.
- Trezu has no API; it lists existing `.sputnik-dao.near` DAOs, so ours appears for free. NEAR Business is UI only.
- meme.cooking has no documented contract or API; a token launch there is a manual step in the trailer, not code.
- We go **mainnet, small amounts**: about 10 NEAR total.

## Who signs

Vibe City never holds the company's main NEAR key. Two options; pick the first unless it fails on mainnet:

1. **OutLayer wallet signs.** The company custody wallet (brief 03) can call contracts: `POST /wallet/v1/call`
   (`agent-custody/references/wallet-ops.md`). The DAO's council is the user's own account (from `near_wallet`,
   already linked) plus the OutLayer account. Fund the OutLayer wallet with the NEAR first.
2. **Browser wallet signs.** Build the two transactions server-side and return them for the already-integrated
   wallet selector to sign (`apps/web` has `@hot-labs/near-connect`). More UI, no custody.

## Backend (`domain/ipoService.ts`, `routes/ipo.ts`)

- `GET /api/ipo` -> `IpoStateSchema` (`locked` until brief 05 says unlocked).
- `POST /api/ipo` (409 if locked or already done): 1) `create` DAO named `<company-slug>` with purpose from the
  company; 2) deploy the NEP-141 token to a sub-account of the OutLayer account (`token.<account>`), name
  `<Company> City Token`, symbol `VCT`, total supply 1,000,000 with 6 decimals, minted to the DAO; 3) store
  accounts and tx hashes in `ipo.state_json`; 4) `MoneySettings.daoAccountId` is set so the existing treasury
  mirror (`MoneyService`) shows the DAO. Each step is idempotent on retry (check existence before creating).
- The token contract: use the reference `near-examples` FT (`fungible-token` in Rust) compiled once and committed
  as `contracts/city-token.wasm` with its source and build command. Do not write a new token contract.

## Web

Executive Office: IPO button (disabled with the unlock rule as tooltip while locked), progress steps, then the DAO
account, token account, tx links to a NEAR explorer, and a Trezu link. Keep the existing treasury card for balances.

## Files you own

`apps/backend/src/domain/ipoService.ts` + test, `apps/backend/src/routes/ipo.ts`, `contracts/` (new),
`apps/web/src/town/ui/IpoCard.tsx`.

## Do not touch

`walletService.ts` internals (call its `call(...)` method; if it lacks one, ask brief 03's owner to add it),
`moneyService.ts` beyond setting `daoAccountId`.

## Acceptance

- `ipo.test.ts` with a fake NEAR caller: locked -> 409; unlocked -> both calls made with the expected args, state
  persisted, a retry after a simulated failure between steps does not create a second DAO.
- Manual on mainnet once, with the 10 NEAR: DAO visible in Trezu, token balance on the DAO.

## Trailer moment

Runway positive, three floors lit, the CEO presses IPO, the city token appears on the building, Trezu shows the
DAO. If this brief slips, the trailer shows the DAO created manually from the user's wallet and the button
becomes a link; the plan says the IPO button is the second thing to drop after the config-only departments.
