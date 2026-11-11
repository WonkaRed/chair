//! What the contract demands of the chair, and what it does when the chair says nothing at all.

use sandbox_tests::{Chair, TOKEN, ensure_success, events, failure_text, launch};
use serde_json::{Value, json};

/// Long enough that a scenario's transactions never straddle a boundary by accident, even on a loaded
/// machine: the sandbox clock keeps running in real time between the calls a test makes.
const EPOCH_MS: u64 = 300_000;

async fn set_policy_with_hash(
    t: &Chair,
    chair: &near_workspaces::Account,
    rate_bps: i32,
    hash: &str,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(chair
        .call(t.token.id(), "set_policy")
        .args_json(json!({ "rate_bps": rate_bps, "reasoning_hash": hash }))
        .transact()
        .await?)
}

fn named<'a>(events: &'a [Value], event: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|e| e["standard"] == "chair" && e["event"] == event)
        .collect()
}

#[tokio::test]
async fn reasoning_hash_must_be_a_lowercase_sha256_hex_digest() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let valid = "0123456789abcdef".repeat(4);

    let refused = [
        ("empty", String::new()),
        ("63 characters", valid[..63].to_string()),
        ("65 characters", format!("{valid}0")),
        ("128 characters, once allowed", "ab".repeat(64)),
        ("uppercase", valid.to_uppercase()),
        ("a non-hex letter", format!("g{}", &valid[1..])),
        ("a 0x prefix", format!("0x{}", &valid[2..])),
        ("a trailing newline", format!("{}\n", &valid[1..])),
    ];
    for (what, hash) in refused {
        let result = set_policy_with_hash(&t, &chair, 50, &hash).await?;
        assert!(
            failure_text(&result).contains("reasoning_hash must be a SHA-256 digest"),
            "{what}: {}",
            failure_text(&result)
        );
        assert!(
            events(&result).is_empty(),
            "{what}: a refused call logged events"
        );
    }
    assert_eq!(
        t.policy().await?.last_set_epoch,
        None,
        "nothing was recorded"
    );

    let accepted = set_policy_with_hash(&t, &chair, 50, &valid).await?;
    ensure_success(&accepted)?;
    assert_eq!(
        named(&events(&accepted), "policy_set")[0]["data"]["reasoning_hash"],
        valid
    );
    assert_eq!(t.policy().await?.rate_bps, 50);
    Ok(())
}

#[tokio::test]
async fn a_silent_chair_cannot_stall_the_token_the_rate_decays_to_zero_by_contract_code()
-> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let bob = t.user("bob", 100).await?;
    ensure_success(&t.stake(&t.alice, 500 * TOKEN).await?)?;

    // The chair climbs to the ceiling, one step per epoch, and then falls silent.
    for (epoch, rate) in [(0, 50), (1, 100), (2, 150), (3, 200)] {
        t.advance_to_epoch(epoch).await?;
        ensure_success(&t.set_policy(&chair, rate).await?)?;
    }

    // From here nothing sends a transaction: the rate every view reports is the contract's own
    // rule, 50 bps closer to zero for each epoch without a decision, and it stops at zero.
    for epoch in 4..=10 {
        let policy = t.advance_to_epoch(epoch).await?;
        assert!(policy.epoch >= epoch);
        // Epoch 4 still has the last decision's 200; then 50 bps less per silent epoch, never below 0.
        let expected = (200 - 50 * (policy.epoch as i32 - 4)).max(0);
        assert_eq!(policy.rate_bps, expected, "epoch {}", policy.epoch);
        assert_eq!(
            policy.last_set_epoch,
            Some(3),
            "the chair really said nothing"
        );
        assert_eq!(
            policy.chair,
            chair.id().as_str(),
            "silence does not unseat the chair"
        );
    }

    // The first transaction after the silence applies all of it, in order, and the token works.
    let supply_before = t.total_supply().await?;
    let result = t.claim(&t.alice).await?;
    ensure_success(&result)?;
    let logged = events(&result);
    let decays: Vec<(u64, i64)> = named(&logged, "rate_decayed")
        .iter()
        .map(|e| {
            (
                e["data"]["epoch"].as_u64().unwrap(),
                e["data"]["rate_bps"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(decays, [(4, 150), (5, 100), (6, 50), (7, 0)]);
    assert_eq!(
        t.total_supply().await?,
        supply_before,
        "views already counted those mints"
    );
    assert_eq!(t.policy().await?.rate_bps, 0);

    ensure_success(&t.transfer(&t.alice, &bob, 10 * TOKEN).await?)?;
    assert_eq!(
        t.balance(&bob).await?,
        110 * TOKEN,
        "no burn, no fee at the fallback rate"
    );
    ensure_success(&t.stake(&bob, 10 * TOKEN).await?)?;
    let settled = t.total_supply().await?;
    t.advance_to_epoch(12).await?;
    assert_eq!(
        t.total_supply().await?,
        settled,
        "at the fallback rate nothing is minted"
    );

    // And the chair, once it speaks again, is heard.
    ensure_success(&t.set_policy(&chair, -50).await?)?;
    assert_eq!(t.policy().await?.rate_bps, -50);
    t.assert_supply_invariant(&[&t.alice, &bob, &chair]).await
}
