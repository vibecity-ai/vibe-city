//! A Vibe City company's city token: a plain NEP-141 fungible token (near-contract-standards), created by the token
//! factory with the whole supply minted to the owner (the company's Sputnik DAO). It writes NEP-297 events
//! (`ft_mint` at init here, `ft_transfer` inside the standard's transfers), which is how indexers and Trezu learn
//! balances. No owner, no mint after init, no upgrade method: what the factory deploys is all it ever does.
use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, PromiseOrValue};

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
}

#[near]
impl Contract {
    /// Mints `total_supply` to `owner_id`, once.
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128, metadata: FungibleTokenMetadata) -> Self {
        metadata.assert_valid();
        require!(total_supply.0 > 0, "total_supply must be positive");
        let mut token = FungibleToken::new(b"t".to_vec());
        token.internal_register_account(&owner_id);
        token.internal_deposit(&owner_id, total_supply.0);
        FtMint { owner_id: &owner_id, amount: total_supply, memo: Some("city token minted at creation") }.emit();
        Self { token, metadata }
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

    #[test]
    fn new_mints_everything_to_the_owner_and_logs_ft_mint() {
        testing_env!(VMContextBuilder::new().build());
        let owner: AccountId = "acme.sputnik-dao.near".parse().unwrap();
        let c = Contract::new(owner.clone(), U128(1_000_000_000_000), meta());
        assert_eq!(c.ft_balance_of(owner).0, 1_000_000_000_000);
        assert_eq!(c.ft_total_supply().0, 1_000_000_000_000);
        let logs = get_logs();
        assert!(logs.iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"event\":\"ft_mint\"") && l.contains("acme.sputnik-dao.near")), "{logs:?}");
    }
}
