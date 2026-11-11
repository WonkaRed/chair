# $CHAIR

A memecoin whose monetary policy is set by an AI chair that the contract keeps on a short leash, and that holders can fire.

Built for the NEAR HACKATHON, track **Memecoins With Mechanics**. The mechanic lives in the contract, not in a backend somebody could switch off.

**Status: the contract is complete and tested; the web page is not built yet.** What runs today is marked in the table below. [`SPEC.md`](SPEC.md) is the interface every part is held to, and this README states only what the code does.

| Piece | Status |
| --- | --- |
| NEP-141 token, launch parameters, views, epochs | works, tested |
| `set_policy` with hard bounds, a SHA-256 reasoning hash and missed-epoch decay | works, tested in a real NEAR sandbox |
| Function-call-key-only chair | works, tested |
| Staking and rewards (epoch mint into a reward pool, locked stake), transfer burn, nomination, backing and impeachment by stake vote | works, tested in a real NEAR sandbox |
| No admin: the deployer and the owner have no power after `new` | works, tested against the deployed wasm |
| Supply ledger view and a mint/burn event for every supply change | works, tested |
| Chair agent (rule-based and LLM) in `chair-agent/`, supply simulator in `sim/` | built, with their own tests |
| Web page | not built yet |

## What it is

$CHAIR is a NEP-141 token on NEAR. Time is cut into epochs of fixed length. Once per epoch the current **chair** account may call `set_policy(rate_bps, reasoning_hash)`:

- A positive rate **eases**: at the end of the epoch the contract mints `total_supply * rate / 10_000` into a reward pool paid to stakers.
- A negative rate **tightens**: during that epoch every transfer burns `|rate|` bps of the amount, and nothing is minted.
- The chair is an AI. The contract does not trust it: the rate is bounded, the step is bounded, and a chair that goes silent decays toward zero.
- Stakers can nominate and back a replacement. A candidate whose backing exceeds both the threshold (a share of the staked tokens) and a 5% quorum of the whole supply becomes chair at the next epoch rollover, and the chair's streak resets. Below the quorum nobody can be seated, however little is staked.

Every launch parameter is set once in `new()` and readable by a view method. There is no admin or owner method and no upgrade path.

## Quick start

