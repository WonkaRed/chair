//! The public log of every mint and burn: `get_supply` against the events a log reader would sum.

use near_workspaces::operations::Function;
use near_workspaces::types::{Gas, NearToken};
use sandbox_tests::{INITIAL_SUPPLY, TOKEN, ensure_success, events, launch, mint_of};
use serde::Deserialize;
use serde_json::{Value, json};

const EPOCH_MS: u64 = 120_000;

#[derive(Deserialize, Debug)]
struct Ledger {
    epoch: u64,
    launch_supply: String,
    minted: String,
    burned: String,
    total_supply: String,
    total_staked: String,
    reward_pool: String,
}

fn u(value: &Value) -> u128 {
    value.as_str().unwrap().parse().unwrap()
}

fn sum(log: &[Value], standard: &str, event: &str, field: &str) -> u128 {
    log.iter()
        .filter(|e| e["standard"] == standard && e["event"] == event)
        .map(|e| {
            let data = if standard == "chair" {
                &e["data"]
            } else {
                &e["data"][0]
            };
            u(&data[field])
        })
        .sum()
}

#[tokio::test]
async fn every_mint_and_burn_is_in_the_events_and_adds_up_to_the_ledger_view() -> anyhow::Result<()>
{
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let bob = t.user("bob", 300).await?;
    let carol = t.user("carol", 50).await?;
    let mut log: Vec<Value> = Vec::new();
    let launch_supply: u128 = INITIAL_SUPPLY.parse()?;

    let fresh: Ledger = t.token.view("get_supply").await?.json()?;
    assert_eq!(
        (
            fresh.launch_supply.parse::<u128>()?,
            fresh.minted.as_str(),
            fresh.burned.as_str()
        ),
        (launch_supply, "0", "0")
    );

    // Easing for two epochs, then a pause, then tightening: mints, then burns of every kind.
    ensure_success(&t.stake(&t.alice, 500 * TOKEN).await?)?;
    for (epoch, rate) in [(0, 50), (1, 0), (2, -50)] {
        t.advance_to_epoch(epoch).await?;
        let result = t.set_policy(&chair, rate).await?;
        ensure_success(&result)?;
        log.extend(events(&result));
    }
    let transfer = t.transfer(&t.alice, &bob, 100 * TOKEN).await?;
    ensure_success(&transfer)?;
    log.extend(events(&transfer));
    // A forced close destroys the account's whole balance, and that too is logged.
    let closed = t
        .call(&carol, "storage_unregister", json!({ "force": true }), 1)
        .await?;
    ensure_success(&closed)?;
    log.extend(events(&closed));
    // The next call settles the epochs nobody has touched and logs their mints.
    t.advance_to_epoch(4).await?;
    let flush = t.claim(&t.alice).await?;
    ensure_success(&flush)?;
    log.extend(events(&flush));

    let ledger: Ledger = t.token.view("get_supply").await?.json()?;
    let (minted, burned) = (
        ledger.minted.parse::<u128>()?,
        ledger.burned.parse::<u128>()?,
    );
    assert!(minted > 0, "the easing epochs minted nothing");
    let transfer_burn = 100 * TOKEN * 50 / 10_000;
    assert_eq!(
        burned,
        transfer_burn + 50 * TOKEN,
        "the transfer burn plus carol's closed balance"
    );

    // Every mint and every burn is one event carrying its amount, and they sum to the view.
    assert_eq!(sum(&log, "chair", "epoch_minted", "amount"), minted);
    assert_eq!(sum(&log, "nep141", "ft_mint", "amount"), minted);
    assert_eq!(
        sum(&log, "chair", "transfer_burned", "burned"),
        transfer_burn
    );
    assert_eq!(sum(&log, "nep141", "ft_burn", "amount"), burned);
    for mint in log
        .iter()
        .filter(|e| e["standard"] == "chair" && e["event"] == "epoch_minted")
    {
        assert!(mint["data"]["epoch"].is_u64() && mint["data"]["rate_bps"].as_i64().unwrap() > 0);
    }
    let causes: Vec<&str> = log
        .iter()
        .filter(|e| {
            e["standard"] == "nep141" && (e["event"] == "ft_mint" || e["event"] == "ft_burn")
        })
        .map(|e| e["data"][0]["memo"].as_str().unwrap())
        .collect();
    assert!(causes.contains(&"chair:easing"));
    assert!(causes.contains(&"chair:tightening"));
    assert!(causes.contains(&"storage_unregister"));

    // The ledger's own arithmetic and its agreement with the NEP-141 views.
    assert_eq!(
        ledger.launch_supply.parse::<u128>()? + minted - burned,
        ledger.total_supply.parse::<u128>()?
    );
    assert_eq!(
        t.total_supply().await?,
        ledger.total_supply.parse::<u128>()?
    );
    assert_eq!(ledger.epoch, 4);
    let pool = t.pool().await?;
    assert_eq!(
        (ledger.total_staked, ledger.reward_pool),
        (pool.total_staked, pool.reward_pool)
    );
    t.assert_supply_invariant(&[&t.alice, &bob, &carol, &chair])
        .await
}

