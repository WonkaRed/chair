//! Test harness: builds the real contract wasm with `cargo-near-build` (the library behind
//! `cargo near build`) and deploys it to a local NEAR sandbox. Nothing here mocks the chain.

use anyhow::{Result, anyhow};
use cargo_near_build::camino::Utf8PathBuf;
use near_workspaces::network::{Sandbox, ValidatorKey};
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde::Deserialize;
use serde_json::{Value, json};
use std::net::{SocketAddr, TcpStream};
use std::sync::OnceLock;
use std::time::Duration;

/// The nearcore release the tests run against; pinned so a clean clone sees the same chain.
pub const SANDBOX_VERSION: &str = "2.14.0";

pub const INITIAL_SUPPLY: &str = "1000000000000000000000000000";

/// Epoch length every test launches with. Long enough that a test never races a rollover
/// by accident, short enough that fast-forwarding a few epochs takes seconds.
pub const EPOCH_MS: u64 = 30_000;

/// One whole token: the contract has 24 decimals.
pub const TOKEN: u128 = 1_000_000_000_000_000_000_000_000;

/// The launch bond every test token uses (`launch` passes it to `new`): 1 NEAR.
pub const NOMINATE_BOND: u128 = 1_000_000_000_000_000_000_000_000;

/// The sandbox node's `consensus.max_block_wait_delay` (the cap on its skip-approval timer), as seconds and
/// nanoseconds. nearcore 2.14's `sandbox_fast_forward` can lose a jump when it crosses one of the node's own
/// epoch boundaries and applying that block takes longer than the node's 10 ms tick; the node then walks every
/// height of the lost jump with skip approvals, at up to 6 s each. At 240 ms a lost jump costs at most
/// `JUMP_BLOCKS` x 240 ms, about 12 s. A cap above the node's `min_block_production_delay` is all its
/// validation asks.
const SKIP_DELAY_CAP: (u64, u64) = (0, 240_000_000);

/// The node's own epoch length in blocks (its genesis `epoch_length`, unrelated to the token's `epoch_ms`).
/// nearcore never fast-forwards across its own epoch boundary and clips a jump near one down to a single
/// block, and it fires the first jump after a boundary on the tick right after the boundary block, which is
/// where most lost jumps happen. A one-million-block epoch puts no boundary in any test's reach (the longest
/// run reached about 10,200 heights).
const NODE_EPOCH_LENGTH: u64 = 1_000_000;

/// Blocks per fast-forward jump: about 15 s of chain time at 310 ms a block. nearcore 2.14's sandbox halts
/// for good when a jump lands at or below a height its skip timer has already approved, so a halt needs the
/// timer to run more than this many heights ahead of the head, which takes a pause of the node process of
/// about 12 s; the worst pause seen under deliberate disk and CPU contention was 3.3 s. A lost jump (see
/// `SKIP_DELAY_CAP`) costs at most about 12 s.
pub const JUMP_BLOCKS: u64 = 50;

/// Longest `advance_to_epoch` may wait in wall-clock time before it gives up with an error.
const ADVANCE_TIMEOUT: Duration = Duration::from_secs(180);

/// Mirrors `StakingView` in `contract/src/staking.rs`.
#[derive(Debug, Deserialize)]
pub struct Staking {
    pub staked: String,
    pub pending_reward: String,
    pub backing: Option<String>,
    pub unlock_epoch: u64,
}

/// Mirrors `RewardPoolView` in `contract/src/staking.rs`.
#[derive(Debug, Deserialize)]
pub struct RewardPool {
    pub total_staked: String,
    pub reward_pool: String,
    pub reward_per_share: String,
}

/// Mirrors `CandidateView` in `contract/src/voting.rs`.
#[derive(Debug, Deserialize)]
pub struct Candidate {
    pub candidate: String,
    pub nominator: String,
    pub persona_hash: String,
    pub backing: String,
    pub bond: String,
}

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
    /// The sandbox node. Last, so the worker is dropped before the node is killed.
    node: near_sandbox::Sandbox,
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