Needs `git`, `make`, `curl`, a C/C++ compiler, [rustup](https://rustup.rs), and network access (crates, and the NEAR sandbox binary, which the first test run downloads into the build directory). Linux needs glibc 2.39 or newer (Ubuntu 24.04, Debian 13, Fedora 40 or later), because that is what the NEAR sandbox binary is linked against; macOS needs Apple silicon. No API keys, no wallet, no account.

```sh
git clone TODO-REPO-URL chair && cd chair
rustup toolchain install     # installs the toolchain pinned in rust-toolchain.toml
make test                    # unit tests, the sandbox tests against the real wasm, then the agent and simulator tests
make demo                    # the chair's leash, narrated, against a local NEAR sandbox
```

Or, with only Docker installed (the build fails unless `make test` passes):

```sh
docker build -t chair . && docker run --rm chair   # runs `make demo`
```

The first `make test` compiles the NEAR dependency tree and downloads the sandbox: 5 to 13 minutes (781 s measured cold from a clean copy on a loaded 16-core machine). Later runs skip the compile and the download; each sandbox test boots its own chain, so the sandbox lane is the slow part (one file at a time: `staking` about 20 s, `chair_rules` about 130 s, the others 12 to 62 s). The harness starts the sandbox node itself with a lowered skip-approval cap, because nearcore 2.14's fast-forward can lose a jump under CPU load and the default cap made each lost jump cost about 111 s; with it, a loss costs about 13 s. Measured with 40 busy loops running: `staking` 23 to 37 s in 5 of 5 runs, `chair_rules` 182 to 196 s in 4 of 6 runs. The other two `chair_rules` runs failed with `Sandbox failed to fast forward: error sending request`, a transport error whose cause is not known: rerun it. The contract and sandbox lanes end with:

```
test result: ok. 61 passed; 0 failed; ...      # contract/ unit tests (policy math, rollover, rewards, launch checks, withdrawal)
test result: ok. 49 passed; 0 failed; ...      # sandbox-tests/ against the real wasm, in 9 files
```

Root `make demo` runs three demos in order and exits non-zero if any of them fails.

1. The sandbox demo (`sandbox-tests/examples/demo.rs`) prints the chair setting rates for four epochs, then being refused four ways (second decision in an epoch, a non-chair caller, a rate above 200 bps, a 90 bps jump), then `ft_transfer` being refused to its key, then two silent epochs decaying the rate with the decay events, then a mint epoch paying a staker, a burn epoch destroying part of a transfer, and an impeachment seating a new chair by stake vote. It ends with `PASS: every bound held`, the last line of the sandbox part, and it exits non-zero if the contract ever behaves differently from what it prints.
2. The chair agent demo (`chair-agent/`) runs the shipped rule chair against a model of the contract for 14 decisions and ends with `PASS: every decision stayed inside the bounds and every hash matches its logged text`.
3. The simulator (`sim/`) prints one table per scenario (12 of them, from an honest chair to an impeachment with a silent successor and the staking-share variants) and ends by writing `sim/out/scenarios.json`. Its last line is `wrote .../sim/out/scenarios.json`, not a `PASS` line.

`make build` writes the deployable `contract/res/chair_token.wasm`, using the same in-process `cargo near build` pipeline the tests use. No `cargo-near` CLI is needed.

Offline sandbox: set `NEAR_SANDBOX_BIN_PATH` to a `near-sandbox` 2.14.0 binary to skip the download.

## The mechanic and its hard limits

Parameters, all fixed at `new()` and returned by `get_params`:

| Parameter | Value | Meaning |
| --- | --- | --- |
| `epoch_ms` | set at launch, 1 second to 1 year | Epoch length. Demos use 30 seconds, production a day |
| `start_ms` | block time at launch | Epoch 0 starts here |
| `max_rate_bps` | **200**, a constant in the code | The chair's rate must satisfy `-200 <= rate_bps <= 200` |
| `max_step_bps` | **50**, a constant in the code | `abs(rate_bps - rate_in_effect) <= 50`; a missed epoch moves the rate 50 toward zero |
| `impeach_threshold_bps` | set at launch, 1 to 5000 | Share of total staked a candidate's backing must exceed |
| `quorum_bps` | **500**, a constant in the code | Share of the whole supply (staked or not) a candidate's backing must also exceed |
| `nominate_bond` | set at launch, 1 yoctoNEAR to 100 NEAR | Bond in yoctoNEAR attached to `nominate` |
| first chair, initial supply | set at launch | `chair`, and `total_supply` credited to `owner_id` |

What the contract enforces on every `set_policy`, each with its own panic message (in order): the caller is the chair; the reasoning hash is a SHA-256 digest (64 lowercase hex characters); no decision was made yet this epoch; the rate is within bounds; the step from the rate in effect is at most 50 bps. A rejected call changes nothing and emits no event.

Rollover is integer arithmetic with floor rounding, specified exactly in [`SPEC.md`](SPEC.md) with worked vectors. The whole mechanic is in the contract: epochs, `set_policy` and its bounds, the missed-epoch decay, the epoch mint to stakers, the transfer burn, staking with a two-epoch lock, and nomination, backing and impeachment. Without a chair the rule is still total: the rate decays 50 bps per silent epoch to zero and stays there, where nothing is minted or burned. `get_supply` returns the supply ledger (launch supply, total minted, total burned) and every mint and burn emits an event with its amount and epoch.

## What the chair can and cannot do

Can:
- Choose one rate per epoch within the bounds. That is the entire surface.
- Record a hash of its reasoning, which is emitted on-chain with the decision.

Cannot:
- Exceed 200 bps either way, or move more than 50 bps per epoch. The contract panics.
- Decide twice in one epoch, or decide as anyone but the chair.
- Change any parameter, mint directly, burn directly, move anyone's tokens, or upgrade the contract. No such method exists.
- Do anything but `set_policy` through the contract: the contract gives the chair no other method, and the chair is not the owner of anything. The **launch** chair is further confined by account setup: it holds only a function-call access key limited to `set_policy` on the token contract, never a full-access key, so the protocol refuses any other method before the contract runs (`MethodNameMismatch`) and the key cannot attach a deposit. A chair seated later **by vote** is whatever account the stakers chose and may hold any key; it is an ordinary account that can also call the public methods, as anyone can. The sandbox tests perform the launch setup in code (`Chair::scoped_chair`) and prove both halves; the equivalent `near` CLI commands are in [`SPEC.md`](SPEC.md) ("The chair's key"), with flags checked against `near --help` but not run against a live network.
- Stay in office by silence: a chair that misses epochs sees the rate decay to zero.

## Technologies used on NEAR

- NEP-141 fungible token, NEP-148 metadata and NEP-145 storage management, via `near-contract-standards` 5.30.1
- NEP-297 events for every policy decision, mint, burn, stake, claim, nomination and impeachment
- `near-sdk` 5.30.1, built with `cargo-near-build` 0.11.5 (the library behind `cargo near build`)
- Function-call access keys, to confine the chair
- `near-workspaces` 0.24.0 with `near-sandbox` running nearcore 2.14.0, pinned in `sandbox-tests/src/lib.rs`
- Rust 1.95.0, pinned in `rust-toolchain.toml`: the minimum supported version of near-sdk 5.30.1 and the version its own CI builds contracts with, verified here to produce wasm the 2.14.0 sandbox accepts (1.98.1 was also verified)

## Sybil and other limits

Stated plainly:

- **Impeachment is weighted by stake, not by person.** Anyone can split tokens across accounts at no cost, so splitting gains nothing, but a holder with enough tokens can unseat the chair alone. The defence is economic: a candidate needs backing above both the threshold share of the *staked* tokens and 5% of the *whole* supply, and nominating costs a bond. Neither stops a whale, and nothing here claims to.
- **The quorum is what keeps a tiny stake from seating a chair.** Without it, one yocto staked and backed would be 100% of the stake. With it, nobody can be seated while less than 5% of the supply backs them. So the token's owner should stake at launch; until over 5% of the supply is staked and backed, the launch chair cannot be replaced.
- **A coordinated bloc beats a larger, scattered majority.** The sitting chair cannot be nominated, so it can never be backed against a challenger. A bloc holding more than the threshold (30% in the demo and tests) of the staked tokens can seat its candidate even if the other 70% would have kept the chair, unless those 70% back a rival; backing is one candidate per staker.
- **Mints go only to stakers, so people who never stake are diluted.** At the maximum rate, +200 bps (reached four epochs after the first easing decision, in +50 steps), supply grows about 1.76 times in 30 daily epochs and about 1337 times in 365. The supply cap `u128::MAX / 10_000` would be reached after about 878 epochs from a launch supply of 10^27 yocto. A holder who neither stakes nor claims keeps the same token count and a shrinking share. The opposite lever, -200 bps, burns 2% of every transfer.
- **Staking just in time earns every boundary.** Stake in the last block of an epoch, unstake when the two-epoch lock ends, stake again in the last block before the next boundary, and repeat: that account is liquid for about half of each cycle and still earns at every boundary. It dilutes no one beyond a continuous staker of the same size, but the lock does not force holders to stay.
- **A nomination cannot be withdrawn out from under its backers.** `withdraw_nomination` is refused while any account other than the nominator backs the candidate (the candidate's backing is more than the nominator's own stake on it), so a nominator cannot wipe the backing in the last block and re-nominate. The bond still comes back when the nomination ends by impeachment or eviction.
- **Nominations are spam-limited by a bond and by stake.** A bond in NEAR makes spam cost money. A full list of ten gives a slot only to a nominator whose own stake exceeds the backing of the least-backed nomination, so ten accounts holding 1 yocto cannot lock the list against a real holder. Freezing it against everyone costs ten accounts that each stake more than the largest honest staker (a little over ten times that stake, which must stay staked to hold the slots, though it keeps earning the mint); stakers who want a slot can pool their tokens into one account. It does not make candidates good.
- **Initial distribution is whatever `owner_id` does with the whole supply.** The mechanic does not design distribution.
- **The chair is trusted with a small, bounded lever.** At most 2% of supply per epoch can be minted, and the launch chair's key can do nothing but `set_policy` within the bounds. The reasoning hash is a commitment, not a proof of anything: the contract cannot tell whether an AI, a person or a script made the decision.
- **Time is block time.** For epochs of a minute or more, validators can skew it by seconds, not by epochs.
- **Rollover is lazy.** NEAR has no cron, so an epoch boundary is applied by the first call after it. Views show the correct current state; events for earlier epochs are logged when the next call arrives.
- **Not audited.** Tested in a local sandbox only. Not deployed to testnet or mainnet by this repository yet.
- **The "no upgrade path" guarantee needs the documented deployment**: one transaction, signed by a parent account, that creates the token account, deploys the wasm and calls `new`, and adds no key ([`SPEC.md`](SPEC.md) "Deploying"). `new` is callable by anyone on a deployed but uninitialized contract, so a separate deploy and `new` could be front-run, and a leftover full-access key could redeploy the contract. The sandbox tests launch it exactly this way.
- **`new` bounds two parameters, not everything**: the threshold is at most 50% of the stake and the bond at most 100 NEAR, so those two can never make the chair unremovable, and the supply cannot be launched to the token account itself. A launch can still make the chair permanent in two ways the code does not stop: it can park the supply with an `owner_id` that never stakes (the quorum is 5% of the supply), or set an epoch as long as a year. Both are visible before anyone buys: `get_params` shows the epoch length and the owner's balance and stake show where the supply sits.

## AI-generated code disclosure

All code was written by AI agents (Claude Fable 5.2, Opus 5.5 and Sonnet 5.5, Anthropic).

## Sister project

The submitter's other, independent entry in this hackathon is **Preflight**: TODO-PREFLIGHT-URL. The two projects share no code and are submitted separately, per rule Q-015.

## Layout

| Directory | Contents | Spec |
| --- | --- | --- |
| `contract/` | the token | [`SPEC.md`](SPEC.md) |
| `sandbox-tests/` | near-workspaces tests and `make demo` | |
| `chair-agent/` | the chair: rule-based and LLM (TypeScript) | [`SPEC.md`](SPEC.md) |
| `sim/` | 60-epoch supply simulator (TypeScript) | [`SPEC.md`](SPEC.md) |
| `web/` | not built yet | |

MIT licensed, see [`LICENSE`](LICENSE).
