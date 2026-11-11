# $CHAIR interface contract

This file is the contract between lanes. If code and this file disagree, one of them is a bug: fix it
in the same change. Status marks: **[implemented]** is in `contract/` and covered by tests;
**[lane: name]** is specified here and owned by the named lane, with nothing written yet. Everything the
contract lane owns is implemented.

## Directory ownership

| Directory | Owner lane | Contents | Rule |
| --- | --- | --- | --- |
| `contract/` | contract | The token (`chair-token` crate). `policy.rs` is pure policy math, `rollover.rs` the epoch boundary as one pure value (`EpochState`), `staking.rs` the reward index and stake methods, `voting.rs` nomination and backing, `token.rs` the NEP-141 surface and transfer burn, `events.rs` the event enum, `lib.rs` state, `roll`, `set_policy` and the policy views | Method signatures, panics and event schemas change only with this file |
| `sandbox-tests/` | contract | near-workspaces tests, `Chair` harness in `src/lib.rs`, `make demo` in `examples/demo.rs` | Tests run the real wasm; no mocks of the contract |
| `chair-agent/` | agent | TypeScript. A deterministic rule-based chair (needs no API key) and an LLM chair; both only ever call `set_policy` | Signs with a function-call key scoped to `set_policy` |
| `sim/` | sim | 60-epoch simulator, supply under several scenarios | Implements "Rollover" below exactly, integer arithmetic, same rounding |
| `web/` | web | Static page: streak, current rate, decision log, mints and burns | Reads views and NEP-297 events only |
| `deploy/` | deploy | TypeScript. Launches the token on NEAR testnet exactly as "Deploying" below, runs a scripted scenario on it and re-checks the deployment from public views | Testnet only; keys stay outside the repository |
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
| `impeach_threshold_bps` | `u32` | `new` arg, `1..=5_000` | Share of total staked that a candidate's backing must exceed |
| `quorum_bps` | `u32` | constant `500` | Share of the whole supply (staked or not) that a candidate's backing must also exceed |
| `nominate_bond` | `U128` | `new` arg, `1..=100 NEAR` (`10^26` yoctoNEAR) | Bond in yoctoNEAR attached to `nominate` |

Not in `Params` but fixed at `new`: the first chair, and the initial supply (`total_supply`, held by `owner_id`).
Constants in code: `QUORUM_BPS = 500`, `MAX_IMPEACH_THRESHOLD_BPS = 5_000`, `MAX_NOMINATE_BOND = 10^26`, `MAX_TOTAL_SUPPLY = u128::MAX / 10_000`, `MAX_PERSONA_HASH_LEN = 128` (the limit for `persona_hash`; `reasoning_hash` is exactly 64 hex characters), `REWARD_SCALE = 10^24`, `STAKE_LOCK_EPOCHS = 2`, `MAX_CANDIDATES = 10`.
Token metadata is fixed: name `$CHAIR`, symbol `CHAIR`, 24 decimals, no icon.

## Methods

Types: `U128` is a decimal string on the wire (NEP-141 convention); `rate_bps` is a JSON number.

### Implemented

