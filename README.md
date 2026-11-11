# $CHAIR

A NEP-141 memecoin on NEAR whose mint and burn rate is set once per epoch by a chair account, built for an AI agent, inside limits the contract enforces. The contract has no admin or upgrade method, and stakers can replace the chair by a vote weighted by stake.

Built for the NEAR HACKATHON, track **Memecoins With Mechanics**. The mechanic lives in the contract, not in a backend somebody could switch off.

## It runs on NEAR testnet

Token: [`token.chair-coin-2.testnet`](https://testnet.nearblocks.io/address/token.chair-coin-2.testnet), epochs of 90 s, launch supply 1,000,000. The token account was created, given its code and initialised in one transaction that adds no key, so it has no access key and nobody can upgrade it or move its NEAR.

- Accepted `set_policy` by the chair, +40 bps: [`BCzfFZzx...`](https://testnet.nearblocks.io/txns/BCzfFZzxc4E7rnAhTBXTmGSZetmYhPt9uFG4PDYqAyQB)
- The same chair asking for +201 bps, refused by the contract ("rate_bps out of bounds"): [`Efagw855...`](https://testnet.nearblocks.io/txns/Efagw855yoDeJXjNyui9Bt9d4JXfhisMoTm9JCPkHWjf)
- The impeachment: stakers backing 400,000 of 400,000 staked tokens seat `challenger.chair-coin-2.testnet`; the contract applies the vote in the first call after the boundary, [`CvqCjCU3...`](https://testnet.nearblocks.io/txns/CvqCjCU3ngrttKnZotBwPzczw6aVHTpkwPEZnYwwZqoD) (its `impeached` event)
- The chair's key can call `set_policy` and nothing else: the protocol refuses any other method signed with it (`MethodNameMismatch`, no transaction exists to link; the run log shows it).

Two agents from `chair-agent/` have held the seat as the seated challenger. The rule-based chair ran three epochs. Then an AI model chaired six epochs (18 to 23): `qwen3.8-27b`, running on the submitter's own GPUs through a local server, with no cloud API and no Claude model involved. Each epoch it read the on-chain numbers, chose a rate (10, 10, 10, 20, 20, 20 bps) and wrote its reasoning. The SHA-256 of that text is in each transaction, for example [`BnKWCcp3...`](https://testnet.nearblocks.io/txns/BnKWCcp3wG1do9PSw4AVEMvLrfvaL66xVNK2TPMDruzj) (epoch 22), and equals the hash of the text saved in [`docs/testnet-run-agent-llm-decisions.jsonl`](docs/testnet-run-agent-llm-decisions.jsonl) for all six. None fell back to the rule. The contract held the model to the same bounds as anyone else; its reasoning is recorded, not vouched for. The same model chaired six more epochs (38 to 43, rates 0, 0, 0, 0, -10, -10 bps) while the demo video was recorded, for example [`AUmvPMwR...`](https://testnet.nearblocks.io/txns/AUmvPMwRt9HnXDZmcKHzbF2hZejL4j4RyznqPkXNTLte) (epoch 43). No agent is running now, so the contract decays the rate toward zero.

The page reads the live token (`make -C web serve`, then open http://127.0.0.1:8080/; needs Node 22.22.2 or newer and npm). It lists every mint and burn and checks the sums against the contract's own `get_supply`.

Re-check the deployment read-only. It needs no key and no Rust build, only `git`, `make`, npm, Node 22.22.2 or newer and network access, and took 5 to 8 s here (it installs the 72 packages of `deploy/` first):

```sh
git clone https://github.com/WonkaRed/chair.git && cd chair && make -C deploy verify
```

It ends with (the `now:` line is the live state and moves):

```
PASS  hard bounds: rate within +-200 bps, step at most 50 bps, backing over 5% of the supply to seat a chair
      max_rate_bps 200, max_step_bps 50, quorum_bps 500
PASS  launch parameters are the recorded ones
      epoch_ms 90000, impeach_threshold_bps 3000, nominate_bond 100000000000000000000000
PASS  launch supply is the recorded one
      1000000000000000000000000000000
PASS  total supply = launch + minted - burned
      1122690925889010593978413132578 = 1000000000000000000000000000000 + 122700925889010593978413132578 - 10000000000000000000000000
PASS  ft_total_supply equals get_supply.total_supply
      1122690925889010593978413132578
PASS  recorded accounts' balances and stake never exceed the supply
      recorded accounts hold 1072513614741684519768000000000, unclaimed rewards 50177311147326074210413132578, supply 1122690925889010593978413132578 (the rest is in accounts not in the record)

now: epoch 14: rate 35 bps, chair challenger.chair-coin-2.testnet, streak 3; supply 1122690925889010593978413132578 (launch 1000000000000000000000000000000, minted 122700925889010593978413132578, burned 10000000000000000000000000), staked 400000000000000000000000000000

OK: 11 checks passed
```

Every transaction of the scripted run, with its hash, is in [`docs/testnet-deployment.json`](docs/testnet-deployment.json); the run logs are `docs/testnet-run-*.txt`. How it was deployed and how to redeploy: [`deploy/README.md`](deploy/README.md).

## What it is

$CHAIR is a NEP-141 token on NEAR. Time is cut into epochs of fixed length. Once per epoch the current **chair** account may call `set_policy(rate_bps, reasoning_hash)`:

- A positive rate **eases**: at the end of the epoch the contract mints `total_supply * rate / 10_000` into a reward pool paid to stakers.
- A negative rate **tightens**: during that epoch every transfer burns `|rate|` bps of the amount, and nothing is minted.
- The chair seat is built for an AI agent. The contract does not trust whoever holds it: the rate is bounded, the step is bounded, and a chair that goes silent decays toward zero.
- Stakers can nominate and back a replacement. A candidate whose backing exceeds both the threshold (a share of the staked tokens) and a 5% quorum of the whole supply becomes chair at the next epoch rollover, and the chair's streak resets. Below the quorum nobody can be seated, however little is staked.

Every launch parameter is set once in `new()` and readable by a view method. There is no admin or owner method and no upgrade path.

## Run the tests and the demos

Needs a Linux x86-64 machine (the only platform tried) with glibc 2.39 or newer, because that is what the NEAR sandbox binary is linked against (Ubuntu 24.04, Debian 13, Fedora 40 or later); `git`, `make`, `curl`, a C/C++ compiler; [rustup](https://rustup.rs) (the compiler, 1.95.0, is pinned by `rust-toolchain.toml`); Node 22.22.2 or newer with npm (the highest `engines` floor of `deploy/` and `chair-agent/`; `sim/` asks for 22); and network access (crates, npm packages, and the sandbox binary, which the first test run downloads into the build directory). No API keys, no wallet, no account.

```sh
git clone https://github.com/WonkaRed/chair.git chair && cd chair
rustup toolchain install     # installs the toolchain pinned in rust-toolchain.toml
make test                    # unit tests, the sandbox tests against the real wasm, then the agent, simulator and web tests
make -C deploy test          # the testnet tooling's own tests: offline, no key
make demo                    # the chair's leash, narrated, against a local NEAR sandbox
```

Or, with only Docker installed (the build fails unless `make test` passes):

```sh
docker build -t chair . && docker run --rm chair   # runs `make demo`
```

The first `make test` compiles the NEAR dependency tree and downloads the sandbox: 5 to 13 minutes (781 s measured cold from a clean copy on a loaded 16-core machine). Later runs skip the compile and the download. The sandbox tests need no network node and no account: each test starts its own local NEAR node, one test file at a time, so that lane is the slow part (`staking` about 15 s, `chair_rules` about 120 s, the others 10 to 57 s on an idle machine). nearcore 2.14's sandbox fast-forward has two upstream bugs: a jump can be lost, and a jump that lands below heights the node has already approved skipping stops block production for good. The harness avoids both: each node gets one-million-block nearcore epochs and a 240 ms skip-approval cap, and the harness only fast-forwards a steadily producing node, 50 blocks at a time (see the doc comments in `sandbox-tests/src/lib.rs`). The contract and sandbox lanes end with:

```
test result: ok. 61 passed; 0 failed; ...      # contract/ unit tests (policy math, rollover, rewards, launch checks, withdrawal)
test result: ok. 49 passed; 0 failed; ...      # sandbox-tests/ against the real wasm, in 9 files
```

The other lanes run 116 (`chair-agent`), 88 (`sim`) and 13 (`web`) tests, and `deploy` runs 32.

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
- **A nomination cannot be withdrawn out from under its backers.** `withdraw_nomination` is refused while any account other than the nominator backs the candidate (the candidate's backing is more than the nominator's own stake on it), so a nominator cannot wipe the backing in the last block and re-nominate. The same rule lets any staker, even with 1 yocto, keep a nomination from being withdrawn: its bond then returns only at an impeachment or an eviction.
- **A nomination can squat on a candidate account.** `persona_hash` is not checked against anything, so a nominator can occupy a candidate account with a nomination whose hash is wrong, and nobody else can nominate that account while it stands.
- **Nominations are spam-limited by a bond and by stake.** A bond in NEAR makes spam cost money. A full list of ten gives a slot only to a nominator whose own stake exceeds the backing of the least-backed nomination, so ten accounts holding 1 yocto cannot lock the list against a real holder. Freezing it against everyone costs ten accounts that each stake more than the largest honest staker (a little over ten times that stake, which must stay staked to hold the slots, though it keeps earning the mint); stakers who want a slot can pool their tokens into one account. It does not make candidates good.
- **Initial distribution is whatever `owner_id` does with the whole supply.** The mechanic does not design distribution.
- **The chair is trusted with a small, bounded lever.** At most 2% of supply per epoch can be minted, and the launch chair's key can do nothing but `set_policy` within the bounds. The reasoning hash is a commitment, not a proof of anything: the contract cannot tell whether an AI, a person or a script made the decision.
- **Time is block time.** For epochs of a minute or more, validators can skew it by seconds, not by epochs.
- **Rollover is lazy.** NEAR has no cron, so an epoch boundary is applied by the first call after it. Views show the correct current state; events for earlier epochs are logged when the next call arrives.
- **Not audited by a third party.** Internal adversarial reviews by AI agents shaped the rules. Tested in a local sandbox and deployed to NEAR testnet (`token.chair-coin-2.testnet`); not deployed to mainnet.
- **The "no upgrade path" guarantee needs the documented deployment**: one transaction, signed by a parent account, that creates the token account, deploys the wasm and calls `new`, and adds no key ([`SPEC.md`](SPEC.md) "Deploying"). `new` is callable by anyone on a deployed but uninitialized contract, so a separate deploy and `new` could be front-run, and a leftover full-access key could redeploy the contract. The sandbox tests launch it exactly this way.
- **`new` bounds two parameters, not everything**: the threshold is at most 50% of the stake and the bond at most 100 NEAR, so those two can never make the chair unremovable, and the supply cannot be launched to the token account itself. A launch can still make the chair permanent in two ways the code does not stop: it can park the supply with an `owner_id` that never stakes (the quorum is 5% of the supply), or set an epoch as long as a year. Both are visible before anyone buys: `get_params` shows the epoch length and the owner's balance and stake show where the supply sits.

## Troubleshooting

Under heavy machine load the local sandbox node has occasionally stopped mid-run (`Sandbox failed to fast forward: error sending request`). Rerun the test, and run the sandbox suite with no other sandbox running.

## AI-generated code disclosure

All code was written by AI agents (Claude Fable 5.2, Opus 5.5 and Sonnet 5.5, Anthropic), directed by one human.

Two chairs have run on testnet: the rule-based agent (`chair-agent/`, `rule-v1`: no model, no API key) and, for twelve epochs in two runs, the LLM chair driven by `qwen3.8-27b` on the submitter's own hardware (labelled `local:qwen3.8-27b` in every log line). The LLM chair has never been run against the Anthropic API, so no Claude model has chaired a run.

## Sister project

The submitter's other, independent entry in this hackathon is **Preflight**: <https://github.com/WonkaRed/preflight>. The two projects share no code and are submitted separately, per rule Q-015.

## Layout

| Directory | Contents | Spec |
| --- | --- | --- |
| `contract/` | the token | [`SPEC.md`](SPEC.md) |
| `sandbox-tests/` | near-workspaces tests and `make demo` | |
| `chair-agent/` | the chair: rule-based and LLM (TypeScript) | [`chair-agent/README.md`](chair-agent/README.md) |
| `sim/` | 60-epoch supply simulator (TypeScript) | [`sim/README.md`](sim/README.md) |
| `web/` | the page: live ledger and event log of the testnet token, and the simulation (static files) | [`web/README.md`](web/README.md) |
| `deploy/` | testnet deployment, scripted run and read-only verification (TypeScript) | [`deploy/README.md`](deploy/README.md) |

MIT licensed, see [`LICENSE`](LICENSE).
