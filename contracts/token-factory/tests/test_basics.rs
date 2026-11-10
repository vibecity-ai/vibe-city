use near_workspaces::types::NearToken;
use serde_json::json;

fn meta(symbol: &str) -> serde_json::Value {
    json!({ "spec": "ft-1.0.0", "name": format!("{symbol} City Token"), "symbol": symbol, "icon": null, "reference": null, "reference_hash": null, "decimals": 6 })
}
/// 0.001 NEAR per whole token
const PRICE: &str = "1000000000000000000000";

#[tokio::test]
async fn ipo_token_mints_runs_its_offering_and_pays_the_owner() -> Result<(), Box<dyn std::error::Error>> {
    let wasm = near_workspaces::compile_project("./").await?;
    let sandbox = near_workspaces::sandbox().await?;
    let factory = sandbox.dev_deploy(&wasm).await?;
    let payer = sandbox.dev_create_account().await?; // the company wallet
    let dao = sandbox.dev_create_account().await?; // the owner
    let ann = sandbox.dev_create_account().await?;
    let bob = sandbox.dev_create_account().await?;

    let required: NearToken = factory.view("get_required_deposit").args_json(json!({})).await?.json()?;
    assert!(required > NearToken::from_near(1) && required < NearToken::from_near(3), "{required}");

    let before = payer.view_account().await?.balance;
    let out = payer
        .call(factory.id(), "create_token")
        .args_json(json!({ "args": { "owner_id": dao.id(), "total_supply": "1000000000000", "sale_amount": "400000000000", "price": PRICE, "metadata": meta("ACME") } }))
        .deposit(required.saturating_add(NearToken::from_near(1)))
        .max_gas()
        .transact()
        .await?;
    assert!(out.is_success(), "{:#?}", out.failures());
    let mints = out.logs().iter().filter(|l| l.starts_with("EVENT_JSON:") && l.contains("\"ft_mint\"")).count();
    assert_eq!(mints, 2, "the company's shares and the float, both visible to indexers: {:?}", out.logs());
    assert_eq!(out.json::<bool>()?, true);
    let spent = before.saturating_sub(payer.view_account().await?.balance);
    assert!(spent >= required && spent < required.saturating_add(NearToken::from_millinear(100)), "the extra NEAR came back: spent {spent}");

    let token: near_workspaces::AccountId = format!("acme.{}", factory.id()).parse()?;
    let bal = |who: near_workspaces::AccountId| { let (s, t) = (sandbox.clone(), token.clone()); async move { s.view(&t, "ft_balance_of").args_json(json!({ "account_id": who })).await.unwrap().json::<String>().unwrap() } };
    assert_eq!(bal(dao.id().clone()).await, "600000000000");
    assert_eq!(bal(token.clone()).await, "400000000000");
    assert!(sandbox.view_access_keys(&token).await?.is_empty(), "nobody can sign for the token");
    let owner: serde_json::Value = factory.view("get_token").args_json(json!({ "token_id": "acme" })).await?.json()?;
    assert_eq!(owner["owner_id"], dao.id().as_str());

    // Ann buys with 1 NEAR: storage fee kept, ~999 tokens, the cost goes to the DAO, change back
    let dao_before = dao.view_account().await?.balance;
    let buy = ann.call(&token, "buy").args_json(json!({})).deposit(NearToken::from_near(1)).gas(near_workspaces::types::Gas::from_tgas(50)).transact().await?;
    assert!(buy.is_success(), "{:#?}", buy.failures());
    assert!(buy.logs().iter().any(|l| l.contains("\"ft_transfer\"") && l.contains(ann.id().as_str())), "{:?}", buy.logs());
    let units: String = buy.json()?;
    let units: u128 = units.parse()?;
    assert!(units > 990_000_000 && units < 1_000_000_000, "{units}");
    assert_eq!(bal(ann.id().clone()).await, units.to_string());
    let got = dao.view_account().await?.balance.saturating_sub(dao_before);
    let cost = units * 10u128.pow(21) / 1_000_000;
    assert!(got.as_yoctonear() >= cost && got.as_yoctonear() <= cost + 1, "the DAO received the proceeds: {got}");

    // the DAO alone ends the offering; the unsold float returns to it; no more buying
    assert!(bob.call(&token, "end_sale").transact().await?.is_failure());
    let end = dao.call(&token, "end_sale").transact().await?;
    assert!(end.is_success(), "{:#?}", end.failures());
    let info: serde_json::Value = sandbox.view(&token, "sale_info").args_json(json!({})).await?.json()?;
    assert_eq!(info["open"], false);
    assert_eq!(info["buyers"], 1);
    assert_eq!(info["remaining"], "0");
    assert_eq!(bal(dao.id().clone()).await, (1_000_000_000_000u128 - units).to_string());
    assert!(bob.call(&token, "buy").deposit(NearToken::from_near(1)).gas(near_workspaces::types::Gas::from_tgas(50)).transact().await?.is_failure());
    let buyers: Vec<String> = sandbox.view(&token, "get_buyers").args_json(json!({ "from_index": 0, "limit": 10 })).await?.json()?;
    assert_eq!(buyers, vec![ann.id().to_string()]);

    // the same symbol again is refused, and its deposit returns
    let before = payer.view_account().await?.balance;
    let again = payer
        .call(factory.id(), "create_token")
        .args_json(json!({ "args": { "owner_id": bob.id(), "total_supply": "1", "sale_amount": "0", "price": "1", "metadata": meta("acme") } }))
        .deposit(required)
        .max_gas()
        .transact()
        .await?;
    assert!(again.is_failure());
    assert!(before.saturating_sub(payer.view_account().await?.balance) < NearToken::from_millinear(100));
    Ok(())
}