#[tokio::test]
async fn a_forced_close_after_a_boundary_cannot_rewrite_that_boundarys_mint() -> anyhow::Result<()>
{
    // The audit's probe p5. Rate +50 a day in epoch 0 on a 1000-token supply is a mint of 1/288 of 0.5% (300 s epochs) at the boundary.
    // The whale that closes its account after the boundary but before anyone rolls the epoch must not
    // halve it: the close rolls first, so the mint is computed on the supply the boundary closed with.
    let t = launch(300_000).await?;
    let chair = t.scoped_chair().await?;
    ensure_success(&t.stake(&t.alice, 500 * TOKEN).await?)?;
    ensure_success(&t.set_policy(&chair, 50).await?)?;
    t.advance_to_epoch(1).await?;
    let projected: Ledger = t.token.view("get_supply").await?.json()?;
    let mint = mint_of(1000 * TOKEN, 50, 300_000);
    assert_eq!(projected.minted.parse::<u128>()?, mint);

    // Alice holds 500 liquid tokens: a whale relative to the 500 staked.
    let closed = t
        .call(&t.alice, "storage_unregister", json!({ "force": true }), 1)
        .await?;
    ensure_success(&closed)?;
    let logged = events(&closed);
    assert_eq!(sum(&logged, "chair", "epoch_minted", "amount"), mint);
    let after: Ledger = t.token.view("get_supply").await?.json()?;
    assert_eq!(after.epoch, 1, "the scenario must stay in epoch 1");
    assert_eq!(
        (after.minted.parse::<u128>()?, after.burned.parse::<u128>()?),
        (mint, 500 * TOKEN)
    );
    assert_eq!(after.reward_pool.parse::<u128>()?, mint);
    t.assert_supply_invariant(&[&chair]).await
}

#[tokio::test]
async fn a_refund_to_a_sender_that_closed_its_account_is_burned_and_counted() -> anyhow::Result<()>
{
    // The audit's probe p6. One transaction sends tokens with `ft_transfer_call` to an account that cannot
    // take them (no contract, so the call fails and everything is refundable) and force-closes the sender
    // before the resolver runs. The refund has nowhere to go and is burned; the ledger must say so.
    let t = launch(300_000).await?;
    let sender = t.user("sender", 10).await?;
    let receiver = t.user("receiver", 0).await?;
    let one_yocto = NearToken::from_yoctonear(1);
    let batch = sender
        .batch(t.token.id())
        .call(
            Function::new("ft_transfer_call")
                .args_json(json!({
                    "receiver_id": receiver.id(), "amount": (10 * TOKEN).to_string(), "msg": "",
                }))
                .deposit(one_yocto)
                .gas(Gas::from_tgas(100)),
        )
        .call(
            Function::new("storage_unregister")
                .args_json(json!({ "force": true }))
                .deposit(one_yocto)
                .gas(Gas::from_tgas(30)),
        )
        .transact()
        .await?;
    assert!(
        batch.logs().iter().any(|l| l.contains("burned")),
        "the resolver logged no burn: {:?}",
        batch.logs()
    );
    // The substring above also matches the contract's own `log!`; this is the NEP-141 event itself.
    let refund_burns: Vec<Value> = events(&batch)
        .into_iter()
        .filter(|e| {
            e["standard"] == "nep141" && e["event"] == "ft_burn" && e["data"][0]["memo"] == "refund"
        })
        .collect();
    assert_eq!(refund_burns.len(), 1, "expected one refund ft_burn: {refund_burns:?}");
    assert_eq!(refund_burns[0]["data"][0]["owner_id"], receiver.id().as_str());
    assert_eq!(refund_burns[0]["data"][0]["amount"], (10 * TOKEN).to_string());

    let ledger: Ledger = t.token.view("get_supply").await?.json()?;
    assert_eq!(ledger.burned.parse::<u128>()?, 10 * TOKEN);
    assert_eq!(ledger.total_supply.parse::<u128>()?, 990 * TOKEN);
    assert_eq!(t.balance(&receiver).await?, 0);
    t.assert_supply_invariant(&[&t.alice, &receiver]).await
}
