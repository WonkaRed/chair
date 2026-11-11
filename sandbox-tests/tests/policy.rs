//! `set_policy` against the real contract wasm in a local NEAR sandbox.
//! Each test launches its own token and acts as the chair through a function-call key scoped to
//! `set_policy`, the way the chair runs in production.

use near_workspaces::types::Gas;
use sandbox_tests::{EPOCH_MS, events, failure_text, launch};
use serde_json::json;

#[tokio::test]
async fn chair_can_set_an_in_bounds_rate() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;

    let result = t.set_policy(&chair, 40).await?;
    assert!(result.is_success(), "{}", failure_text(&result));

    let policy = t.policy().await?;
    assert_eq!(
        (policy.rate_bps, policy.epoch, policy.last_set_epoch),
        (40, 0, Some(0))
    );
    assert_eq!(policy.chair, chair.id().to_string());

    let events = events(&result);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["standard"], "chair");
    assert_eq!(events[0]["event"], "policy_set");
    assert_eq!(
        events[0]["data"],
        json!({
            "chair": chair.id(), "epoch": 0, "rate_bps": 40, "previous_rate_bps": 0,
            "reasoning_hash": "ab".repeat(32),
        })
    );
    Ok(())
}

/// The chair publishes its reasoning text as an extra `reasoning` argument of `set_policy`. The method does not
/// declare it and near-sdk ignores JSON fields a method does not declare, so the same hash is stored and logged
/// and the call burns under half of the 30 Tgas the agent attaches, even with the longest text the agent sends:
/// 2000 UTF-16 units, which take 3 bytes each in UTF-8.
#[tokio::test]
async fn an_extra_reasoning_argument_is_ignored_and_the_hash_is_unchanged() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let reasoning = "\u{20ac}".repeat(2000);
    assert_eq!(reasoning.len(), 6000);

    let result = chair
        .call(t.token.id(), "set_policy")
        .args_json(json!({
            "rate_bps": 40, "reasoning_hash": "ab".repeat(32), "reasoning": reasoning,
        }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    assert!(result.is_success(), "{}", failure_text(&result));

    assert_eq!(t.policy().await?.rate_bps, 40);
    let events = events(&result);
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]["data"],
        json!({
            "chair": chair.id(), "epoch": 0, "rate_bps": 40, "previous_rate_bps": 0,
            "reasoning_hash": "ab".repeat(32),
        })
    );
    let burnt: u64 = result.outcomes().iter().map(|o| o.gas_burnt.as_gas()).sum();
    assert!(
        burnt <= Gas::from_tgas(15).as_gas(),
        "6000 bytes of reasoning burnt {burnt} gas, over half of the 30 Tgas attached"
    );
    Ok(())
}

#[tokio::test]
async fn out_of_bounds_rate_is_rejected() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;

    for rate_bps in [201, -201, i32::MAX, i32::MIN] {
        let result = t.set_policy(&chair, rate_bps).await?;
        assert!(result.is_failure(), "rate {rate_bps} was accepted");
        assert!(
            failure_text(&result).contains("rate_bps out of bounds"),
            "{}",
            failure_text(&result)
        );
        assert!(
            events(&result).is_empty(),
            "a rejected call must not emit events"
        );
    }
    assert_eq!(t.policy().await?.last_set_epoch, None);
    Ok(())
}

#[tokio::test]
async fn too_large_step_is_rejected() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;

    for rate_bps in [51, -51] {
        let result = t.set_policy(&chair, rate_bps).await?;
        assert!(result.is_failure(), "step to {rate_bps} was accepted");
        assert!(
            failure_text(&result).contains("rate step too large"),
            "{}",
            failure_text(&result)
        );
    }
    assert!(
        t.set_policy(&chair, 50).await?.is_success(),
        "a step of exactly 50 is allowed"
    );
    Ok(())
}

#[tokio::test]
async fn second_call_in_one_epoch_is_rejected_and_next_epoch_is_open() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;

    assert!(t.set_policy(&chair, 10).await?.is_success());
    let second = t.set_policy(&chair, 20).await?;
    assert!(second.is_failure());
    assert!(
        failure_text(&second).contains("policy already set this epoch"),
        "{}",
        failure_text(&second)
    );
    assert_eq!(
        t.policy().await?.rate_bps,
        10,
        "the rejected call changed nothing"
    );

    t.advance_to_epoch(1).await?;
    let next = t.set_policy(&chair, 20).await?;
    assert!(next.is_success(), "{}", failure_text(&next));
    assert_eq!(t.policy().await?.rate_bps, 20);
    Ok(())
}

