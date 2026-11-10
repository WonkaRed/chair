# $CHAIR

A memecoin whose monetary policy is set by an AI chair that the contract keeps on a short leash, and that holders can fire.

Built for the NEAR Hackathon "Build Beyond Boundaries", track **Memecoins With Mechanics**. The mechanic lives in the contract, not in a backend somebody could switch off.

**Status: work in progress, scaffold plus the first vertical slice.** What runs today is marked in the table below; everything else is specified in [`SPEC.md`](SPEC.md) and not yet written. This README states only what the code does.

| Piece | Status |
| --- | --- |
| NEP-141 token, launch parameters, views, epochs | works, tested |
| `set_policy` with hard bounds and missed-epoch decay | works, tested in a real NEAR sandbox |
| Function-call-key-only chair | works, tested |
| Staking, rewards, transfer burn, impeachment | specified, not implemented |
| Chair agent (rule-based and LLM), simulator, web page | stubs |

## What it is

$CHAIR is a NEP-141 token on NEAR. Time is cut into epochs of fixed length. Once per epoch the current **chair** account may call `set_policy(rate_bps, reasoning_hash)`:

- A positive rate **eases**: at the end of the epoch the contract mints `total_supply * rate / 10_000` into a reward pool paid to stakers.
- A negative rate **tightens**: during that epoch every transfer burns `|rate|` bps of the amount, and nothing is minted.
- The chair is an AI. The contract does not trust it: the rate is bounded, the step is bounded, and a chair that goes silent decays toward zero.
- Stakers can nominate and back a replacement. A candidate with enough backing becomes chair at the next epoch rollover, and the chair's streak resets.

Every launch parameter is set once in `new()` and readable by a view method. There is no admin or owner method and no upgrade path.

## Quick start