```rust
#[init] fn new(owner_id: AccountId, total_supply: U128, chair: AccountId,
               epoch_ms: u64, impeach_threshold_bps: u32, nominate_bond: U128) -> Self
```
Panics: `total_supply must be in 1..=u128::MAX/10000`; `epoch_ms must be in 1000..=31536000000`;
`impeach_threshold_bps must be in 1..=5000`; `nominate_bond must be in 1..=100 NEAR (10^26 yoctoNEAR)`;
`owner_id must not be the token account itself: nobody could ever move the supply`; and
(near-sdk `#[init]`) if the contract is already initialized. The threshold and bond bounds keep those two
parameters from making the chair unremovable: a threshold above half the stake could put the seat out of a
majority's reach (and 10_000 out of everyone's), and a bond no one can afford would close the candidate list.
They do not cover everything: a launch that parks the supply with an `owner_id` that never stakes (an account
nobody controls), or an `epoch_ms` of a year, still delays or prevents any removal. Both are visible on chain
(`get_params`, the owner's balance and stake). Mints `total_supply` to `owner_id` (registering it) and emits an
NEP-141 `ft_mint` with memo `launch`.

```rust
fn set_policy(&mut self, rate_bps: i32, reasoning_hash: String)
```
Not payable. Runs `roll()` first, so the caller is checked against the chair as it stands after any
impeachment at the last boundary. Checks then run in this order and each panics with the quoted message:

| # | Check | Panic message |
| --- | --- | --- |
| 1 | `predecessor_account_id == chair` | `only the chair may set policy` |
| 2 | `reasoning_hash` is a SHA-256 digest: exactly 64 characters, each `0-9` or `a-f` | `reasoning_hash must be a SHA-256 digest: 64 lowercase hex characters` |
| 3 | no `set_policy` yet in the current epoch | `policy already set this epoch` |
| 4 | `-200 <= rate_bps <= 200` | `rate_bps out of bounds: must be within -200..=200` |
| 5 | `abs(rate_bps - rate_in_effect) <= 50` | `rate step too large: must move at most 50 bps from the current rate` |

`rate_in_effect` is the rate after any pending missed-epoch decay (see "Rollover"), so after a silent
stretch the step bound is measured from the decayed rate. Setting the same rate again in a later epoch is
valid. On success: state is updated, then `rate_decayed` events (one per missed epoch, oldest first),
then one `policy_set`. `reasoning_hash` is the **lowercase SHA-256 hex digest** (64 characters, no `0x`, no uppercase) of the chair's written reasoning, so the same text always yields the same string; the contract checks the format, not the preimage. (Before this version the contract accepted any 1..=128 bytes; `persona_hash` in `nominate` still does.) Events are emitted only after every check has passed, so a reverted call never
leaves an event in the logs.

NEP-141 and storage management, **[implemented]** in `token.rs`: `ft_transfer` and `ft_transfer_call` burn
under a negative rate (see "Transfer burn") and `ft_total_supply` includes mints that are due but not yet
applied; `ft_balance_of`, `ft_resolve_transfer`, `storage_deposit`, `storage_withdraw`,
`storage_unregister`, `storage_balance_bounds`, `storage_balance_of` and `ft_metadata` pass through to
`near-contract-standards`. `ft_balance_of` is the liquid balance only: staked tokens and unclaimed
rewards are not in it.

### Staking **[implemented]**

```rust
#[payable] fn stake(&mut self, amount: U128)
#[payable] fn unstake(&mut self, amount: U128)
#[payable] fn claim(&mut self) -> U128
```
All three run `roll()` first. `U128` amounts are decimal strings. A refused call changes nothing and logs
nothing.

`stake`: attach at least 1 yoctoNEAR. Moves `amount` from the caller's liquid balance into stake; the tokens
stay in `ft_total_supply`. The first stake of an account also pays for its stake record (about 80 bytes of
storage, measured by the contract at the current byte price, so the attached deposit must exceed it);
anything above `1 yocto + storage cost` is refunded. A top-up restarts the lock on the whole stake. If the
caller backs a candidate the backing grows by `amount` (`backed` event). Panics: `Requires attached deposit of
at least 1 yoctoNEAR`; `amount must be positive`; `The account doesn't have enough balance`; `The account X is
not registered` (the account must have done `storage_deposit`); `First stake: attach N yoctoNEAR to pay for the
stake record`.

`unstake`: attach exactly 1 yoctoNEAR. Moves `amount` of stake back to the liquid balance. **Lock decision:**
stake is locked for `STAKE_LOCK_EPOCHS = 2` epochs counting the one it was staked in (staked in epoch `e`,
`unstake` allowed from epoch `e + 2`; `get_staking.unlock_epoch`). A stake therefore sits through two
boundaries, so jumping in just before a rollover, taking a share and leaving just after it is impossible,
and so is lending votes for the instant they are counted. Pending reward is settled, not paid: it stays
claimable. If the caller backs a candidate the backing shrinks by `amount` at once (`unbacked` event).
Panics: `Requires attached deposit of exactly 1 yoctoNEAR`; `amount must be positive`; `no stake`;
`amount exceeds the staked balance`; `stake is locked until epoch N`; `The account X is not registered`
(an account that force-unregistered with stake left must `storage_deposit` again before it can unstake).

`claim`: attach exactly 1 yoctoNEAR. Pays the caller's settled plus pending reward from the reward pool into its
liquid balance and returns the amount. An internal move, not an `ft_transfer`, so the burn never touches it.
Panics: `nothing to claim` (no stake record, or nothing earned).
*Signature change from the first draft:* `claim` is `#[payable]` and requires 1 yocto, like every call that moves tokens.

Staked tokens are not transferable. The stake record is permanent (its storage was paid once, by its
owner); a fully unstaked account keeps it.

### Voting **[implemented]**

```rust
#[payable] fn nominate(&mut self, candidate: AccountId, persona_hash: String)
#[payable] fn back(&mut self, candidate: AccountId)   // attach exactly 1 yoctoNEAR
#[payable] fn unback(&mut self)                       // attach exactly 1 yoctoNEAR
#[payable] fn withdraw_nomination(&mut self, candidate: AccountId)
```
All four run `roll()` first. `back` and `unback` require exactly 1 yoctoNEAR (`Requires attached deposit of
exactly 1 yoctoNEAR`): the vote decides who sets the monetary policy, so a function-call key cannot move it,
only a key that can sign a deposit. *(Change from the earlier draft, where they took no deposit.)*

`nominate`: attach at least `max(nominate_bond, storage cost of the nomination)` yoctoNEAR. That amount is
escrowed as the bond (`get_candidates.bond`); the excess is refunded. The nomination lives in contract
state, so its storage is paid by the bond, and the bond is returned in full whenever the nomination ends (withdrawal,
eviction, or the end of an impeachment whoever wins). It can be held for a long time: any staker, even with 1
yocto, can keep a nomination from being withdrawn (`withdraw_nomination` below), and its bond then returns only at an
impeachment or an eviction. Decisions:
the sitting chair cannot be nominated; a candidate has at most one live nomination; the candidate account
need not exist or hold tokens, and `persona_hash` is not checked against anything, so a nominator can occupy a candidate
account with a nomination whose hash is wrong and nobody else can nominate that account while it stands; the nominator need not stake; at most `MAX_CANDIDATES = 10` are live. The
nominator's whole stake backs the new nomination at once, exactly as if it had called `back` (moving that stake
off whichever candidate it backed; a nominator with no stake adds no backing). When the list is full the
newcomer takes the slot of the least-backed nomination (the earliest nominated on a tie) if, and only if, the
nominator's own staked balance is strictly greater than that backing; that nomination ends, its bond is
refunded and `nomination_withdrawn` is logged. Otherwise the call is refused. A slot therefore costs more stake
than the one it takes, not a bond: ten accounts holding 1 yocto cannot freeze the list against a holder of 100
tokens, and an account with less stake than the least-backed nomination can never evict the honest one back.
Panics, in order: `persona_hash must be 1..=128 bytes`; `the sitting chair cannot be nominated`; `candidate is
already nominated`; `candidate list is full: stake more than N yoctoCHAIR to take the least-backed slot`;
`attach at least N yoctoNEAR: the bond, or the storage cost if that is higher`.

