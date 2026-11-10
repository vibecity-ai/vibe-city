use near_workspaces::types::NearToken;
use serde_json::json;

fn meta(symbol: &str) -> serde_json::Value {
    json!({ "spec": "ft-1.0.0", "name": format!("{symbol} City Token"), "symbol": symbol, "icon": null, "reference": null, "reference_hash": null, "decimals": 6 })
}

#[tokio::test]
async fn creates_a_visible_token_owned_by_the_owner_and_refunds_the_rest() -> Result<(), Box<dyn std::error::Error>> {
    let wasm = near_workspaces::compile_project("./").await?;
    let sandbox = near_workspaces::sandbox().await?;
    let factory = sandbox.dev_deploy(&wasm).await?;
    let payer = sandbox.dev_create_account().await?; // the company wallet
    let dao = sandbox.dev_create_account().await?; // the owner
    let carol = sandbox.dev_create_account().await?;

    let required: NearToken = factory.view("get_required_deposit").args_json(json!({})).await?.json()?;
    assert!(required > NearToken::from_near(1) && required < NearToken::from_near(3), "{required}");

    let before = payer.view_account().await?.balance;
    let out = payer
        .call(factory.id(), "create_token")
        .args_json(json!({ "args": { "owner_id": dao.id(), "total_supply": "1000000000000", "metadata": meta("ACME") } }))
        .deposit(required.saturating_add(NearToken::from_near(1)))
        .max_gas()
        .transact()
        .await?;
    assert!(out.is_success(), "{:#?}", out.failures());
    // indexers and Trezu learn the balance from this event
    assert!(out.logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"ft_mint\"") && l.contains(dao.id().as_str())), "{:?}", out.logs());
    assert_eq!(out.json::<bool>()?, true);
    let spent = before.saturating_sub(payer.view_account().await?.balance);
    assert!(spent >= required && spent < required.saturating_add(NearToken::from_millinear(100)), "the extra NEAR came back: spent {spent}");

    let token: near_workspaces::AccountId = format!("acme.{}", factory.id()).parse()?;
    let bal: String = sandbox.view(&token, "ft_balance_of").args_json(json!({ "account_id": dao.id() })).await?.json()?;
    assert_eq!(bal, "1000000000000");
    let owner: serde_json::Value = factory.view("get_token").args_json(json!({ "token_id": "acme" })).await?.json()?;
    assert_eq!(owner["owner_id"], dao.id().as_str());
    assert!(sandbox.view_access_keys(&token).await?.is_empty(), "nobody can sign for the token");

    // transfers write ft_transfer events
    let reg = carol.call(&token, "storage_deposit").args_json(json!({})).deposit(NearToken::from_millinear(13)).transact().await?;
    assert!(reg.is_success(), "{:#?}", reg.failures());
    let tx = dao.call(&token, "ft_transfer").args_json(json!({ "receiver_id": carol.id(), "amount": "5000000" })).deposit(NearToken::from_yoctonear(1)).transact().await?;
    assert!(tx.is_success(), "{:#?}", tx.failures());
    assert!(tx.logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"ft_transfer\"")), "{:?}", tx.logs());

    // the same symbol again is refused, and its deposit returns
    let before = payer.view_account().await?.balance;
    let again = payer
        .call(factory.id(), "create_token")
        .args_json(json!({ "args": { "owner_id": carol.id(), "total_supply": "1", "metadata": meta("acme") } }))
        .deposit(required)
        .max_gas()
        .transact()
        .await?;
    assert!(again.is_failure());
    let spent = before.saturating_sub(payer.view_account().await?.balance);
    assert!(spent < NearToken::from_millinear(100), "spent {spent}");

    // too little deposit is refused
    let short = payer
        .call(factory.id(), "create_token")
        .args_json(json!({ "args": { "owner_id": dao.id(), "total_supply": "1", "metadata": meta("CHEAP") } }))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?;
    assert!(short.is_failure());
    Ok(())
}
