//! Records one scripted run of the real $CHAIR wasm in a local NEAR sandbox as `web/fixtures/sandbox-run.json`.
//! Each transaction is stored in the shape the page reads from an indexer (FastNEAR's `/v0/transactions`, which
//! is the shape of NEAR RPC `EXPERIMENTAL_tx_status`): hash, signer, method, and every receipt's block time,
//! executor, status and logs. Nothing is edited or invented after the run; the views come from the same chain.
//!
//! Usage: `chair-web-recorder <out.json>`. Needs the same toolchain as `make -C sandbox-tests test`.

use anyhow::{Result, ensure};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use sandbox_tests::{Chair, EPOCH_MS, INITIAL_SUPPLY, NOMINATE_BOND, SANDBOX_VERSION, TOKEN, ensure_success};
use sha2::{Digest, Sha256};
use serde_json::{Value, json};

/// `sha256("recorded sandbox run, epoch N")` for N in 0..=13, so `reasoning_hash` has the contract's shape.
const HASHES: [&str; 14] = include!("hashes.in");

async fn record(t: &Chair, method: &str, args: &Value, result: &ExecutionFinalResult) -> Result<Value> {
    let tx = result.outcome();
    let mut receipts = Vec::new();
    for r in result.receipt_outcomes() {
        let block = t.worker.view_block().block_hash(r.block_hash).await?;
        receipts.push(json!({
            "execution_outcome": {
                "block_height": block.height().to_string(),
                "block_timestamp": block.timestamp().to_string(),
                "outcome": {
                    "executor_id": r.executor_id.to_string(),
                    "logs": r.logs,
                    "status": if r.is_success() { json!({"SuccessValue": ""}) } else { json!({"Failure": {}}) },
                },
            }
        }));
    }
    Ok(json!({
        "transaction": {
            "hash": tx.transaction_hash.to_string(),
            "signer_id": tx.executor_id.to_string(),
            "receiver_id": t.token.id().to_string(),
            "actions": [{ "FunctionCall": { "method_name": method, "args": args } }],
        },
        "receipts": receipts,
    }))
}

struct Run<'a> {
    t: &'a Chair,
    txs: Vec<Value>,
}