`back`: the caller's whole staked balance backs `candidate`; backing another candidate moves it; backing the
same one again is a no-op. Backing follows the stake: `stake` and `unstake` move it by the same amount, and
liquid tokens carry no vote. Panics: `stake first: only staked tokens can back a candidate`; `no such candidate`.
`unback`: removes it. Panics: `not backing anyone`.
`withdraw_nomination`: attach exactly 1 yoctoNEAR (it pays out NEAR). Nominator only, and only while no other
account backs it: it ends the nomination and returns the bond. "No other account" is computed as: the
candidate's `backing` equals the nominator's own `staked` when the nominator's stake backs this very nomination
(and 0 otherwise), because `backing` is the sum of the backers' stakes. Otherwise a nominator could wipe every
backer in the last block before a boundary and re-nominate the same account under a new id. Backers who leave
(`unback`, or `unstake`) free it, and while one stays, even with 1 yocto, the nomination cannot be withdrawn; if it ends by
impeachment or eviction the bond is refunded as usual. Panics:
`no such candidate`; `only the nominator may withdraw a nomination`; `other accounts back this candidate: it
can be withdrawn once their backing is gone`. A withdrawal after a vote was already won finds nothing to withdraw,
because `roll()` applies the impeachment first.

Backing is stored as a nomination id (never reused, from 1) in the backer's fixed-size stake record, so an
impeachment or withdrawal kills every backing in O(1): there is no sweep over stakers, and a stale backing
can neither count for a later nomination of the same account nor underflow it.

