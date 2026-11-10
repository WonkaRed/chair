# $CHAIR interface contract

This file is the contract between lanes. If code and this file disagree, one of them is a bug: fix it
in the same change. Status marks: **[implemented]** is in `contract/` and covered by tests;
**[lane: name]** is specified here and owned by the named lane, with nothing written yet.

## Directory ownership

| Directory | Owner lane | Contents | Rule |
| --- | --- | --- | --- |
| `contract/` | contract | The token (`chair-token` crate). `policy.rs` is pure math, `token.rs` the NEP-141 surface, `events.rs` the event enum, `lib.rs` state and methods | Method signatures, panics and event schemas change only with this file |
| `sandbox-tests/` | contract | near-workspaces tests, `Chair` harness in `src/lib.rs`, `make demo` in `examples/demo.rs` | Tests run the real wasm; no mocks of the contract |
| `chair-agent/` | agent | TypeScript. A deterministic rule-based chair (needs no API key) and an LLM chair; both only ever call `set_policy` | Signs with a function-call key scoped to `set_policy` |
| `sim/` | sim | 60-epoch simulator, supply under several scenarios | Implements "Rollover" below exactly, integer arithmetic, same rounding |
| `web/` | web | Static page: streak, current rate, decision log, mints and burns | Reads views and NEP-297 events only |
| root | scaffold | `Makefile`, `Dockerfile`, `rust-toolchain.toml`, `README.md`, this file | Lanes edit `LANES` in the Makefile only to register themselves |

Each lane directory has its own `Makefile` with `build`, `test` and `demo`. The root Makefile runs them
in `LANES` order. `make test` must pass from a clean clone with no API keys, no wallet, and no network
beyond package registries and the one-time sandbox download.

## Parameters

Set once in `new`, readable with `get_params`. No method changes them and the contract has no upgrade path.

| Field | Type | Source | Meaning |
| --- | --- | --- | --- |
| `epoch_ms` | `u64` | `new` arg, `1000..=31_536_000_000` | Epoch length in milliseconds of block time |
| `start_ms` | `u64` | block time at `new` | Epoch 0 starts here |
| `max_rate_bps` | `i32` | constant `200` | Rate bound: `-200 <= rate_bps <= 200` |
| `max_step_bps` | `i32` | constant `50` | Largest change per epoch; also the missed-epoch decay step |
| `impeach_threshold_bps` | `u32` | `new` arg, `1..=10_000` | Share of total staked that a candidate's backing must exceed |
| `nominate_bond` | `U128` | `new` arg, `> 0` | Bond in yoctoNEAR attached to `nominate` |

Not in `Params` but fixed at `new`: the first chair, and the initial supply (`total_supply`, held by `owner_id`).
Constants in code: `MAX_TOTAL_SUPPLY = u128::MAX / 10_000`, `MAX_REASONING_HASH_LEN = 128`.
Token metadata is fixed: name `$CHAIR`, symbol `CHAIR`, 24 decimals, no icon.

## Methods

Types: `U128` is a decimal string on the wire (NEP-141 convention); `rate_bps` is a JSON number.

### Implemented

```rust
#[init] fn new(owner_id: AccountId, total_supply: U128, chair: AccountId,
               epoch_ms: u64, impeach_threshold_bps: u32, nominate_bond: U128) -> Self
```
Panics: `total_supply must be in 1..=u128::MAX/10000`; `epoch_ms must be in 1000..=31536000000`;
`impeach_threshold_bps must be in 1..=10000`; `nominate_bond must be positive`; and (near-sdk `#[init]`)
if the contract is already initialized. Mints `total_supply` to `owner_id` (registering it) and emits an
NEP-141 `ft_mint` with memo `launch`.

```rust
fn set_policy(&mut self, rate_bps: i32, reasoning_hash: String)
```
Not payable. Checks run in this order and each panics with the quoted message:

| # | Check | Panic message |
| --- | --- | --- |
| 1 | `predecessor_account_id == chair` | `only the chair may set policy` |
| 2 | `1 <= reasoning_hash.len() <= 128` (bytes) | `reasoning_hash must be 1..=128 bytes` |
| 3 | no `set_policy` yet in the current epoch | `policy already set this epoch` |
| 4 | `-200 <= rate_bps <= 200` | `rate_bps out of bounds: must be within -200..=200` |
| 5 | `abs(rate_bps - rate_in_effect) <= 50` | `rate step too large: must move at most 50 bps from the current rate` |

`rate_in_effect` is the rate after any pending missed-epoch decay (see "Rollover"), so after a silent
stretch the step bound is measured from the decayed rate. Setting the same rate again in a later epoch is
valid. On success: state is updated, then `rate_decayed` events (one per missed epoch, oldest first),
then one `policy_set`. Events are emitted only after every check has passed, so a reverted call never
leaves an event in the logs.

