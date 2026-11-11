//! `make demo`: the chair's leash, narrated against a real local NEAR sandbox. No keys, no network
//! beyond the one-time sandbox download. Exits non-zero if the contract ever behaves differently
//! from what is printed.

use anyhow::{Result, ensure};
use near_workspaces::result::ExecutionFinalResult;
use sandbox_tests::{EPOCH_MS, NOMINATE_BOND, TOKEN, ensure_success, events, failure_text, launch};

/// Print a decision the contract must refuse, failing the demo if it was accepted or refused for another reason.
fn refused(what: &str, result: &ExecutionFinalResult, expected: &str) -> Result<()> {
    let failure = failure_text(result);
    ensure!(
        result.is_failure() && failure.contains(expected),
        "{what}: expected `{expected}`, got {failure:?}"
    );
    println!("  {what} -> rejected: {expected}");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    println!(
        "$CHAIR demo (local NEAR sandbox, {}s epochs)",
        EPOCH_MS / 1000
    );
    println!(
        "chair {} holds one key: function-call, set_policy on the token only\n",
        chair.id()
    );

    for (epoch, rate_bps) in [(0, 40), (1, 90), (2, 140), (3, 190)] {
        t.advance_to_epoch(epoch).await?;
        let result = t.set_policy(&chair, rate_bps).await?;
        ensure!(
            result.is_success(),
            "epoch {epoch}: {}",
            failure_text(&result)
        );
        println!("epoch {epoch}: chair sets {rate_bps:+} bps -> accepted");
    }

    println!("\nepoch 3: the chair has already decided; a second try, and an impostor");
    refused(
        "chair sets +150 bps again",
        &t.set_policy(&chair, 150).await?,
        "policy already set this epoch",
    )?;
    refused(
        "a non-chair account sets 0 bps",
        &t.set_policy(&t.alice, 0).await?,
        "only the chair may set policy",
    )?;

    println!("\nepoch 4: the chair tries to break its bounds");
    t.advance_to_epoch(4).await?;
    refused(
        "+201 bps",
        &t.set_policy(&chair, 201).await?,
        "rate_bps out of bounds",
    )?;
    refused(
        "+100 bps (a 90 bps jump)",
        &t.set_policy(&chair, 100).await?,
        "rate step too large",
    )?;
    let transfer = chair
        .call(t.token.id(), "ft_transfer")
        .args_json(serde_json::json!({ "receiver_id": t.alice.id(), "amount": "1" }))
        .transact()
        .await;
    let error = format!(
        "{:?}",
        transfer
            .err()
            .ok_or_else(|| anyhow::anyhow!("ft_transfer was allowed to the chair's key"))?
    );
    ensure!(error.contains("MethodNameMismatch"), "ft_transfer: {error}");
    println!(
        "  ft_transfer with the chair's key -> rejected: MethodNameMismatch (key is limited to set_policy)"
    );

    println!("\nthe chair goes silent for epochs 4 and 5");
    let silent = t.advance_to_epoch(6).await?;
    ensure!(
        silent.rate_bps == 90,
        "expected the rate to decay from 190 to 90, got {}",
        silent.rate_bps
    );
    println!(
        "epoch 6: the rate decayed 50 bps per missed epoch, 190 -> {:+}",
        silent.rate_bps
    );
    let result = t.set_policy(&chair, 140).await?;
    ensure!(result.is_success(), "{}", failure_text(&result));
    for event in events(&result) {
        println!("  event {}: {}", event["event"], event["data"]);
    }

    println!(
        "\na mint epoch: alice stakes 500 tokens, the +140 bps rate pays stakers at the boundary"
    );
    ensure_success(&t.stake(&t.alice, 500 * TOKEN).await?)?;
    let supply = t.total_supply().await?;
    t.advance_to_epoch(7).await?;
    let pending: u128 = t.staking(&t.alice).await?.pending_reward.parse()?;
    ensure!(pending > 0, "no reward after an epoch at +140 bps");
    let minted = t.total_supply().await? - supply;
    ensure!(
        minted > 0 && pending <= minted,
        "the staker's {pending} must come out of the {minted} minted"
    );
    ensure_success(&t.claim(&t.alice).await?)?;
    println!(
        "epoch 7: {minted} base units minted, {pending} of them the staker's claim (supply {supply} -> {})",
        t.total_supply().await?
    );
    ensure_success(&t.set_policy(&chair, 90).await?)?;

    println!("\na burn epoch: the chair tightens to -10 bps, a transfer burns its share");
    for (epoch, rate_bps) in [(8, 40), (9, -10)] {
        t.advance_to_epoch(epoch).await?;
        ensure_success(&t.set_policy(&chair, rate_bps).await?)?;
        println!("epoch {epoch}: chair sets {rate_bps:+} bps -> accepted");
    }
    let dan = t.user("dan", 0).await?;
    let supply = t.total_supply().await?;
    ensure_success(&t.transfer(&t.alice, &dan, 100 * TOKEN).await?)?;
    let burned = 100 * TOKEN * 10 / 10_000;
    ensure!(
        t.balance(&dan).await? == 100 * TOKEN - burned
            && t.total_supply().await? == supply - burned,
        "a 100 token transfer at -10 bps must burn exactly {burned}"
    );
    println!(
        "  100 tokens sent, {burned} base units burned, dan received {}",
        100 * TOKEN - burned
    );
    t.assert_supply_invariant(&[&t.alice, &dan, &chair]).await?;

    println!(
        "\nimpeachment: alice nominates dan; her whole stake backs him at once. It is all of the stake \
         and over 5% of the supply, so it clears both the threshold and the quorum"
    );
    ensure_success(&t.nominate(&t.alice, &dan, NOMINATE_BOND).await?)?;
    let backing = &t.candidates().await?[0].backing;
    ensure!(
        *backing == t.staking(&t.alice).await?.staked,
        "nominating did not back the candidate with the nominator's stake: {backing}"
    );
    ensure!(
        t.policy().await?.chair == chair.id().as_str(),
        "the chair is replaced only at the boundary"
    );
    let policy = t.advance_to_epoch(10).await?;
    ensure!(
        policy.chair == dan.id().as_str(),
        "expected {} to take the chair, got {}",
        dan.id(),
        policy.chair
    );
    println!("epoch 10: the stake vote seated {} as chair", policy.chair);
    refused(
        "the impeached chair sets 0 bps",
        &t.set_policy(&chair, 0).await?,
        "only the chair may set policy",
    )?;
    t.assert_supply_invariant(&[&t.alice, &dan, &chair]).await?;

    println!("\nPASS: every bound held");
    Ok(())
}
