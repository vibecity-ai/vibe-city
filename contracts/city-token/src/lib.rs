//! A Vibe City company's city token: a NEP-141 fungible token (near-contract-standards), created by the token factory,
//! that runs the company's public offering itself. At init it mints `total_supply - sale_amount` to the owner (the
//! company's Sputnik DAO) and `sale_amount` (the public float) to its own account. Anyone may `buy` from the float at
//! the fixed `price` (yoctoNEAR per whole token): the NEAR goes to the owner, change comes back. The owner may
//! `end_sale`, which returns the unsold float to it. Every mint and move writes NEP-297 events (`ft_mint`,
//! `ft_transfer`), so indexers and wallets see balances. No later mint, no upgrade method.
use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::store::IterableSet;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise, PromiseOrValue};

/// Storage a new buyer adds besides its token account (its entry in `buyers`), paid from its first purchase.
const BUYER_BYTES: u128 = 200;

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
    /// receives the proceeds and may end the offering (the company's DAO)
    owner_id: AccountId,
    /// yoctoNEAR per whole token (10^decimals units)
    price: u128,
    open: bool,
    sold: u128,
    raised: u128,
    buyers: IterableSet<AccountId>,
}

#[near(serializers = [json])]
pub struct SaleInfo {
    pub owner_id: AccountId,
    pub price: U128,
    pub sold: U128,
    pub remaining: U128,
    pub raised: U128,
    pub buyers: u32,
    pub open: bool,
}

/// Units `available` yoctoNEAR buys at `price` per whole token (`unit` = 10^decimals), capped at `remaining`, and
/// their cost rounded up (never more than `available`).
pub fn quote(available: u128, price: u128, unit: u128, remaining: u128) -> (u128, u128) {
    let units = available.checked_mul(unit).map(|x| x / price).unwrap_or_else(|| env::panic_str("amount too large")).min(remaining);
    let cost = (units * price).div_ceil(unit);
    (units, cost)
}