NEP-141 and storage management, **[implemented]** as pass-through to `near-contract-standards` in `token.rs`:
`ft_transfer`, `ft_transfer_call`, `ft_total_supply`, `ft_balance_of`, `ft_resolve_transfer`,
`storage_deposit`, `storage_withdraw`, `storage_unregister`, `storage_balance_bounds`,
`storage_balance_of`, `ft_metadata`.

### Views

```rust
fn get_params(&self) -> Params                       // [implemented]
// { epoch_ms, start_ms, max_rate_bps, max_step_bps, impeach_threshold_bps, nominate_bond }

fn get_policy(&self) -> PolicyView                   // [implemented]
// { epoch, rate_bps, chair, streak, last_set_epoch: Option<u64>, epoch_ends_ms }
```
`get_policy` is computed from the latest block time with pending decay applied, so it is correct even if
no transaction has touched the contract for many epochs. `streak = epoch - chair_since_epoch`: complete
epochs the sitting chair has held office. `epoch_ends_ms = start_ms + (epoch + 1) * epoch_ms`.

### Extension points (not implemented)

**[lane: contract, staking]**
```rust
#[payable] fn stake(&mut self, amount: U128)        // 1 yocto; moves liquid balance into staked balance
#[payable] fn unstake(&mut self, amount: U128)      // 1 yocto; staked back to liquid; also reduces the caller's backing
fn claim(&mut self) -> U128                         // pays pending rewards to the caller; returns the amount
fn get_staking(&self, account_id: AccountId) -> StakingView   // { staked, pending_reward, backing: Option<AccountId> }
fn get_reward_pool(&self) -> RewardPoolView         // { total_staked, reward_pool, reward_per_share }
```
Staked tokens stay in `ft_total_supply` but are not transferable. `claim` and `unstake` are internal
accounting, not `ft_transfer`, so they never burn.

**[lane: contract, transfer burn]** The body of `ft_transfer` and `ft_transfer_call` in `token.rs`; see
"Transfer burn".

**[lane: contract, impeachment]**
```rust
#[payable] fn nominate(&mut self, candidate: AccountId, persona_hash: String)  // attach >= nominate_bond (NEAR)
fn back(&mut self, candidate: AccountId)            // caller's whole staked balance backs one candidate; calling again moves it
fn unback(&mut self)
fn withdraw_nomination(&mut self, candidate: AccountId)   // nominator only; returns the bond
fn get_candidates(&self) -> Vec<CandidateView>      // { candidate, nominator, persona_hash, backing, bond }
```
Bond refund rules, whether the sitting chair can be nominated, and the cap on live candidates are open
decisions for that lane; it records them here when it decides.

Rules binding every extension:
1. Every method that mutates the policy, staking, backing or the chair calls `roll()` first, so rollover
   always sees state as it stood at the boundary. Flash-staking right after a boundary cannot affect it.
2. `roll()` generalizes `PolicyState::advance_to`. It must stay bounded however long the contract sat idle.
   `PolicyState::is_quiescent` is the seam: the impeachment lane extends it so a boundary with a candidate
   over the threshold is never skipped (the first boundary after a quiet stretch must run, and it clears
   the candidates, so later boundaries are no-ops).
3. New state goes into `Contract` fields or new modules; `Params` and event schemas below only grow by new
   events or a version bump.

## Epochs and rollover

Time is `block_timestamp_ms` (nanoseconds floor-divided by 1_000_000). There is no cron on NEAR, so
rollover is lazy: it is applied by the first mutating call after a boundary (and projected, without writing,
by views), and the result is identical to applying each boundary at its exact time.

```
epoch(t)  = (t_ms - start_ms) / epoch_ms          // integer division, floor; t_ms < start_ms counts as 0
```

The **rate in effect** during epoch `e` is: the rate left by boundary `e-1`, replaced by the chair's
`set_policy` in `e` if there is one. It starts at 0.

Boundary `e -> e+1` closes epoch `e`. Steps run in this order, using integers throughout:

1. **Mint (easing).** `rate = rate_in_effect_during(e)`. If `rate > 0` and `total_staked > 0`:
   `minted = min(total_supply * rate / 10_000, MAX_TOTAL_SUPPLY - total_supply)` (floor), `total_supply += minted`,
   `reward_per_share += minted * REWARD_SCALE / total_staked` (floor), with `REWARD_SCALE = 10^24` and
   256-bit intermediates. The floor remainder stays in the pool, never paid out. If `total_staked == 0`
   nothing is minted. A staker's pending reward is `staked * (reward_per_share - paid_per_share) / REWARD_SCALE` (floor).
   **[lane: contract, staking]**
2. **Decay.** If `last_set_epoch != Some(e)` (the chair did not act in `e`):
   `rate' = rate - signum(rate) * min(abs(rate), 50)`. **[implemented]** Emits `rate_decayed {epoch: e, ...}`.
3. **Impeachment.** Among candidates with `backing * 10_000 > impeach_threshold_bps * total_staked` (strictly
   greater), the one with the most backing wins (ties: nominated earliest). The winner becomes chair,
   `chair_since_epoch = e + 1` (streak resets to 0), all nominations and backings are cleared, and
   `impeached` is emitted. The new chair may call `set_policy` in epoch `e+1`. **[lane: contract, impeachment]**

