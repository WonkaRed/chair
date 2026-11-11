//! The transfer burn under a negative rate, against the real wasm.

use sandbox_tests::{TOKEN, ensure_success, events, failure_text, launch};
use serde_json::{Value, json};

const EPOCH_MS: u64 = 90_000;

fn named<'a>(events: &'a [Value], standard: &str, event: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|e| e["standard"] == standard && e["event"] == event)
        .collect()
}

#[tokio::test]
async fn a_transfer_under_a_negative_rate_burns_the_floored_share() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let bob = t.user("bob", 0).await?;
    let supply = t.total_supply().await?;

    // Epoch 0: -50 bps. A whole token burns exactly 0.5%.
    ensure_success(&t.set_policy(&chair, -50).await?)?;
    let result = t.transfer(&t.alice, &bob, 100 * TOKEN).await?;
    ensure_success(&result)?;
    let burned = 100 * TOKEN * 50 / 10_000;
    assert_eq!(t.balance(&bob).await?, 100 * TOKEN - burned);
    assert_eq!(t.balance(&t.alice).await?, supply - 100 * TOKEN);
    assert_eq!(t.total_supply().await?, supply - burned);

    let logged = events(&result);
    assert_eq!(
        named(&logged, "nep141", "ft_transfer")[0]["data"][0]["amount"],
        (100 * TOKEN - burned).to_string()
    );
    let burn_event = named(&logged, "chair", "transfer_burned");
    assert_eq!(
        burn_event[0]["data"],
        json!({ "epoch": 0, "rate_bps": -50, "account_id": t.alice.id(),
                "amount": (100 * TOKEN).to_string(), "burned": burned.to_string() })
    );
    let ft_burn = named(&logged, "nep141", "ft_burn");
    assert_eq!(ft_burn[0]["data"][0]["amount"], burned.to_string());
    assert_eq!(ft_burn[0]["data"][0]["memo"], "chair:tightening");
    assert_eq!(ft_burn[0]["data"][0]["owner_id"], t.alice.id().to_string());

    t.assert_supply_invariant(&[&t.alice, &bob, &chair]).await
}

#[tokio::test]
async fn worked_vector_12345_at_minus_75_burns_92() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let bob = t.user("bob", 0).await?;
    let supply = t.total_supply().await?;

    ensure_success(&t.set_policy(&chair, -50).await?)?;
    t.advance_to_epoch(1).await?;
    ensure_success(&t.set_policy(&chair, -75).await?)?;
    ensure_success(&t.transfer(&t.alice, &bob, 12_345).await?)?;

    // SPEC.md: 12_345 at -75 bps is 92.5875, burned as 92 (rounded down).
    assert_eq!(t.balance(&bob).await?, 12_345 - 92);
    assert_eq!(t.total_supply().await?, supply - 92);
    t.assert_supply_invariant(&[&t.alice, &bob, &chair]).await
}

#[tokio::test]
async fn dust_below_the_rounding_point_burns_nothing_and_logs_no_burn() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let bob = t.user("bob", 0).await?;
    ensure_success(&t.set_policy(&chair, -50).await?)?;

    // At 50 bps the burn is floor(amount / 200): 199 burns nothing, 200 burns 1.
    let dust = t.transfer(&t.alice, &bob, 199).await?;
    ensure_success(&dust)?;
    assert_eq!(t.balance(&bob).await?, 199);
    assert!(named(&events(&dust), "chair", "transfer_burned").is_empty());
    assert!(named(&events(&dust), "nep141", "ft_burn").is_empty());
    ensure_success(&t.transfer(&t.alice, &bob, 200).await?)?;
    assert_eq!(t.balance(&bob).await?, 199 + 199);
    t.assert_supply_invariant(&[&t.alice, &bob, &chair]).await
}

#[tokio::test]
async fn at_zero_and_positive_rates_transfers_are_whole() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let bob = t.user("bob", 0).await?;
    let supply = t.total_supply().await?;

    ensure_success(&t.transfer(&t.alice, &bob, 1_000).await?)?;
    ensure_success(&t.set_policy(&chair, 50).await?)?;
    let result = t.transfer(&t.alice, &bob, 1_000_000).await?;
    ensure_success(&result)?;
    assert_eq!(t.balance(&bob).await?, 1_001_000);
    assert_eq!(
        t.total_supply().await?,
        supply,
        "no stake, so an easing rate mints nothing either"
    );
    assert!(named(&events(&result), "chair", "transfer_burned").is_empty());
    t.assert_supply_invariant(&[&t.alice, &bob, &chair]).await
}