#[near]
impl Contract {
    /// Mints `total_supply - sale_amount` to `owner_id` and `sale_amount` to the offering (this account), once.
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128, sale_amount: U128, price: U128, metadata: FungibleTokenMetadata) -> Self {
        metadata.assert_valid();
        require!(metadata.decimals <= 12, "decimals above 12 are not supported");
        require!(total_supply.0 > 0 && sale_amount.0 <= total_supply.0, "need 0 <= sale_amount <= total_supply, total_supply > 0");
        require!(price.0 > 0, "price must be positive");
        let me = env::current_account_id();
        require!(owner_id != me, "the owner cannot be the token itself");
        let mut token = FungibleToken::new(b"t".to_vec());
        let kept = total_supply.0 - sale_amount.0;
        token.internal_register_account(&owner_id);
        token.internal_register_account(&me);
        if kept > 0 {
            token.internal_deposit(&owner_id, kept);
            FtMint { owner_id: &owner_id, amount: U128(kept), memo: Some("company shares") }.emit();
        }
        if sale_amount.0 > 0 {
            token.internal_deposit(&me, sale_amount.0);
            FtMint { owner_id: &me, amount: sale_amount, memo: Some("public offering float") }.emit();
        }
        Self { token, metadata, owner_id, price: price.0, open: sale_amount.0 > 0, sold: 0, raised: 0, buyers: IterableSet::new(b"b".to_vec()) }
    }

    /// Buys from the float with the attached NEAR. A first purchase keeps the buyer's registration and storage fee.
    /// The cost goes to the owner, the change back to the buyer. Returns the units bought.
    #[payable]
    pub fn buy(&mut self) -> U128 {
        require!(self.open, "The offering is closed");
        let buyer = env::predecessor_account_id();
        let me = env::current_account_id();
        let mut available = env::attached_deposit().as_yoctonear();
        // a buyer pays for the storage it adds: its token account (unless registered) and its entry in `buyers`
        let registered = self.token.accounts.contains_key(&buyer);
        let mut fee = 0;
        if !registered {
            fee += self.token.storage_balance_bounds().min.as_yoctonear();
        }
        if !self.buyers.contains(&buyer) {
            fee += env::storage_byte_cost().as_yoctonear() * BUYER_BYTES;
        }
        require!(available > fee, format!("Attach more than {fee} yoctoNEAR: a first purchase pays the buyer's storage"));
        available -= fee;
        if !registered {
            self.token.internal_register_account(&buyer);
        }
        let remaining = self.token.internal_unwrap_balance_of(&me);
        let (units, cost) = quote(available, self.price, 10u128.pow(self.metadata.decimals as u32), remaining);
        require!(units > 0, "Attach enough NEAR for at least one unit of the token");
        self.token.internal_transfer(&me, &buyer, units, Some("IPO purchase".to_string()));
        self.sold += units;
        self.raised += cost;
        self.buyers.insert(buyer.clone());
        if units == remaining {
            self.open = false;
        }
        Promise::new(self.owner_id.clone()).transfer(NearToken::from_yoctonear(cost)).detach();
        if available > cost {
            Promise::new(buyer).transfer(NearToken::from_yoctonear(available - cost)).detach();
        }
        U128(units)
    }

    /// The owner closes the offering; the unsold float returns to it.
    pub fn end_sale(&mut self) {
        require!(env::predecessor_account_id() == self.owner_id, "Only the owner can end the offering");
        let me = env::current_account_id();
        let remaining = self.token.internal_unwrap_balance_of(&me);
        if remaining > 0 {
            self.token.internal_transfer(&me, &self.owner_id.clone(), remaining, Some("unsold offering float".to_string()));
        }
        self.open = false;
    }

    pub fn sale_info(&self) -> SaleInfo {
        SaleInfo {
            owner_id: self.owner_id.clone(),
            price: U128(self.price),
            sold: U128(self.sold),
            remaining: U128(self.token.internal_unwrap_balance_of(&env::current_account_id())),
            raised: U128(self.raised),
            buyers: self.buyers.len(),
            open: self.open,
        }
    }

    pub fn get_buyers(&self, from_index: u32, limit: u32) -> Vec<AccountId> {
        self.buyers.iter().skip(from_index as usize).take(limit as usize).cloned().collect()
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        // the standard writes the ft_burn / refund ft_transfer events itself
        self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount).0.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_contract_standards::fungible_token::metadata::FT_METADATA_SPEC;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn meta() -> FungibleTokenMetadata {
        FungibleTokenMetadata { spec: FT_METADATA_SPEC.into(), name: "Acme City Token".into(), symbol: "ACME".into(), icon: None, reference: None, reference_hash: None, decimals: 6 }
    }
    fn acc(s: &str) -> AccountId { s.parse().unwrap() }

    #[test]
    fn new_splits_the_supply_and_logs_both_mints() {
        testing_env!(VMContextBuilder::new().current_account_id(acc("acme.tokens.near")).build());
        let c = Contract::new(acc("acme.sputnik-dao.near"), U128(1_000_000_000_000), U128(400_000_000_000), U128(10u128.pow(21)), meta());
        assert_eq!(c.ft_balance_of(acc("acme.sputnik-dao.near")).0, 600_000_000_000);
        assert_eq!(c.ft_balance_of(acc("acme.tokens.near")).0, 400_000_000_000);
        assert!(c.sale_info().open);
        let mints = get_logs().iter().filter(|l| l.starts_with("EVENT_JSON:") && l.contains("\"ft_mint\"")).count();
        assert_eq!(mints, 2);
    }

    #[test]
    fn quote_rounds_units_down_and_cost_up_within_what_was_attached() {
        // 0.001 NEAR per whole token, 6 decimals
        let (price, unit) = (10u128.pow(21), 1_000_000);
        assert_eq!(quote(10u128.pow(24), price, unit, u128::MAX), (1_000_000_000, 10u128.pow(24)), "1 NEAR buys 1000 tokens");
        let (u, c) = quote(10u128.pow(21) + 7, price, unit, u128::MAX);
        assert_eq!(u, 1_000_000);
        assert!(c <= 10u128.pow(21) + 7);
        assert_eq!(quote(10u128.pow(24), price, unit, 5), (5, 5_000_000_000_000_000), "capped at the float");
        assert_eq!(quote(10, price, unit, u128::MAX).0, 0);
    }
}