/// Keep the node's own logs out of the test output unless `NEAR_ENABLE_SANDBOX_LOG` asks for them, as
/// `near-workspaces` does when it starts the node itself.
fn quiet_node_logs() {
    if std::env::var("NEAR_ENABLE_SANDBOX_LOG").is_ok_and(|v| v != "0") {
        return;
    }
    // SAFETY: called once, from inside the `OnceLock` initialiser that every launch waits on, before any
    // sandbox node is started and so before anything reads this variable.
    unsafe { std::env::set_var("NEAR_SANDBOX_LOG", "near=error,stats=error,network=error") };
}

/// Start a sandbox node with the capped skip delay, long node epochs and connect `near-workspaces` to it. The `registrar`
/// account is the one `near-workspaces` creates in its own nodes, for its subaccount creation.
async fn start_node() -> Result<(near_sandbox::Sandbox, Worker<Sandbox>)> {
    let node = near_sandbox::Sandbox::start_sandbox_with_config_and_version(
        near_sandbox::SandboxConfig {
            additional_accounts: vec![near_sandbox::GenesisAccount::default_with_name(
                "registrar".parse()?,
            )],
            additional_genesis: Some(json!({ "epoch_length": NODE_EPOCH_LENGTH })),
            additional_config: Some(json!({ "consensus": { "max_block_wait_delay":
                { "secs": SKIP_DELAY_CAP.0, "nanos": SKIP_DELAY_CAP.1 } } })),
            ..Default::default()
        },
        SANDBOX_VERSION,
    )
    .await?;
    let worker = near_workspaces::sandbox()
        .rpc_addr(&node.rpc_addr)
        .validator_key(ValidatorKey::HomeDir(node.home_dir.path().to_path_buf()))
        .await?;
    Ok((node, worker))
}

/// The built wasm. Tests run in parallel threads: the first builds, the rest wait for its result.
fn contract_wasm() -> Result<&'static [u8]> {
    static WASM: OnceLock<Result<Vec<u8>, String>> = OnceLock::new();
    WASM.get_or_init(|| {
        quiet_node_logs();
        let path = build_contract(None).map_err(|e| format!("{e:#}"))?;
        std::fs::read(&path).map_err(|e| format!("reading {path}: {e}"))
    })
    .as_deref()
    .map_err(|e| anyhow!("{e}"))
}

/// Deploy a fresh token to its own sandbox, with `chair` as the first chair.
pub async fn launch(epoch_ms: u64) -> Result<Chair> {
    launch_with_supply(epoch_ms, INITIAL_SUPPLY).await
}

/// Like `launch`, with the whole supply (a decimal string) minted to the owner at launch.
pub async fn launch_with_supply(epoch_ms: u64, total_supply: &str) -> Result<Chair> {
    let wasm = contract_wasm()?;
    let (node, worker) = start_node().await?;
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
    // The deploy procedure of SPEC.md "Deploying": the parent account creates the token account, deploys
    // the wasm and calls `new` in ONE transaction, and adds no key. Nobody can call `new` first, redeploy,
    // add a key or move the account's NEAR. Every test runs against that configuration.
    let token_id: near_workspaces::AccountId = format!("token.{}", root.id()).parse()?;
    root.batch(&token_id)
        .create_account()
        .transfer(NearToken::from_near(20))
        .deploy(wasm)
        .call(Function::new("new").args_json(json!({
            "owner_id": alice.id(),
            "total_supply": total_supply,
            "chair": chair.id(),
            "epoch_ms": epoch_ms,
            "impeach_threshold_bps": 3000,
            "nominate_bond": "1000000000000000000000000",
        })))
        .transact()
        .await?
        .into_result()?;
    // A handle for views and ids; its key is on no account, so it signs nothing.
    let token =
        Contract::from_secret_key(token_id, SecretKey::from_random(KeyType::ED25519), &worker);
    Ok(Chair {
        worker,
        token,
        chair,
        alice,
        epoch_ms,
        node,
    })
}

