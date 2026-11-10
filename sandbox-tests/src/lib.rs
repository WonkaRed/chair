//! Test harness: builds the real contract wasm with `cargo-near-build` (the library behind
//! `cargo near build`) and deploys it to a local NEAR sandbox. Nothing here mocks the chain.

use anyhow::{Result, anyhow};
use cargo_near_build::camino::Utf8PathBuf;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::OnceLock;

/// The nearcore release the tests run against; pinned so a clean clone sees the same chain.
pub const SANDBOX_VERSION: &str = "2.14.0";

pub const INITIAL_SUPPLY: &str = "1000000000000000000000000000";

/// Epoch length every test launches with. Long enough that a test never races a rollover
/// by accident, short enough that fast-forwarding a few epochs takes seconds.
pub const EPOCH_MS: u64 = 30_000;

/// Mirrors `PolicyView` in `contract/src/lib.rs`.
#[derive(Debug, Deserialize)]
pub struct Policy {
    pub epoch: u64,
    pub rate_bps: i32,
    pub chair: String,
    pub streak: u64,
    pub last_set_epoch: Option<u64>,
    pub epoch_ends_ms: u64,
}

pub struct Chair {
    pub worker: Worker<Sandbox>,
    pub token: Contract,
    /// The chair account with its full-access key, for setup only. Tests act as the chair
    /// through `scoped_chair`.
    pub chair: Account,
    pub alice: Account,
    pub epoch_ms: u64,
}

/// Build the contract wasm in-process, the way `cargo near build` does (no cargo-near CLI needed),
/// optionally copying it to `out_dir`. Returns the path of the wasm. This is the one build pipeline:
/// the tests and `make build` both run it, so the wasm tested is the wasm shipped.
pub fn build_contract(out_dir: Option<Utf8PathBuf>) -> Result<Utf8PathBuf> {
    let manifest = Utf8PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../contract/Cargo.toml"
    ));
    let artifact = cargo_near_build::build(cargo_near_build::BuildOpts {
        manifest_path: Some(manifest),
        out_dir,
        no_abi: true,
        ..Default::default()
    })
    .map_err(|e| anyhow!("building the contract wasm: {e:#}"))?;
    Ok(artifact.path)
}

/// The built wasm. Tests run in parallel threads: the first builds, the rest wait for its result.
fn contract_wasm() -> Result<&'static [u8]> {
    static WASM: OnceLock<Result<Vec<u8>, String>> = OnceLock::new();
    WASM.get_or_init(|| {
        let path = build_contract(None).map_err(|e| format!("{e:#}"))?;
        std::fs::read(&path).map_err(|e| format!("reading {path}: {e}"))
    })
    .as_deref()
    .map_err(|e| anyhow!("{e}"))
}

/// Deploy a fresh token to its own sandbox, with `chair` as the first chair.
pub async fn launch(epoch_ms: u64) -> Result<Chair> {
    let wasm = contract_wasm()?;
    let worker = near_workspaces::sandbox_with_version(SANDBOX_VERSION).await?;
    let root = worker.root_account()?;
    let chair = root
        .create_subaccount("chair")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let alice = root
        .create_subaccount("alice")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let token = worker.dev_deploy(wasm).await?;
    token
        .call("new")
        .args_json(json!({
            "owner_id": alice.id(),
            "total_supply": INITIAL_SUPPLY,
            "chair": chair.id(),
            "epoch_ms": epoch_ms,
            "impeach_threshold_bps": 3000,
            "nominate_bond": "1000000000000000000000000",
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(Chair {
        worker,
        token,
        chair,
        alice,
        epoch_ms,
    })
}

impl Chair {
    /// The chair as the design intends it: an account whose only usable key is a function-call
    /// key limited to `set_policy` on the token. The full-access key it was created with is deleted.
    pub async fn scoped_chair(&self) -> Result<Account> {
        let scoped_key = SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
        let own = &self.chair;
        let full_access_pk = own.secret_key().public_key();
        own.batch(own.id())
            .add_key(
                scoped_key.public_key(),
                AccessKey::function_call_access(self.token.id(), &["set_policy"], None),
            )
            .delete_key(full_access_pk)
            .transact()
            .await?
            .into_result()?;
        Ok(Account::from_secret_key(
            own.id().clone(),
            scoped_key,
            &self.worker,
        ))
    }

    pub async fn policy(&self) -> Result<Policy> {
        Ok(self.token.view("get_policy").await?.json()?)
    }

    /// Fast-forward the sandbox clock until the token is in epoch `target`, landing within a
    /// block or two of its start. Sandbox blocks advance the clock by roughly 300 ms each.
    pub async fn advance_to_epoch(&self, target: u64) -> Result<Policy> {
        loop {
            let policy = self.policy().await?;
            if policy.epoch >= target {
                return Ok(policy);
            }
            let now_ms = self.worker.view_block().await?.timestamp() / 1_000_000;
            let start_of_target_ms =
                policy.epoch_ends_ms + (target - policy.epoch - 1) * self.epoch_ms;
            let blocks = (start_of_target_ms.saturating_sub(now_ms) / 400).max(1);
            self.worker.fast_forward(blocks).await?;
        }
    }

    pub async fn set_policy(
        &self,
        caller: &Account,
        rate_bps: i32,
    ) -> Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.token.id(), "set_policy")
            .args_json(json!({ "rate_bps": rate_bps, "reasoning_hash": "ab".repeat(32) }))
            .transact()
            .await?)
    }
}

/// Every NEP-297 event in the logs, as JSON.
pub fn events(result: &ExecutionFinalResult) -> Vec<Value> {
    result
        .logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|json| serde_json::from_str(json).expect("event log is valid JSON"))
        .collect()
}

/// Why a call failed, for substring assertions: the contract panic message or the RPC rejection.
pub fn failure_text(result: &ExecutionFinalResult) -> String {
    match result.clone().into_result() {
        Ok(_) => String::new(),
        Err(e) => format!("{e:?}"),
    }
}