Needs `git`, `make`, `curl`, a C/C++ compiler, [rustup](https://rustup.rs), and network access (crates, and the NEAR sandbox binary, which the first test run downloads into the build directory). Linux needs glibc 2.39 or newer (Ubuntu 24.04, Debian 13, Fedora 40 or later), because that is what the NEAR sandbox binary is linked against; macOS needs Apple silicon. No API keys, no wallet, no account.

```sh
git clone TODO-REPO-URL chair && cd chair
rustup toolchain install     # installs the toolchain pinned in rust-toolchain.toml
make test                    # contract unit tests, then the sandbox tests against the real wasm
make demo                    # the chair's leash, narrated, against a local NEAR sandbox
```

Or, with only Docker installed (the build fails unless `make test` passes):

```sh
docker build -t chair . && docker run --rm chair   # runs `make demo`
```

The first `make test` compiles the NEAR dependency tree and downloads the sandbox: 5 to 13 minutes (781 s measured cold from a clean copy on a loaded 16-core machine). Later runs take under a minute (37 s measured). It ends with:

```
test result: ok. 19 passed; 0 failed; ...      # contract/ unit tests (policy math, launch checks)
test result: ok. 9 passed; 0 failed; ...       # sandbox-tests/ against the real wasm
```

`make demo` prints the chair setting rates for four epochs, then being refused four ways (second decision in an epoch, a non-chair caller, a rate above 200 bps, a 90 bps jump), then `ft_transfer` being refused to its key, then two silent epochs decaying the rate with the decay events, and ends with `PASS: every bound held`. It exits non-zero if the contract ever behaves differently from what it prints.

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
| `impeach_threshold_bps` | set at launch, 1 to 10000 | Share of total staked a candidate's backing must exceed |
| `nominate_bond` | set at launch, above 0 | Bond in yoctoNEAR attached to `nominate` |
| first chair, initial supply | set at launch | `chair`, and `total_supply` credited to `owner_id` |

What the contract enforces on every `set_policy`, each with its own panic message (in order): the caller is the chair; the reasoning hash is 1 to 128 bytes; no decision was made yet this epoch; the rate is within bounds; the step from the rate in effect is at most 50 bps. A rejected call changes nothing and emits no event.

Rollover is integer arithmetic with floor rounding, specified exactly in [`SPEC.md`](SPEC.md) with worked vectors. Of the mechanic, the code has epochs, `set_policy`, its bounds and the missed-epoch decay; minting, the transfer burn, staking and impeachment are specified there and not yet written.

## What the chair can and cannot do

Can:
- Choose one rate per epoch within the bounds. That is the entire surface.
- Record a hash of its reasoning, which is emitted on-chain with the decision.

Cannot:
- Exceed 200 bps either way, or move more than 50 bps per epoch. The contract panics.
- Decide twice in one epoch, or decide as anyone but the chair.
- Change any parameter, mint directly, burn directly, move anyone's tokens, or upgrade the contract. No such method exists.
- Do anything but `set_policy` with its key. The chair account holds only a function-call access key limited to `set_policy` on the token contract, never a full-access key. The protocol refuses any other method before the contract runs (`MethodNameMismatch`), and a function-call key cannot attach a deposit. This is account setup, in addition to the contract's own check of the caller. The sandbox tests perform the setup in code (`Chair::scoped_chair`) and prove both halves; the equivalent `near` CLI commands are in [`SPEC.md`](SPEC.md) ("The chair's key"), with flags checked against `near --help` but not run against a live network.
- Stay in office by silence: a chair that misses epochs sees the rate decay to zero.

## Technologies used on NEAR

- NEP-141 fungible token, NEP-148 metadata and NEP-145 storage management, via `near-contract-standards` 5.30.1
- NEP-297 events for every policy decision (more as the features land)
- `near-sdk` 5.30.1, built with `cargo-near-build` 0.11.5 (the library behind `cargo near build`)
- Function-call access keys, to confine the chair
- `near-workspaces` 0.24.0 with `near-sandbox` running nearcore 2.14.0, pinned in `sandbox-tests/src/lib.rs`
- Rust 1.95.0, pinned in `rust-toolchain.toml`: the minimum supported version of near-sdk 5.30.1 and the version its own CI builds contracts with, verified here to produce wasm the 2.14.0 sandbox accepts (1.98.1 was also verified)

## Sybil and other limits

Stated plainly:

- **Impeachment is weighted by stake, not by person.** Anyone can split tokens across accounts at no cost, so splitting gains nothing, but a holder with enough tokens can unseat the chair alone. The defence is economic: the threshold is a share of staked supply, and nominating costs a bond. Neither stops a whale, and nothing here claims to.
- **Nominations are spam-limited by a bond only.** A bond in NEAR makes spam cost money; it does not make candidates good.
- **Initial distribution is whatever `owner_id` does with the whole supply.** The mechanic does not design distribution.
- **The chair is trusted with a small, bounded lever.** Once easing lands, at most 2% of supply per epoch can be minted, and a compromised chair key can do nothing but `set_policy` within the bounds. The reasoning hash is a commitment, not a proof of anything: the contract cannot tell whether an AI, a person or a script made the decision.
- **Time is block time.** Validators can skew it by seconds, not by epochs.
- **Rollover is lazy.** NEAR has no cron, so an epoch boundary is applied by the first call after it. Views show the correct current state; events for earlier epochs are logged when the next call arrives.
- **Not audited.** Tested in a local sandbox only. Not deployed to testnet or mainnet by this repository yet.
- **The "no upgrade path" guarantee needs one deployment step**: delete every access key on the token account after deploy. The code has no upgrade or admin method, but a leftover full-access key could still redeploy it.

## AI-generated code disclosure

All code in this repository was written by AI coding agents (Claude, via Claude Code), directed and reviewed by the human submitter. Disclosed per hackathon rule Q-005. Libraries used are listed under "Technologies used on NEAR" and in the `Cargo.toml` files; there is no pre-hackathon code in this repository.

## Sister project

The submitter's other, independent entry in this hackathon is **Preflight**: TODO-PREFLIGHT-URL. The two projects share no code and are submitted separately, per rule Q-015.

## Layout

| Directory | Contents | Spec |
| --- | --- | --- |
| `contract/` | the token | [`SPEC.md`](SPEC.md) |
| `sandbox-tests/` | near-workspaces tests and `make demo` | |
| `chair-agent/` | stub: rule-based and LLM chair (TypeScript) | |
| `sim/` | stub: 60-epoch supply simulator | |
| `web/` | stub: static page | |

MIT licensed, see [`LICENSE`](LICENSE).