#[tokio::test]
async fn the_burn_ends_when_the_rate_decays_to_zero() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let bob = t.user("bob", 0).await?;
    ensure_success(&t.set_policy(&chair, -50).await?)?;

    // The chair acted in epoch 0, so -50 is in effect through epoch 1 and gone from epoch 2.
    t.advance_to_epoch(1).await?;
    ensure_success(&t.transfer(&t.alice, &bob, 20_000).await?)?;
    assert_eq!(
        t.balance(&bob).await?,
        20_000 - 100,
        "epoch 1 still burns 50 bps"
    );

    t.advance_to_epoch(2).await?;
    ensure_success(&t.transfer(&t.alice, &bob, 20_000).await?)?;
    assert_eq!(
        t.balance(&bob).await?,
        20_000 - 100 + 20_000,
        "epoch 2 burns nothing"
    );
    t.assert_supply_invariant(&[&t.alice, &bob, &chair]).await
}

#[tokio::test]
async fn transfer_call_tells_the_receiver_and_resolves_the_amount_after_the_burn()
-> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    // A plain account has no `ft_on_transfer`, so the call fails and the resolver refunds what arrived.
    let bob = t.user("bob", 0).await?;
    let supply = t.total_supply().await?;
    ensure_success(&t.set_policy(&chair, -50).await?)?;

    let result = t
        .call(
            &t.alice,
            "ft_transfer_call",
            json!({ "receiver_id": bob.id(), "amount": (100 * TOKEN).to_string(), "msg": "" }),
            1,
        )
        .await?;
    ensure_success(&result)?;
    let burned = 100 * TOKEN * 50 / 10_000;
    let logged = events(&result);
    assert_eq!(named(&logged, "chair", "transfer_burned").len(), 1);

    // The refund covers `amount - burn`, not `amount`: the burn is not returned.
    let refunds: Vec<_> = named(&logged, "nep141", "ft_transfer")
        .iter()
        .map(|e| (e["data"][0]["memo"].clone(), e["data"][0]["amount"].clone()))
        .collect();
    assert!(
        refunds.contains(&(json!("refund"), json!((100 * TOKEN - burned).to_string()))),
        "{refunds:?}"
    );
    assert_eq!(t.balance(&bob).await?, 0);
    assert_eq!(t.balance(&t.alice).await?, supply - burned);
    assert_eq!(t.total_supply().await?, supply - burned);
    t.assert_supply_invariant(&[&t.alice, &bob, &chair]).await
}

#[tokio::test]
async fn nep141_transfer_rules_still_hold() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let bob = t.user("bob", 10).await?;
    ensure_success(&t.set_policy(&chair, -50).await?)?;

    let cases = [
        (
            "no deposit",
            t.call(
                &bob,
                "ft_transfer",
                json!({ "receiver_id": t.alice.id(), "amount": "1" }),
                0,
            )
            .await?,
            "Requires attached deposit of exactly 1 yoctoNEAR",
        ),
        (
            "to oneself",
            t.transfer(&bob, &bob, 1).await?,
            "Sender and receiver should be different",
        ),
        (
            "zero",
            t.transfer(&bob, &t.alice, 0).await?,
            "The amount should be a positive number",
        ),
        (
            "more than the balance",
            t.transfer(&bob, &t.alice, 11 * TOKEN).await?,
            "doesn't have enough balance",
        ),
        (
            "call with no deposit",
            t.call(
                &bob,
                "ft_transfer_call",
                json!({ "receiver_id": t.alice.id(), "amount": "1", "msg": "" }),
                0,
            )
            .await?,
            "Requires attached deposit of exactly 1 yoctoNEAR",
        ),
    ];
    for (what, result, expected) in cases {
        assert!(result.is_failure(), "{what} was accepted");
        assert!(
            failure_text(&result).contains(expected),
            "{what}: {}",
            failure_text(&result)
        );
        assert!(
            events(&result).is_empty(),
            "{what}: a refused call must not log events"
        );
    }
    assert_eq!(t.balance(&bob).await?, 10 * TOKEN);
    t.assert_supply_invariant(&[&t.alice, &bob, &chair]).await
}