#[tokio::test]
async fn non_chair_caller_is_rejected() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;

    let result = t.set_policy(&t.alice, 10).await?;
    assert!(result.is_failure());
    assert!(
        failure_text(&result).contains("only the chair may set policy"),
        "{}",
        failure_text(&result)
    );
    assert_eq!(t.policy().await?.last_set_epoch, None);
    Ok(())
}

#[tokio::test]
async fn function_call_key_can_set_policy_but_cannot_transfer() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;

    let allowed = t.set_policy(&chair, 25).await?;
    assert!(allowed.is_success(), "{}", failure_text(&allowed));

    // The key is rejected before the call runs: a transaction-level error, not a contract panic.
    let denied = chair
        .call(t.token.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": t.alice.id(), "amount": "1" }))
        .transact()
        .await;
    let error = format!(
        "{:?}",
        denied.expect_err("ft_transfer must be refused to a set_policy-only key")
    );
    assert!(error.contains("MethodNameMismatch"), "{error}");

    // The full-access key was deleted when the scoped key was installed.
    let keys = chair.view_access_keys().await?;
    assert_eq!(keys.len(), 1);
    Ok(())
}

#[tokio::test]
async fn missed_epochs_decay_the_rate_toward_zero() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;

    // Climb to 200 bps, one 50 bps step per epoch.
    for (epoch, rate_bps) in [(0, 50), (1, 100), (2, 150), (3, 200)] {
        t.advance_to_epoch(epoch).await?;
        let result = t.set_policy(&chair, rate_bps).await?;
        assert!(result.is_success(), "{}", failure_text(&result));
    }

    // Epochs 4 and 5 pass with no decision. The view already shows the decayed rate.
    let epoch_6 = t.advance_to_epoch(6).await?;
    assert_eq!((epoch_6.rate_bps, epoch_6.streak), (100, 6));

    // From the decayed rate, the old 200 is now a too-large step...
    let too_far = t.set_policy(&chair, 200).await?;
    assert!(
        failure_text(&too_far).contains("rate step too large"),
        "{}",
        failure_text(&too_far)
    );

    // ...and 150 is fine. The decays are logged as events before the decision.
    let result = t.set_policy(&chair, 150).await?;
    assert!(result.is_success(), "{}", failure_text(&result));
    let events = events(&result);
    let names: Vec<_> = events
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["rate_decayed", "rate_decayed", "policy_set"]);
    assert_eq!(
        events[0]["data"],
        json!({ "epoch": 4, "previous_rate_bps": 200, "rate_bps": 150 })
    );
    assert_eq!(
        events[1]["data"],
        json!({ "epoch": 5, "previous_rate_bps": 150, "rate_bps": 100 })
    );
    assert_eq!(events[2]["data"]["previous_rate_bps"], 100);
    Ok(())
}

#[tokio::test]
async fn a_long_absence_decays_to_zero_and_stays_there() -> anyhow::Result<()> {
    // The shortest legal epoch keeps a hundred epochs cheap to fast-forward. Whichever epoch
    // the first decision lands in, 100 epochs of silence are far more than the 50 bps decay needs.
    let t = launch(1_000).await?;
    let chair = t.scoped_chair().await?;
    assert!(t.set_policy(&chair, -50).await?.is_success());

    let later = t.advance_to_epoch(100).await?;
    assert_eq!(later.rate_bps, 0);
    assert_eq!(later.streak, later.epoch);
    let result = t.set_policy(&chair, -50).await?;
    assert!(result.is_success(), "{}", failure_text(&result));
    Ok(())
}

#[tokio::test]
async fn launch_parameters_are_readable() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let params: serde_json::Value = t.token.view("get_params").await?.json()?;
    assert_eq!(params["epoch_ms"], EPOCH_MS);
    assert_eq!(params["max_rate_bps"], 200);
    assert_eq!(params["max_step_bps"], 50);
    assert_eq!(params["impeach_threshold_bps"], 3000);
    assert_eq!(params["nominate_bond"], "1000000000000000000000000");
    assert!(params["start_ms"].as_u64().unwrap() > 0);

    let supply: String = t.token.view("ft_total_supply").await?.json()?;
    assert_eq!(supply, sandbox_tests::INITIAL_SUPPLY);
    let held: String = t
        .token
        .view("ft_balance_of")
        .args_json(json!({ "account_id": t.alice.id() }))
        .await?
        .json()?;
    assert_eq!(held, sandbox_tests::INITIAL_SUPPLY);
    Ok(())
}
