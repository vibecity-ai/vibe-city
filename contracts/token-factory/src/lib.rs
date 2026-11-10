//! Vibe City's token factory. `create_token` makes `<symbol>.<factory>` a city token (contracts/city-token, embedded
//! below) with the whole supply minted to `owner_id`, in one receipt: create account, fund its storage, deploy, `new`.
//! That receipt either all happens or none of it does; the callback then refunds what was attached beyond the cost,
//! or everything on failure. Tokens get no access key, and the factory has no admin method: deployed with its own
//! key deleted, nobody can change what it does. Its interface mirrors tkn.near's (create_token { args },
//! get_required_deposit, get_token) so callers switch by account id.
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise};

const TOKEN_CODE: &[u8] = include_bytes!("../../res/city_token.wasm");
/// Bytes a new token needs besides its code: the account, the token's state (metadata, the owner's balance), and the
/// factory's own record of the token.
const STATE_BYTES: u128 = 2_000;
const NEW_GAS: Gas = Gas::from_tgas(20);
const CALLBACK_GAS: Gas = Gas::from_tgas(15);

/// NEP-148 metadata, passed through to the token (which checks it again with near-contract-standards).
#[near(serializers = [json])]
pub struct Metadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}

/// What `new` on the token receives.
#[near(serializers = [json])]
pub struct TokenArgs {
    pub owner_id: AccountId,
    pub total_supply: U128,
    pub metadata: Metadata,
}

#[near(serializers = [json])]
pub struct TokenView {
    pub owner_id: AccountId,
}

#[near(contract_state)]
pub struct Factory {
    /// token id (the lowercase symbol, the token's sub-account name) -> owner the supply was minted to
    tokens: LookupMap<String, AccountId>,
}

impl Default for Factory {
    fn default() -> Self {
        Self { tokens: LookupMap::new(b"t") }
    }
}

/// 2 to 16 lowercase letters or digits, starting with a letter: a valid sub-account name.
fn valid_id(id: &str) -> bool {
    (2..=16).contains(&id.len()) && id.starts_with(|c: char| c.is_ascii_lowercase()) && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

#[near]
impl Factory {
    /// The exact deposit `create_token` needs: the token's code and state at the protocol's storage price.
    pub fn get_required_deposit(&self) -> NearToken {
        env::storage_byte_cost().saturating_mul(TOKEN_CODE.len() as u128 + STATE_BYTES)
    }

    pub fn get_token(&self, token_id: String) -> Option<TokenView> {
        self.tokens.get(&token_id).map(|owner_id| TokenView { owner_id: owner_id.clone() })
    }

    #[payable]
    pub fn create_token(&mut self, args: TokenArgs) -> Promise {
        let id = args.metadata.symbol.to_ascii_lowercase();
        require!(valid_id(&id), "The symbol must be 2 to 16 letters or digits, starting with a letter");
        require!(self.tokens.get(&id).is_none(), "This symbol is taken");
        require!(args.metadata.spec == "ft-1.0.0" && !args.metadata.name.is_empty(), "Metadata needs spec ft-1.0.0 and a name");
        require!(args.metadata.reference.is_none() == args.metadata.reference_hash.is_none(), "reference and reference_hash go together");
        require!(args.total_supply.0 > 0, "total_supply must be positive");
        let required = self.get_required_deposit();
        let attached = env::attached_deposit();
        require!(attached >= required, format!("Attach at least {} yoctoNEAR", required.as_yoctonear()));

        // recorded now so a second call for the same symbol is refused while this one is in flight
        self.tokens.insert(id.clone(), args.owner_id.clone());
        let token: AccountId = format!("{id}.{}", env::current_account_id()).parse().unwrap();
        Promise::new(token)
            .create_account()
            .transfer(required)
            .deploy_contract(TOKEN_CODE.to_vec())
            .function_call("new".to_string(), near_sdk::serde_json::to_vec(&args).unwrap(), NearToken::from_yoctonear(0), NEW_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_create(id, env::predecessor_account_id(), attached, required))
    }

    /// Refunds the caller: what exceeded the cost, or all of it if the token was not created (that receipt's transfer
    /// comes back to the factory). ponytail: the factory fronts that refund from its own balance until the failed
    /// transfer returns, so it keeps one token's cost spare.
    #[private]
    pub fn on_create(&mut self, id: String, payer: AccountId, attached: NearToken, required: NearToken) -> bool {
        let ok = env::promise_result_checked(0, 0).is_ok(); // `new` returns nothing
        if !ok {
            self.tokens.remove(&id);
        }
        let refund = if ok { attached.saturating_sub(required) } else { attached };
        if !refund.is_zero() {
            Promise::new(payer).transfer(refund).detach();
        }
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_ids_are_sub_account_names() {
        assert!(valid_id("vibing"));
        assert!(valid_id("a1"));
        assert!(!valid_id("a"));
        assert!(!valid_id("1abc"));
        assert!(!valid_id("ab-c"));
        assert!(!valid_id("abcdefghijklmnopq"));
    }
}