### Views

```rust
fn get_params(&self) -> Params                       // [implemented]
// { epoch_ms, start_ms, max_rate_bps, max_step_bps, impeach_threshold_bps, quorum_bps, nominate_bond }

fn get_supply(&self) -> SupplyLedger                 // [implemented]
// { epoch, launch_supply, minted, burned, total_supply, total_staked, reward_pool }  (all U128 except epoch)
// total_supply == launch_supply + minted - burned, at all times. `minted` counts every easing mint,
// including those due but not applied yet; `burned` counts the transfer burn, `ft_transfer_call` refunds
// when the sender unregistered mid-call, and balances destroyed by a forced `storage_unregister`.

fn get_policy(&self) -> PolicyView                   // [implemented]
// { epoch, rate_bps, chair, streak, last_set_epoch: Option<u64>, epoch_ends_ms }

fn get_staking(&self, account_id: AccountId) -> StakingView        // [implemented]
// { staked: U128, pending_reward: U128, backing: Option<AccountId>, unlock_epoch: u64 }

fn get_reward_pool(&self) -> RewardPoolView          // [implemented]
// { total_staked: U128, reward_pool: U128, reward_per_share: String }

fn get_candidates(&self) -> Vec<CandidateView>       // [implemented]
// { candidate, nominator, persona_hash, backing: U128, bond: U128 }, oldest nomination first
```
Every view is computed from the latest block time with pending rollover applied (decay, mints and a pending
impeachment included), so it is correct even if no transaction has touched the contract for many epochs:
after an impeaching boundary `get_policy.chair` is already the new chair and `get_candidates` is already
empty. `streak = epoch - chair_since_epoch`: complete epochs the sitting chair has held office.
`epoch_ends_ms = start_ms + (epoch + 1) * epoch_ms`. `reward_per_share` is a decimal string (the index does not fit
a JSON number); `reward_pool` is minted and not yet claimed, rounding remainders included.
*Additions to the first draft:* `StakingView.unlock_epoch`, and the views above project impeachment.

### Invariants

1. **Conservation.** At all times, and in every view,
   `ft_total_supply == sum(ft_balance_of) + total_staked + reward_pool`.
   The sandbox tests assert it after every scenario. `reward_pool` is the unclaimed mint: a minted token
   stays in the pool until its staker claims it; the rounding remainders stay in it forever.