impl Run<'_> {
    async fn call(&mut self, caller: &near_workspaces::Account, method: &str, args: Value, deposit: u128) -> Result<()> {
        let result = self.t.call(caller, method, args.clone(), deposit).await?;
        ensure_success(&result).map_err(|e| anyhow::anyhow!("{method} {args}: {e}"))?;
        let rec = record(self.t, method, &args, &result).await?;
        self.txs.push(rec);
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let out = std::env::args().nth(1).ok_or_else(|| anyhow::anyhow!("usage: chair-web-recorder <out.json>"))?;
    // `sandbox_tests::launch`, step for step, except that the `new` transaction is kept: its logs hold the launch mint.
    let wasm = std::fs::read(sandbox_tests::build_contract(None)?.as_std_path())?;
    let worker = near_workspaces::sandbox_with_version(SANDBOX_VERSION).await?;
    let root = worker.root_account()?;
    let chair_acct = root.create_subaccount("chair").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let alice_acct = root.create_subaccount("alice").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let token = worker.dev_deploy(&wasm).await?;
    let new_args = json!({
        "owner_id": alice_acct.id(), "total_supply": INITIAL_SUPPLY, "chair": chair_acct.id(),
        "epoch_ms": EPOCH_MS, "impeach_threshold_bps": 3000, "nominate_bond": NOMINATE_BOND.to_string(),
    });
    let new_result = token.call("new").args_json(&new_args).transact().await?;
    ensure_success(&new_result)?;
    let deployer_key = token.as_account().secret_key().clone();
    token.as_account().batch(token.id()).delete_key(deployer_key.public_key()).transact().await?.into_result()?;
    let t = Chair { worker, token, chair: chair_acct, alice: alice_acct, epoch_ms: EPOCH_MS, deployer_key };
    let chair = t.scoped_chair().await?;
    let dan = t.user("dan", 0).await?;
    let erin = t.user("erin", 0).await?;
    let mut run = Run { t: &t, txs: Vec::new() };
    run.txs.push(record(&t, "new", &new_args, &new_result).await?);
    // Funding: alice (owner) pays dan and erin, then stakes.
    let alice = t.alice.clone();
    run.call(&alice, "ft_transfer", json!({ "receiver_id": dan.id(), "amount": (300 * TOKEN).to_string() }), 1).await?;
    run.call(&alice, "ft_transfer", json!({ "receiver_id": erin.id(), "amount": (100 * TOKEN).to_string() }), 1).await?;

    // (epoch, rate) the chair sets; epochs 4 and 5 are silent (decay), then it steps down through zero and back up.
    let schedule: [(u64, i32); 12] = [(0, 40), (1, 90), (2, 140), (3, 190), (6, 40), (7, -10), (8, -60), (9, -100), (10, -60), (11, -10), (12, 40), (13, 90)];
    for (epoch, rate) in schedule {
        t.advance_to_epoch(epoch).await?;
        match epoch {
            1 => {
                run.call(&alice, "stake", json!({ "amount": (300 * TOKEN).to_string() }), sandbox_tests::STAKE_RECORD_DEPOSIT).await?;
                run.call(&dan, "stake", json!({ "amount": (200 * TOKEN).to_string() }), sandbox_tests::STAKE_RECORD_DEPOSIT).await?;
            }
            7 => run.call(&alice, "claim", json!({}), 1).await?,
            8 => run.call(&dan, "ft_transfer", json!({ "receiver_id": erin.id(), "amount": (70 * TOKEN).to_string() }), 1).await?,
            9 => run.call(&alice, "ft_transfer", json!({ "receiver_id": erin.id(), "amount": (120 * TOKEN).to_string() }), 1).await?,
            10 => run.call(&erin, "ft_transfer", json!({ "receiver_id": dan.id(), "amount": (90 * TOKEN).to_string() }), 1).await?,
            _ => {}
        }
        // The chair signs with its function-call key, scoped to set_policy, exactly as in production.
        let args = json!({ "rate_bps": rate, "reasoning_hash": HASHES[epoch as usize] });
        let result = chair.call(t.token.id(), "set_policy").args_json(&args).max_gas().transact().await?;
        ensure_success(&result)?;
        let rec = record(&t, "set_policy", &args, &result).await?;
        run.txs.push(rec);
    }

    let supply_at_last_tx: Value = t.token.view("get_supply").await?.json()?;
    let last_block = t.worker.view_block().await?;
    let params: Value = t.token.view("get_params").await?.json()?;
    // One more silent epoch: the +90 bps mint for epoch 13 is due and not applied, so views project it.
    t.advance_to_epoch(14).await?;
    let supply_now: Value = t.token.view("get_supply").await?.json()?;
    let policy_now: Value = t.token.view("get_policy").await?.json()?;
    ensure!(!run.txs.is_empty(), "nothing recorded");
    let access_keys = t.worker.view_access_keys(t.token.id()).await?;

    let doc = json!({
        "schema": "chair-web-fixture/1",
        "label": "recorded sandbox run, not a live chain",
        "source": "web/recorder: a scripted run of the real contract wasm in a local NEAR sandbox (near-sandbox, sandbox-tests harness)",
        "epoch_ms": EPOCH_MS,
        "token": t.token.id().to_string(),
        "wasm_bytes": wasm.len(),
        "wasm_sha256": format!("{:x}", Sha256::digest(&wasm)),
        "params": params,
        "lastTxBlockHeight": last_block.height(),
        "supplyAtLastTx": supply_at_last_tx,
        "supplyNow": supply_now,
        "policyNow": policy_now,
        "accessKeys": access_keys.iter().map(|k| k.public_key.to_string()).collect::<Vec<_>>(),
        "txs": run.txs,
    });
    std::fs::write(&out, format!("{}\n", serde_json::to_string_pretty(&doc)?))?;
    println!("wrote {out}: {} transactions", run.txs.len());
    Ok(())
}
