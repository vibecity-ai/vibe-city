# Contracts

The IPO's city token comes from our own factory (docs/briefs/06-ipo.md). `tkn.near` tokens write no NEP-297 events,
so indexers and Trezu never see their balances; ours do.

- `city-token/`: a NEP-141 token (near-contract-standards) that runs the IPO offering. `new(owner_id, total_supply,
  sale_amount, price, metadata)` mints `total_supply - sale_amount` to the owner and the float to itself (`ft_mint`
  each). `buy()` (payable) sells from the float at `price` yoctoNEAR per whole token, sends the NEAR to the owner,
  refunds change, and keeps the storage a new buyer adds. `end_sale()` (owner only) returns the unsold float.
  Views: `sale_info`, `get_buyers`. No later mint, no upgrade.
- `token-factory/`: `create_token({ args: { owner_id, total_supply, metadata } })` makes `<symbol>.<factory>` in one
  all-or-nothing receipt and refunds the excess (all of it on failure). `get_required_deposit()`, `get_token(token_id)`.
  No admin method; deployed with its key deleted.
- `res/`: the built wasm files the factory embeds and the backend checks (`TOKEN_HASH`, `TOKEN_FACTORY_HASH` in
  `apps/backend/src/domain/ipoService.ts`: base58 sha256 of these files).

```
cd city-token && cargo test && cargo near build non-reproducible-wasm && cp target/near/city_token.wasm ../res/
cd ../token-factory && cargo test && cargo near build non-reproducible-wasm && cp target/near/token_factory.wasm ../res/
```

`cargo test` in `token-factory` runs a NEAR sandbox (downloads it once): it creates a token and checks the `ft_mint`
and `ft_transfer` events, the supply on the owner, no access keys, the refund, and a refused duplicate. Built with
cargo-near 0.17.0 and Rust 1.86 (`rust-toolchain.toml`); not part of `npm test`.

Deploy (mainnet): the factory holds its code (3.67 NEAR) plus one token's cost spare (2.23 NEAR), which it fronts as
a refund if a creation fails. To update a deployed factory whose key still exists, top it up and deploy again (its
state, the token records, is unchanged).

```
near account create-account fund-myself tokens.vibecity.near '5.3 NEAR' autogenerate-new-keypair save-to-keychain sign-as vibecity.near network-config mainnet sign-with-keychain send
near contract deploy tokens.vibecity.near use-file contracts/res/token_factory.wasm without-init-call network-config mainnet sign-with-keychain send
# update: near tokens vibecity.near send-near tokens.vibecity.near '1 NEAR' network-config mainnet sign-with-keychain send, then deploy again
# after the first token shows in Trezu: delete the factory's only key, so nobody can change it
near account list-keys tokens.vibecity.near network-config mainnet now
near account delete-keys tokens.vibecity.near public-keys <ed25519:...> network-config mainnet sign-with-keychain send
```