2. Every method that mutates the policy, staking, backing, the supply or the chair calls `roll()` first, so a
   boundary always sees state as it stood at the boundary. `ft_transfer` and `ft_transfer_call` call it too
   (they read the rate), and so do `storage_unregister` (a forced close burns supply) and the private
   `ft_resolve_transfer` (a refund to a closed sender burns supply); a mint already due is never recomputed
   on a supply those two shrank. Staking right after a boundary cannot affect it; staking just before one buys nothing
   without the lock above.
3. `roll()` applies `EpochState::advance_to`, which generalizes `PolicyState::advance_to`. Work is bounded
   however long the contract sat idle: once the rate is 0 and no candidate beats the threshold and the quorum
   every later boundary is a no-op (`is_quiescent && no winner`), so the first boundary after a quiet stretch
   with such a candidate runs, and clears the candidates.
4. `roll()` collects events and every method logs them only after its last panic point, so a reverted call
   never leaves an event. A `roll()` that ends an impeachment refunds every bond as a NEAR transfer and
   logs one `nomination_withdrawn` per nomination after the rollover's other events.
5. No loop over stakers anywhere: per-staker work is O(1) and a call's cost is bounded by
   `MAX_CANDIDATES` and the 4-step decay.

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
   `reward_pool += minted`, `reward_per_share += minted * REWARD_SCALE / total_staked` (floor), with
   `REWARD_SCALE = 10^24` and 256-bit intermediates (the index itself is 256 bits: one staked yocto under a
   near-max mint exceeds `u128`). The floor remainder stays in the pool, never paid out. If `total_staked == 0`
   nothing is minted. A mint that rounds to 0 is not logged. A staker's pending reward is
   `staked * (reward_per_share - paid_per_share) / REWARD_SCALE` (floor) plus what was settled earlier; a stake
   change settles first, and a new stake starts from the current index, so it earns nothing from boundaries
   already passed. `total_staked` is the stake in place at the boundary.
2. **Decay.** If `last_set_epoch != Some(e)` (the chair did not act in `e`):
   `rate' = rate - signum(rate) * min(abs(rate), 50)`. Emits `rate_decayed {epoch: e, ...}`.