/// The one generated type; the allow is for the `uint` crate's macro output, as in the contract.
#[allow(clippy::assign_op_pattern, clippy::manual_div_ceil)]
mod wide {
    use uint::construct_uint;

    construct_uint! {
        pub struct U256(4);
    }
}

/// `a * b / c`, floored, with a 256-bit product: the reference arithmetic for the reward index and
/// pending rewards, which overflow `u128` at test magnitudes. Panics if `c` is 0 or the result does
/// not fit `u128`.
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    (wide::U256::from(a) * wide::U256::from(b) / wide::U256::from(c)).as_u128()
}

/// What one boundary mints on `supply` at `rate_bps` a day when epochs last `epoch_ms`: the rate spread over the
/// day's epochs (`86_400_000 / epoch_ms`, rounded up), `supply * rate / (10_000 * epochs_per_day)`, floored.
/// Written out here, not imported, so the tests check the contract against its SPEC.md formula.
pub fn mint_of(supply: u128, rate_bps: u128, epoch_ms: u64) -> u128 {
    supply * rate_bps / (10_000 * u128::from(86_400_000u64.div_ceil(epoch_ms)))
}

/// Names of the functions a wasm module exports (what the NEAR runtime lets a transaction call, plus
/// nothing else: `memory` and friends are not functions). Reads the export section directly.
pub fn exported_methods(wasm: &[u8]) -> Result<Vec<String>> {
    fn leb(bytes: &[u8], at: &mut usize) -> Result<usize> {
        let (mut value, mut shift) = (0usize, 0);
        loop {
            let byte = *bytes.get(*at).ok_or_else(|| anyhow!("truncated wasm"))?;
            *at += 1;
            value |= usize::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
            shift += 7;
            anyhow::ensure!(shift < 35, "oversized LEB128 in wasm");
        }
    }
    anyhow::ensure!(wasm.starts_with(b"\0asm\x01\0\0\0"), "not a wasm module");
    let mut at = 8;
    while at < wasm.len() {
        let id = wasm[at];
        at += 1;
        let size = leb(wasm, &mut at)?;
        let end = at.checked_add(size).filter(|e| *e <= wasm.len());
        let end = end.ok_or_else(|| anyhow!("section overruns the module"))?;
        if id == 7 {
            let mut names = Vec::new();
            let count = leb(wasm, &mut at)?;
            for _ in 0..count {
                let len = leb(wasm, &mut at)?;
                let name = std::str::from_utf8(
                    wasm.get(at..at + len)
                        .ok_or_else(|| anyhow!("bad export"))?,
                )?;
                at += len;
                let kind = *wasm.get(at).ok_or_else(|| anyhow!("bad export"))?;
                at += 1;
                leb(wasm, &mut at)?;
                if kind == 0 {
                    names.push(name.to_string());
                }
            }
            return Ok(names);
        }
        at = end;
    }
    Err(anyhow!("no export section"))
}

