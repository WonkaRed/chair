//! `make demo`: the chair's leash, narrated against a real local NEAR sandbox. No keys, no network
//! beyond the one-time sandbox download. Exits non-zero if the contract ever behaves differently
//! from what is printed.

use anyhow::{Result, ensure};
use near_workspaces::result::ExecutionFinalResult;
use sandbox_tests::{EPOCH_MS, events, failure_text, launch};

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

    println!("\nPASS: every bound held");
    Ok(())
}