3. **Impeachment.** Among candidates with `backing * 10_000 > impeach_threshold_bps * total_staked` **and**
   `backing * 10_000 > QUORUM_BPS * total_supply` (both strictly greater; stake and supply as they stood before
   this boundary's mint, so the figures are the ones `get_supply` showed during epoch `e`), the one with the most backing wins (ties: nominated earliest, by nomination id). The winner becomes
   chair, `chair_since_epoch = e + 1` (streak resets to 0), all nominations and backings are cleared (bonds
   refunded), and `impeached` is emitted with `streak_ended = e + 1 - old chair_since_epoch`. The new chair may call
   `set_policy` in epoch `e+1`, even if the old chair already acted in `e`; the rate in effect is unchanged by
   the change of chair. Backing is counted only at boundaries; `backing <= total_staked` always, because backing
   follows stake.

Rounding, every formula (the contract never mints more than the exact value of any formula):

| Formula | Direction | Why |
| --- | --- | --- |
| `minted = supply * rate / 10_000` | down | never more than exact |
| `reward_per_share += minted * 10^24 / total_staked` | down | the remainder stays in the pool |
| `pending = staked * (index - paid) / 10^24` | down | stakers are never paid more than the pool holds |
| `burn = amount * abs(rate) / 10_000` | down | the SPEC vector (92.5875 burns 92); see Transfer burn |
| `backing * 10_000 > max(threshold * total_staked, 500 * total_supply)` | exact, no rounding | strict comparison in integers; no product overflows `u128` since `total_supply <= MAX_TOTAL_SUPPLY` and both rates are at most 10_000 |

Ordering consequences, worth restating because the simulator must match: a chair who acts in epoch `e` and
then goes silent keeps that rate for all of `e+1` (and mints at it at the end of `e+1`) and only then starts
to decay; the decay a missed epoch causes first applies to the epoch after it. Mint uses the pre-decay rate.

Bounded work: once `rate == 0` and no candidate beats the threshold and the quorum every later boundary is a no-op, so
`advance_to` jumps straight to the target epoch. From the largest rate that is at most `200 / 50 = 4`
decay steps, plus the one boundary a quiet stretch's impeachment needs.

### The mechanic without the chair

The rate rule is total: it is defined by contract code for every epoch, with or without a chair. Nothing
about it depends on a `set_policy` call arriving.

- The rate starts at 0 and stays 0 until a chair sets one.
- Every epoch in which no `set_policy` was accepted (the chair is silent, absent, locked out, or its key is
  gone) moves the rate 50 bps toward zero at the epoch's end (Rollover step 2) and never past it. A chair
  that last acted at 200 in epoch `e` leaves 200 in effect through `e+1` (see "Ordering consequences"), then
  150, 100, 50 and 0 in epochs `e+2` to `e+5`, and 0 from there on.
- At rate 0 nothing is minted or burned: transfers move whole amounts and no further epoch changes any
  balance. A token whose chair never acts is therefore an ordinary NEP-141 token with staking.
- Silence never removes the chair and never blocks anything: the chair may act again in any later epoch
  (the step bound is measured from the decayed rate), and holders can replace it by vote at any time.
- It costs nothing to be silent for a long time: rollover work is bounded (see "Bounded work"), and views
  already show the decayed rate before any transaction applies it.

Tested end to end in `sandbox-tests/tests/chair_rules.rs`
(`a_silent_chair_cannot_stall_the_token_the_rate_decays_to_zero_by_contract_code`): a chair climbs to 200,
goes silent, every view reports `200, 150, 100, 50, 0, 0, 0` over the next seven epochs, one transaction
then logs the four `rate_decayed` events, and transfers, staking and a new `set_policy` all work.

### Transfer burn **[implemented]**

When the rate in effect (after `roll()`) is negative, `ft_transfer(receiver, amount)` and
`ft_transfer_call` debit `amount` from the sender, credit `amount - burn` to the receiver, and burn
`burn = amount * abs(rate) / 10_000` (floor, so a transfer below `10_000 / abs(rate)` burns 0) from total supply.
For `ft_transfer_call`, `ft_on_transfer` is told `amount - burn` and `ft_resolve_transfer` resolves
against `amount - burn`, so a refund never returns the burn. Nothing is minted while the rate is negative.
Logs, in order: the rollover's events, NEP-141 `ft_transfer` for `amount - burn`, then (only if `burn > 0`)
`transfer_burned` and NEP-141 `ft_burn` for `burn` with memo `chair:tightening`. Every other NEP-141
rule is unchanged (1 yocto, `amount > 0`, receiver differs from sender, receiver registered).
`claim` and `unstake` are not transfers and never burn.

**Gas of `ft_transfer_call`.** `ft_resolve_transfer` runs `roll()` before it refunds, so a boundary that fell
during the call (a receiver can delay its answer by many blocks) is applied there, and its mints, decays and an
impeachment with up to ten bond refunds must fit in the resolver's gas or the sender would lose the refund.
The contract reserves `GAS_FOR_RESOLVE_TRANSFER = 30 Tgas` for it (`near-contract-standards` reserves 5, which is
not enough: a resolver that rolled a boundary with an impeachment burnt 6.3 Tgas in `resolver_gas.rs`). The
heaviest rollover possible (five mints, four decays, an impeachment refunding ten bonds, 64-character account
ids, 128-byte persona hashes) burns 5.3 Tgas and the resolver itself 2.2 (sandbox measurement, `gas_burnt`; the figures exclude about 0.22 Tgas of
prepaid execution fees per refund). A caller must therefore attach at least 35 Tgas, about 45 Tgas if the call may be
the first after an epoch boundary (its own receipt then pays for the roll), plus whatever `ft_on_transfer` needs. If the
gas cannot cover the resolver's 30 Tgas the call fails and nothing moves; a receiver left without enough gas fails, and
the sender is refunded. In `ft_resolve_transfer` the standard's refund event is logged before the rollover's
events: the library emits it inside the call that settles the refund, and the rollover's events are held until
no panic is left.

**Rounding decision, flagged.** Floor is what the worked vector requires (`12_345` at `-75` burns `92`, not
`93`), and it matches the simulator. It means a burn can be below the exact value by under one yocto. Ceiling
would burn the whole of any transfer under `10_000 / abs(rate)` yocto (at least 1 of every 1), which is a
worse failure than the sub-yocto leak, and would change a vector other lanes build on.

### Worked vectors (the simulator and the contract must agree)

| Case | Input | Result |
| --- | --- | --- |
| Mint | supply `1_000_001`, rate `33`, staked `500` | `minted = 3300` (3300.0033 floored) |
| Burn | amount `12_345`, rate `-75` | `burn = 92` (92.5875 floored) |
| Decay | rate `120`, chair silent after acting | in-effect `120`, then `70`, `20`, `0` |
| Decay | rate `-120` | `-120`, `-70`, `-20`, `0` |
| Step | in effect `-10` | `40` allowed, `41` rejected |
| Bounds | in effect `150` | `200` allowed, `201` rejected |

## No admin, no owner

After `new` there is no account with any power over the token. The exported surface of the deployed wasm
is closed and classified (the sandbox test `no_admin.rs` fails if a method appears that is not listed here):

| Kind | Methods |
| --- | --- |
| Views | `ft_balance_of`, `ft_metadata`, `ft_total_supply`, `get_candidates`, `get_params`, `get_policy`, `get_reward_pool`, `get_staking`, `get_supply`, `storage_balance_bounds`, `storage_balance_of`, `contract_source_metadata` |
| Open to anyone, acting on the caller's own tokens, stake, vote or nomination | `ft_transfer`, `ft_transfer_call`, `storage_deposit`, `storage_withdraw`, `storage_unregister`, `stake`, `unstake`, `claim`, `nominate`, `back`, `unback`, `withdraw_nomination` |
| Gated | `set_policy` (the chair only, bounded), `ft_resolve_transfer` (the contract itself), `new` (once) |

There is no method that sets, replaces or removes the chair, changes a parameter, mints, burns, upgrades
or withdraws anyone's NEAR or tokens. The chair changes in exactly one way: the stake vote at an epoch
boundary (Voting, Rollover step 3). Every parameter is fixed in `new` or is a constant in the code.
`owner_id` is only the account `new` credits with the supply: it has no other role. The sandbox tests prove
this against the deployed wasm with the owner and the deployer calling every administrative-sounding name
(all `MethodNotFound`), calling `new` again, `set_policy` and the private resolver (each refused), and a
non-holder trying to turn a nomination into a vote. The one thing that could still change the code is a
key on the token account, so the deploy procedure never creates one (see "Deploying"): `launch` in the
test harness does exactly that and a test shows a key claiming to be the account signing nothing
(`AccessKeyNotFound`) and the account holding no key at all.

## Events

NEP-297. Every event is logged as `EVENT_JSON:{"standard":"chair","version":"1.0.0","event":"<name>","data":{...}}`.
`standard` is `chair` for the events below; supply changes also emit the NEP-141 `ft_mint` / `ft_burn`
events (`nep141`) with memo `chair:easing`, `chair:tightening` or `launch`, so generic indexers track supply.
The contract account is the custodian of stake and unclaimed rewards as far as those events go: `epoch_minted`
also logs `ft_mint` to the contract account, `stake` / `unstake` / `claim` log `ft_transfer` to / from it
(memos `chair:stake`, `chair:unstake`, `chair:claim`), so event-derived balances reconcile with
`ft_total_supply`.
`data` is a JSON object; `u128` amounts are decimal strings, other numbers are JSON numbers.

**The public log of every mint and burn.** Every change of supply emits one NEP-141 event with its cause in
`memo`, and all but the launch mint, a forced `storage_unregister` and a refund burn also emit a chair event
with its amount and epoch (the table says which); summing the NEP-141 events reproduces `get_supply`
(`ledger.rs` asserts it):

| Supply change | chair event (`standard: "chair"`) | NEP-141 event (`standard: "nep141"`, `version: "1.0.0"`) |
| --- | --- | --- |
| Launch mint | none (see `get_params.start_ms`, `get_supply.launch_supply`) | `ft_mint` `[{"owner_id":OWNER,"amount":"N","memo":"launch"}]` |
| Easing epoch mint | `epoch_minted` `{"epoch":E,"rate_bps":R,"amount":"N","total_staked":"S","reward_per_share":"I"}` | `ft_mint` `[{"owner_id":TOKEN,"amount":"N","memo":"chair:easing"}]` |
| Transfer burn | `transfer_burned` `{"epoch":E,"rate_bps":R,"account_id":A,"amount":"SPENT","burned":"N"}` | `ft_burn` `[{"owner_id":A,"amount":"N","memo":"chair:tightening"}]` |
| Forced `storage_unregister` | none | `ft_burn` `[{"owner_id":A,"amount":"N","memo":"storage_unregister"}]` |
| `ft_transfer_call` refund after the sender unregistered mid-call | none | `ft_burn` `[{"owner_id":RECEIVER,"amount":"N","memo":"refund"}]` |

`get_supply` is the running total of the same ledger: `launch_supply + minted - burned == total_supply`.

| Event | `data` | Emitted by |
| --- | --- | --- |
| `policy_set` | `chair, epoch, rate_bps, previous_rate_bps, reasoning_hash` | `set_policy` **[implemented]** |
| `rate_decayed` | `epoch, previous_rate_bps, rate_bps` | any rollover step 2 **[implemented]** |
| `epoch_minted` | `epoch, rate_bps, amount, total_staked, reward_per_share` (decimal string) | step 1; `amount` is the mint into the pool |
| `transfer_burned` | `epoch, rate_bps, account_id, amount, burned` (`amount` is what the sender spent) | `ft_transfer`, `ft_transfer_call`, only if `burned > 0` |
| `staked` / `unstaked` | `account_id, amount, total_staked` | `stake` / `unstake` |
| `claimed` | `account_id, amount` | `claim` |
| `nominated` | `candidate, nominator, persona_hash, bond` | `nominate` |
| `backed` / `unbacked` | `account_id, candidate, amount` | `back` / `unback`, and `stake` / `unstake` of a backer (`amount` is the change) |
| `nomination_withdrawn` | `candidate, nominator, bond` | `withdraw_nomination`, an eviction by a full list, and every nomination an impeachment clears |
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
test runs through it. This confines only the **launch** chair. A chair seated later by the stake vote is the
account the stakers backed and can hold any key; the contract still gives it no method beyond `set_policy`.

## Deploying

`new` is open to whoever calls it first on a deployed, uninitialized contract, and a leftover full-access
key could redeploy the code. So the token account is created, deployed and initialized in **one transaction**
signed by a parent account, and is never given a key:

1. `CreateAccount`, `Transfer` (storage and gas), `DeployContract` (the wasm), `FunctionCall new {...}`, in
   that order, in one transaction whose receiver is the new token account. No `AddKey` action.
2. Nothing else touches the account first, because it does not exist before that transaction. If any action
   fails the whole transaction fails and the account never exists.

The result has no access key at all, so nobody can redeploy it, add a key or move its NEAR: the no-admin,
no-upgrade guarantee. The sandbox harness (`launch_with_supply`) deploys exactly this way, and
`no_admin.rs` shows the account has no key and that no key can sign for it. `deploy/` does the same on testnet (`deploy/README.md`).