impl Chair {
    /// The chair as the design intends it: an account whose only usable key is a function-call
    /// key limited to `set_policy` on the token. The full-access key it was created with is deleted.
    pub async fn scoped_chair(&self) -> Result<Account> {
        let scoped_key = SecretKey::from_random(KeyType::ED25519);
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

    /// `e` with its whole cause chain (a bare `?` keeps only the top message) and whether the node still
    /// accepts connections, so a flaky run says whether the node process went away. Not a retry: a repeated
    /// `fast_forward` is rejected by a node that got the first.
    fn node_error(&self, e: impl Into<anyhow::Error>) -> anyhow::Error {
        let e = e.into();
        let addr = self.node.rpc_addr.trim_start_matches("http://");
        let state = match addr.parse::<SocketAddr>() {
            Ok(a) if TcpStream::connect_timeout(&a, Duration::from_secs(1)).is_ok() => {
                format!("sandbox node at {addr} is still listening, so the node process is up")
            }
            Ok(_) => format!(
                "sandbox node at {addr} is no longer listening (the process exited or was killed)"
            ),
            Err(parse) => format!("cannot probe the sandbox node at {addr}: {parse}"),
        };
        anyhow!("{e:#}; {state}")
    }

    pub async fn policy(&self) -> Result<Policy> {
        Ok(self.token.view("get_policy").await?.json()?)
    }

    /// Fast-forward `JUMP_BLOCKS` blocks, once the node is producing steadily: a head whose last final block is
    /// two heights below it was built on an endorsement, which nearcore makes only when no skip approval runs ahead.
    pub async fn jump(&self) -> Result<()> {
        let seen = self
            .worker
            .view_block()
            .await
            .map_err(|e| self.node_error(e))?
            .height();
        loop {
            let head = self
                .worker
                .view_block()
                .await
                .map_err(|e| self.node_error(e))?;
            let last_final = self
                .worker
                .view_block()
                .block_hash(*head.header().last_final_block())
                .await
                .map_err(|e| self.node_error(e))?;
            if head.height() > seen && last_final.height() + 2 == head.height() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        self.worker
            .fast_forward(JUMP_BLOCKS)
            .await
            .map_err(|e| self.node_error(e))
    }

    /// Fast-forward the sandbox clock, `JUMP_BLOCKS` blocks at a time, until the token is in epoch `target`.
    /// It lands within the first ~16 s of epoch `target` (one jump is about 15 s of chain time), so a test
    /// that must stay in that epoch needs an `epoch_ms` well above that. A node that stops producing blocks
    /// (see `JUMP_BLOCKS`) is reported when `ADVANCE_TIMEOUT` runs out.
    pub async fn advance_to_epoch(&self, target: u64) -> Result<Policy> {
        tokio::time::timeout(ADVANCE_TIMEOUT, async {
            loop {
                let policy = self.policy().await.map_err(|e| self.node_error(e))?;
                if policy.epoch >= target {
                    return Ok(policy);
                }
                self.jump().await?;
            }
        })
        .await
        .map_err(|_| {
            anyhow!(
                "the sandbox did not reach epoch {target} within {} s: its node stopped producing blocks after a fast-forward (a nearcore 2.14 sandbox bug; see JUMP_BLOCKS)",
                ADVANCE_TIMEOUT.as_secs()
            )
        })?
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

    /// A funded account registered with the token, holding `tokens` whole tokens from the owner.
    pub async fn user(&self, name: &str, tokens: u128) -> Result<Account> {
        let account = self
            .worker
            .root_account()?
            .create_subaccount(name)
            .initial_balance(NearToken::from_near(20))
            .transact()
            .await?
            .into_result()?;
        let registered = account
            .call(self.token.id(), "storage_deposit")
            .args_json(json!({}))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await?;
        ensure_success(&registered)?;
        if tokens > 0 {
            let funded = self
                .call(
                    &self.alice,
                    "ft_transfer",
                    json!({
                        "receiver_id": account.id(), "amount": (tokens * TOKEN).to_string(),
                    }),
                    1,
                )
                .await?;
            ensure_success(&funded)?;
        }
        Ok(account)
    }

    /// Call any token method with `deposit` yoctoNEAR attached and enough gas for a rollover.
    pub async fn call(
        &self,
        caller: &Account,
        method: &str,
        args: Value,
        deposit_yocto: u128,
    ) -> Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.token.id(), method)
            .args_json(args)
            .deposit(NearToken::from_yoctonear(deposit_yocto))
            .max_gas()
            .transact()
            .await?)
    }

    pub async fn stake(&self, caller: &Account, amount: u128) -> Result<ExecutionFinalResult> {
        self.call(
            caller,
            "stake",
            json!({ "amount": amount.to_string() }),
            STAKE_RECORD_DEPOSIT,
        )
        .await
    }