Ordering consequences, worth restating because the simulator must match: a chair who acts in epoch `e` and
then goes silent keeps that rate for all of `e+1` (and mints at it at the end of `e+1`) and only then starts
to decay; the decay a missed epoch causes first applies to the epoch after it. Mint uses the pre-decay rate.

Bounded work: once `rate == 0` (and, with impeachment, no candidate is over the threshold) every later
boundary is a no-op, so `advance_to` jumps straight to the target epoch. From the largest rate that is at
most `200 / 50 = 4` decay steps.

### Transfer burn **[lane: contract, transfer burn]**

When the rate in effect (after `roll()`) is negative, `ft_transfer(receiver, amount)` and
`ft_transfer_call` debit `amount` from the sender, credit `amount - burn` to the receiver, and burn
`burn = amount * abs(rate) / 10_000` (floor, so dust-sized transfers burn 0) from total supply. For
`ft_transfer_call`, `ft_on_transfer` is told `amount - burn` and `ft_resolve_transfer` resolves
against `amount - burn`. Nothing is minted while the rate is negative. Emits `ft_burn` and `transfer_burned`.

### Worked vectors (the simulator and the contract must agree)

| Case | Input | Result |
| --- | --- | --- |
| Mint | supply `1_000_001`, rate `33`, staked `500` | `minted = 3300` (3300.0033 floored) |
| Burn | amount `12_345`, rate `-75` | `burn = 92` (92.5875 floored) |
| Decay | rate `120`, chair silent after acting | in-effect `120`, then `70`, `20`, `0` |
| Decay | rate `-120` | `-120`, `-70`, `-20`, `0` |
| Step | in effect `-10` | `40` allowed, `41` rejected |
| Bounds | in effect `150` | `200` allowed, `201` rejected |

## Events

NEP-297. Every event is logged as `EVENT_JSON:{"standard":"chair","version":"1.0.0","event":"<name>","data":{...}}`.
`standard` is `chair` for the events below; supply changes also emit the NEP-141 `ft_mint` / `ft_burn`
events (`nep141`) with memo `chair:easing`, `chair:tightening` or `launch`, so generic indexers track supply.
`data` is a JSON object; `u128` amounts are decimal strings, other numbers are JSON numbers.

| Event | `data` | Emitted by |
| --- | --- | --- |
| `policy_set` | `chair, epoch, rate_bps, previous_rate_bps, reasoning_hash` | `set_policy` **[implemented]** |
| `rate_decayed` | `epoch, previous_rate_bps, rate_bps` | any rollover step 2 **[implemented]** |
| `epoch_minted` | `epoch, rate_bps, amount, total_staked, reward_per_share` | step 1 |
| `transfer_burned` | `epoch, rate_bps, account_id, amount, burned` | `ft_transfer`, `ft_transfer_call` |
| `staked` / `unstaked` | `account_id, amount, total_staked` | `stake` / `unstake` |
| `claimed` | `account_id, amount` | `claim` |
| `nominated` | `candidate, nominator, persona_hash, bond` | `nominate` |
| `backed` / `unbacked` | `account_id, candidate, amount` | `back` / `unback` and stake changes |
| `nomination_withdrawn` | `candidate, nominator, bond` | `withdraw_nomination` |
| `impeached` | `epoch, previous_chair, new_chair, persona_hash, backing, total_staked, streak_ended` | step 3 |

`epoch` in an event is the epoch the event concerns, not the epoch of the block that logged it (a lazy
rollover can log events for earlier epochs). The decision log on the page is `policy_set` and
`rate_decayed` ordered by `epoch`.

## The chair's key

The contract only checks `predecessor_account_id == chair`. The chair account must additionally hold no
full-access key: its only key is a function-call key whose receiver is the token contract and whose
methods are exactly `["set_policy"]`. With that key the account can call `set_policy` and nothing else:
`ft_transfer`, stake and nominate calls are refused by the protocol before the contract runs
(`MethodNameMismatch`), and a function-call key cannot attach a deposit. This is a setup step:

```sh
# near-cli-rs 0.31.1. Flags checked against its --help; not run against a live network.
near account add-key CHAIR_ACCOUNT grant-function-call-access --allowance unlimited \
  --contract-account-id TOKEN_ACCOUNT --function-names set_policy \
  autogenerate-new-keypair save-to-keychain network-config testnet sign-with-keychain send
near account delete-keys CHAIR_ACCOUNT public-keys FULL_ACCESS_PUBLIC_KEY \
  network-config testnet sign-with-keychain send
```

`Chair::scoped_chair` in `sandbox-tests/src/lib.rs` performs the same two steps in code and every chair
test runs through it. The token account itself must have all keys deleted after deploy, which is what
makes the no-admin, no-upgrade guarantee real.