    pub async fn unstake(&self, caller: &Account, amount: u128) -> Result<ExecutionFinalResult> {
        self.call(
            caller,
            "unstake",
            json!({ "amount": amount.to_string() }),
            1,
        )
        .await
    }

    pub async fn claim(&self, caller: &Account) -> Result<ExecutionFinalResult> {
        self.call(caller, "claim", json!({}), 1).await
    }

    pub async fn transfer(
        &self,
        from: &Account,
        to: &Account,
        amount: u128,
    ) -> Result<ExecutionFinalResult> {
        self.call(
            from,
            "ft_transfer",
            json!({ "receiver_id": to.id(), "amount": amount.to_string() }),
            1,
        )
        .await
    }

    pub async fn nominate(
        &self,
        nominator: &Account,
        candidate: &Account,
        deposit_yocto: u128,
    ) -> Result<ExecutionFinalResult> {
        self.call(
            nominator,
            "nominate",
            json!({ "candidate": candidate.id(), "persona_hash": "cd".repeat(32) }),
            deposit_yocto,
        )
        .await
    }

    pub async fn back(
        &self,
        caller: &Account,
        candidate: &Account,
    ) -> Result<ExecutionFinalResult> {
        self.call(caller, "back", json!({ "candidate": candidate.id() }), 1)
            .await
    }

    pub async fn balance(&self, account: &Account) -> Result<u128> {
        let balance: String = self
            .token
            .view("ft_balance_of")
            .args_json(json!({ "account_id": account.id() }))
            .await?
            .json()?;
        Ok(balance.parse()?)
    }

    pub async fn total_supply(&self) -> Result<u128> {
        let supply: String = self.token.view("ft_total_supply").await?.json()?;
        Ok(supply.parse()?)
    }

    pub async fn staking(&self, account: &Account) -> Result<Staking> {
        Ok(self
            .token
            .view("get_staking")
            .args_json(json!({ "account_id": account.id() }))
            .await?
            .json()?)
    }

    pub async fn pool(&self) -> Result<RewardPool> {
        Ok(self.token.view("get_reward_pool").await?.json()?)
    }

    pub async fn candidates(&self) -> Result<Vec<Candidate>> {
        Ok(self.token.view("get_candidates").await?.json()?)
    }

    /// Native NEAR balance of an account, in yoctoNEAR.
    pub async fn near_balance(&self, account: &Account) -> Result<u128> {
        Ok(account.view_account().await?.balance.as_yoctonear())
    }

    /// The conservation law, checked through the views: everything minted and not burned is a liquid
    /// balance, stake, or unclaimed reward. `holders` must include every account that ever held tokens
    /// (the owner, every `user`, the chair); the token account is added here.
    pub async fn assert_supply_invariant(&self, holders: &[&Account]) -> Result<()> {
        let mut liquid = self.balance(self.token.as_account()).await?;
        for holder in holders {
            liquid += self.balance(holder).await?;
        }
        let pool = self.pool().await?;
        let staked: u128 = pool.total_staked.parse()?;
        let unclaimed: u128 = pool.reward_pool.parse()?;
        let supply = self.total_supply().await?;
        anyhow::ensure!(
            supply == liquid + staked + unclaimed,
            "supply {supply} != liquid {liquid} + staked {staked} + reward pool {unclaimed}"
        );
        Ok(())
    }
}

/// First stake of an account pays for its stake record; 0.01 NEAR is far more than it costs and the
/// contract refunds the rest. Later stakes would only need 1 yocto, and this works for them too.
pub const STAKE_RECORD_DEPOSIT: u128 = 10_000_000_000_000_000_000_000;

pub fn ensure_success(result: &ExecutionFinalResult) -> Result<()> {
    anyhow::ensure!(result.is_success(), "{}", failure_text(result));
    Ok(())
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
