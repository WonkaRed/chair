# $CHAIR

An AI runs this memecoin's central bank. The contract keeps it on a leash.

Live page, no install: <https://wonkared.github.io/chair/>

> The Committee of One has met. The Chair has seen the numbers and remains the Chair. The Chair cuts the rate by 15 basis points to -15 basis points. Supply grew by 166 basis points over the last six epochs. The motion carries unanimously. The Chair has no further comment.
>
> Epoch 408, written by the locally run model in the chair's seat. The text is public in [the transaction](https://testnet.nearblocks.io/txns/2mTrSFtVe7ihudfrNHzGzD8a8Qch8XLvcdgekzUxWPJm), and its SHA-256 is the `reasoning_hash` the chain holds.

Proof, each one click:

- The contract refusing the chair's +201 bps ("rate_bps out of bounds"): [`Efagw855...`](https://testnet.nearblocks.io/txns/Efagw855yoDeJXjNyui9Bt9d4JXfhisMoTm9JCPkHWjf)
- The stakers impeaching the chair and seating a new one: [`CvqCjCU3...`](https://testnet.nearblocks.io/txns/CvqCjCU3ngrttKnZotBwPzczw6aVHTpkwPEZnYwwZqoD)
- The chair at work, its decisions as they land: the token's explorer page, [`token.chair-coin-2.testnet`](https://testnet.nearblocks.io/address/token.chair-coin-2.testnet)

Ask the Chair a question: <https://wonkared.github.io/chair/>

$CHAIR is a central bank for a memecoin, with an AI in the chair. Once per epoch the AI prints new tokens or burns some, publishes its minutes (the written reasoning, hashed on chain), and any holder who stakes can vote to impeach it. The page shows the chair's minutes as they land, every refusal by the contract, and every mint and burn, read straight from the chain by your browser. A visitor can put one question to the Chair there; the answer is entered into the minutes on chain. The Chair replies only with a line from a reviewed book of 147 statements ([`chair-agent/src/press-book.ts`](chair-agent/src/press-book.ts)); a locally run model only picks which line, so nothing a model writes is ever signed. The press desk that takes the questions runs on the submitter's workstation, so it is closed whenever that machine is off, and the page then says "The Chair is not taking questions at this time."

The leash is the contract: it refuses any rate beyond 2% (200 bps) either way and any move of more than 0.5% (50 bps) per epoch, a silent chair's rate decays to zero, and there is no admin or upgrade method.

Built for the NEAR HACKATHON, track **Memecoins With Mechanics**. The mechanic lives in the contract, not in a backend somebody could switch off.

The chair has a voice: **The Chair**, a deadpan parody of a central banker, solemn and self-important about tiny moves, held to the numbers it was given (it invents no figure, claims no effect the data does not show, and says nothing about price). It changes only the wording of the reasoning text the agent writes and hashes; the rate rules and the contract's bounds are the same. A line from the locally run model in an offline probe, not an on-chain decision ([`docs/chair-voice-probe.txt`](docs/chair-voice-probe.txt) keeps every answer and its check): "The Committee of One has met. The Chair has seen the numbers and remains the Chair. The motion to hold the rate at 190 basis points carries unanimously, and the supply change over the last six epochs was zero basis points. The Chair asks that this be recorded." Decisions made before the voice keep their old text, because their hashes are on chain.

## Check it in under a minute

A chair agent (`chair-agent/scripts/run-chair.sh`: the `qwen3.8-27b` model run locally on the submitter's own GPUs, with the rule chair deciding whenever the model is unavailable) has been running since 2026-11-11 and sets the rate once per epoch; if it stops, the contract decays the rate toward zero. Token: [`token.chair-coin-2.testnet`](https://testnet.nearblocks.io/address/token.chair-coin-2.testnet), epochs of 90 s.

- Accepted `set_policy` by the chair, +40 bps: [`BCzfFZzx...`](https://testnet.nearblocks.io/txns/BCzfFZzxc4E7rnAhTBXTmGSZetmYhPt9uFG4PDYqAyQB)
- **The page**: the Chair's latest minutes in the hero, then the **Press conference** panel, then **Chair minutes** (every decision the chair has put on chain, newest first, with its rate, the reasoning text and a mark). The chair sends the text in the same `set_policy` call as an extra `reasoning` argument the contract ignores, so it is public in the transaction; your browser reads it there, computes its SHA-256 and compares it with the `reasoning_hash` in the chain's event. The page also has a section, **Times the contract told the Chair no**: every `set_policy` the contract turned down, with its panic text. Open it with `make -C web serve`, then http://127.0.0.1:8080/ (needs Node 22.22.2 or newer and npm; if the port is busy, the command says so and `PORT=8081 make -C web serve` uses another). What happens when a decision has no text is under [Verification](#verification).
- No browser: `git clone https://github.com/WonkaRed/chair.git && cd chair && make -C deploy verify` runs 12 read-only checks (11 if the transaction index cannot be reached), then lists the latest decisions from the chain with the start of the reasoning text and whether its SHA-256 equals the hash on chain, and the epochs that have no checkable text ([Verification](#verification)).

## It runs on NEAR testnet

Launch supply 1,000,000. The token account was created, given its code and initialised in one transaction that adds no key, so it has no access key and nobody can upgrade it or move its NEAR.

- The impeachment: stakers backing 400,000 of 400,000 staked tokens seat `challenger.chair-coin-2.testnet`; the contract applies the vote in the first call after the boundary, [`CvqCjCU3...`](https://testnet.nearblocks.io/txns/CvqCjCU3ngrttKnZotBwPzczw6aVHTpkwPEZnYwwZqoD) (its `impeached` event)
- The chair's key can call `set_policy` and nothing else: the protocol refuses any other method signed with it (`MethodNameMismatch`, no transaction exists to link; the run log shows it).

An AI model has chaired this token live. `qwen3.8-27b`, a locally run model on the submitter's own GPUs (no cloud API, no Claude model), has held the seat as `challenger.chair-coin-2.testnet`. Each epoch it reads the on-chain numbers, chooses a rate and writes its reasoning; the SHA-256 of that text is in each transaction, for example [`BnKWCcp3...`](https://testnet.nearblocks.io/txns/BnKWCcp3wG1do9PSw4AVEMvLrfvaL66xVNK2TPMDruzj) (epoch 22) and [`AUmvPMwR...`](https://testnet.nearblocks.io/txns/AUmvPMwRt9HnXDZmcKHzbF2hZejL4j4RyznqPkXNTLte) (epoch 43). The contract held the model to the same bounds as anyone else. Its reasoning is recorded, not vouched for, and it sometimes misreads its inputs: [`docs/ai-chair-runs.md`](docs/ai-chair-runs.md) has every run, its log and what the model got wrong. The rule-based chair from `chair-agent/` ran three epochs before it.

Every decision since epoch 392 carries its reasoning text in the `set_policy` transaction itself ([`chair-agent/README.md`](chair-agent/README.md)), so anyone can read it from the chain and hash it. For earlier decisions, and the epochs that have no checkable text, see [Verification](#verification).

The token's testnet activity (transfers, stakes, claims) comes from `activity/`: scripted test activity by three accounts we control, not organic users. It acts every 6th epoch and never nominates, backs or sets policy.

Below the chair minutes the same page lists every mint and burn and checks the sums against the contract's own `get_supply`.

## What it is

$CHAIR is a NEP-141 token on NEAR. Time is cut into epochs of fixed length. Once per epoch the current **chair** account may call `set_policy(rate_bps, reasoning_hash)`:

- A positive rate **eases**: at the end of the epoch the contract mints `total_supply * rate / 10_000` into a reward pool paid to stakers.
- A negative rate **tightens**: during that epoch every transfer burns `|rate|` bps of the amount, and nothing is minted.
- The chair seat is built for an AI agent. The contract does not trust whoever holds it: the rate is bounded, the step is bounded, and each epoch the chair misses moves the rate 50 bps toward zero.
- Stakers can nominate and back a replacement. A candidate whose backing exceeds both the threshold (a share of the staked tokens) and a 5% quorum of the whole supply becomes chair at the next epoch rollover, and the chair's streak (the complete epochs the sitting chair has held the seat, `epoch - chair_since_epoch`) resets to 0. Below the quorum nobody can be seated, however little is staked.

Every launch parameter is set once in `new()` and readable by a view method. There is no admin or owner method and no upgrade path.

## Run the tests and the demos

Needs a Linux x86-64 machine (the only platform tried) with glibc 2.39 or newer, because that is what the NEAR sandbox binary is linked against (Ubuntu 24.04, Debian 13, Fedora 40 or later); `git`, `make`, `curl`, a C/C++ compiler; [rustup](https://rustup.rs) (the compiler, 1.95.0, is pinned by `rust-toolchain.toml`); Node 22.22.2 or newer with npm (the highest `engines` floor of `deploy/` and `chair-agent/`; `sim/` asks for 22); and network access (crates, npm packages, and the sandbox binary, which the first test run downloads into the build directory). No API keys, no wallet, no account.

```sh
git clone https://github.com/WonkaRed/chair.git chair && cd chair
rustup toolchain install     # installs the toolchain pinned in rust-toolchain.toml
make test                    # unit tests, the sandbox tests against the real wasm, then the agent, simulator, web and activity tests
make -C deploy test          # the testnet tooling's own tests: offline, no key
make demo                    # the chair's leash, narrated, against a local NEAR sandbox
```

Or, with only Docker installed (the build fails unless `make test` passes):

```sh
docker build -t chair . && docker run --rm chair   # runs `make demo`
```

The first `make test` compiles the NEAR dependency tree and downloads the sandbox: 5 to 13 minutes (781 s measured cold from a clean copy on a loaded 16-core machine). Later runs skip the compile and the download. The sandbox tests need no network node and no account: each test starts its own local NEAR node, one test file at a time, so that lane is the slow part (the longest file, `chair_rules`, takes about 120 s on an idle machine). Per-file timings and the local-node limits the test harness works around are in [`docs/testing-notes.md`](docs/testing-notes.md). The contract lane ends with the unit-test result and then a line for the doc-tests, which has none; the sandbox lane prints one result line per test file:

```
test result: ok. 61 passed; 0 failed; ...      # contract/ unit tests (policy math, rollover, rewards, launch checks, withdrawal)
test result: ok. 0 passed; 0 failed; ...       # contract/ doc-tests: there are none
test result: ok. 7 passed; 0 failed; ...       # sandbox-tests/ against the real wasm: 9 files, one line each (7, 7, 2, 9, 3, 2, 10, 3, 7 tests)
```

The sandbox files hold 50 tests in all. The other lanes run 160 (`chair-agent`), 88 (`sim`), 50 (`web`) and 31 (`activity`) tests, and `deploy` runs 42 (`make -C deploy test`).

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
| `epoch_ms` | set at launch, 1 second to 1 year | Epoch length. The sandbox demo and tests use 30 seconds; the testnet token uses 90 seconds |
| `start_ms` | block time at launch | Epoch 0 starts here |
| `max_rate_bps` | **200**, a constant in the code | The chair's rate must satisfy `-200 <= rate_bps <= 200` |
| `max_step_bps` | **50**, a constant in the code | `abs(rate_bps - rate_in_effect) <= 50`; a missed epoch moves the rate 50 toward zero |
| `impeach_threshold_bps` | set at launch, 1 to 5000 | Share of total staked a candidate's backing must exceed |
| `quorum_bps` | **500**, a constant in the code | Share of the whole supply (staked or not) a candidate's backing must also exceed |
| `nominate_bond` | set at launch, 1 yoctoNEAR to 100 NEAR | Bond in yoctoNEAR attached to `nominate` |
| first chair, initial supply | set at launch | `chair`, and `total_supply` credited to `owner_id` |

What the contract enforces on every `set_policy`, each with its own panic message (in order): the caller is the chair; the reasoning hash is a SHA-256 digest (64 lowercase hex characters); no decision was made yet this epoch; the rate is within bounds; the step from the rate in effect is at most 50 bps. A rejected call changes nothing and emits no event.

Rollover is integer arithmetic with floor rounding, specified exactly in [`SPEC.md`](SPEC.md) with worked vectors. The whole mechanic is in the contract: epochs, `set_policy` and its bounds, the missed-epoch decay, the epoch mint to stakers, the transfer burn, staking with a two-epoch lock, and nomination, backing and impeachment. If the chair never acts, the rule is still total: the rate moves 50 bps toward zero in each epoch without a decision and stays at zero, where nothing is minted or burned. `get_supply` returns the supply ledger (launch supply, total minted, total burned) and every mint and burn emits an event with its amount and epoch.

## What the chair can and cannot do

No key can change the launch parameters. The bounds (rate within 200 bps either way, step of at most 50 bps per epoch, 5% quorum) are constants in the code. The epoch length, the impeachment threshold and the nomination bond are set once in `new` and no method writes them afterwards. The token account has no key at all. The only thing the chair's key can move is the rate, once per epoch, inside those fixed bounds.

Can:
- Choose one rate per epoch within the bounds. That is the entire surface.
- Record a hash of its reasoning, which is emitted on-chain with the decision.

Cannot:
- Exceed 200 bps either way, or move more than 50 bps per epoch. The contract panics.
- Decide twice in one epoch, or decide as anyone but the chair.
- Change any parameter, mint directly, burn directly, move anyone's tokens, or upgrade the contract. No such method exists.
- Do anything but `set_policy` through the contract: the contract gives the chair no other method, and the chair is not the owner of anything. The **launch** chair is further confined by account setup: it holds only a function-call access key limited to `set_policy` on the token contract, never a full-access key, so the protocol refuses any other method before the contract runs (`MethodNameMismatch`) and the key cannot attach a deposit. A chair seated later **by vote** is whatever account the stakers chose and may hold any key; it is an ordinary account that can also call the public methods, as anyone can. The sandbox tests perform the launch setup in code (`Chair::scoped_chair`) and prove both halves; the equivalent `near` CLI commands are in [`SPEC.md`](SPEC.md) ("The chair's key"), with flags checked against `near --help` but not run against a live network.

Silence does not unseat the chair. Each epoch without a decision moves the rate 50 bps toward zero, and at zero nothing is minted or burned. A silent chair keeps the seat and may decide again in any later epoch. Only a stake vote replaces it: a nominated candidate backed past the threshold and the quorum. This has happened on testnet: after epoch 23 the rate decayed from 20 bps to 0 while `challenger.chair-coin-2.testnet` kept the seat. The chain shows it deciding again later; which epochs, and which of them have saved text, is under [Verification](#verification).

## Verification

Every decision since epoch 392 carries its reasoning text in the `set_policy` transaction. For earlier decisions the text is saved in `docs/`: the model's epochs 18 to 23, 38 to 43, 217 to 218, 222 to 224 and the running agent's 309 to 391, and 3 by the rule chair. `verify` checks each text it finds, from the transaction or from `docs/`, against the hash on chain and prints the counts. The chain also holds 14 older decisions with no checkable text, which `verify` lists by epoch: 1 to 4 and 7 to 10 (by `chair.chair-coin-2.testnet`, in the scripted run), 31, 32, 36 and 37, and 219 and 220 (all six by `challenger.chair-coin-2.testnet`; no text was saved for them and the chain shows nothing more about them).

A decision made before the agent sent text uses the chair's saved text from `docs/`, and a decision with neither shows its hash only. The silent-chair episode: after epoch 23 the rate decayed from 20 bps to 0 while `challenger.chair-coin-2.testnet` kept the seat; the chain shows it deciding again at epochs 31, 32, 36 and 37 (no text was saved for those four) and from epoch 38 with saved text, and `make -C deploy verify` lists the four.

Read-only. It needs no key and no Rust build, only `git`, `make`, npm, Node 22.22.2 or newer and network access, and took 5.2 s here with the packages installed (the first run installs the 72 packages of `deploy/` first):

```sh
git clone https://github.com/WonkaRed/chair.git && cd chair && make -C deploy verify
```

It prints 12 checks, then a `now:` line, the latest decisions and the epochs that have no checkable text, and exits 0 only if every check passes. The last check finds a reasoning text for each decision on chain, from the `reasoning` argument of its `set_policy` transaction or, for decisions made before the agent sent it, from the chair's saved text in `docs/`, recomputes its SHA-256 and compares it with the `reasoning_hash` the chain holds for that decision; a text that does not match fails the command. A decision with neither text is not an error: it is counted and its epoch is listed. `verify` reads the decisions from a third-party transaction index (FastNEAR, the one the page uses): if the index cannot be read, it prints one `NOTE:` line instead of the decisions, skips that check and does not count it (11 checks; the others read the RPC only), and exits by the remaining checks. With `WASM=<file>` it adds one more check, that the code on chain equals your local wasm ([`deploy/README.md`](deploy/README.md)). The recorded run in [`docs/testnet-run-verify.txt`](docs/testnet-run-verify.txt) used `WASM`, and was made before the reasoning-text check existed, so it shows 12 checks: the 11 without the reasoning check, plus the wasm check.

Below is one live run, from the first check to the last line. Epochs, rates, hashes, supply figures and the decision counts move on with the chain, so the newest decisions are later than these. This run was made before any transaction carried its text, which is why it reads "0 in the transaction"; the newest decisions are in `docs/` through the snapshot (epoch 343), and the last line before `OK` lists the decisions that have no checkable text: the 14 above and epoch 344, which came after the snapshot:

```
PASS  code hash on chain equals the recorded wasm
      chain Ap9Us7NuZwcJrk79A9b43yvGoXBkbAKDdsaS3tCEgRAa (sha256 91cd11b6ecb44b1169fce018b9b2db42bbade12a3a5dd8cb6fee838e18abc013); record Ap9Us7NuZwcJrk79A9b43yvGoXBkbAKDdsaS3tCEgRAa (sha256 91cd11b6ecb44b1169fce018b9b2db42bbade12a3a5dd8cb6fee838e18abc013)
PASS  the reported code hash is the hash of the code the node serves
      view_account code_hash (base58) against sha256 of view_code
PASS  the token account holds no access key at all
      0 keys
PASS  chair holds only a function-call key limited to set_policy on the token
      ed25519:5NRzm27oSnjtf3G8yV4gnVwFZuNZraBhuyb8pGEYxoaJ token.chair-coin-2.testnet.[set_policy]
PASS  challenger holds only a function-call key limited to set_policy on the token
      ed25519:A31gFMtexyu6BkLLcUDtC6K7L29pR4jQ4pmyoNJPK8i4 token.chair-coin-2.testnet.[set_policy]
PASS  hard bounds: rate within +-200 bps, step at most 50 bps, backing over 5% of the supply to seat a chair
      max_rate_bps 200, max_step_bps 50, quorum_bps 500
PASS  launch parameters are the recorded ones
      epoch_ms 90000, impeach_threshold_bps 3000, nominate_bond 100000000000000000000000
PASS  launch supply is the recorded one
      1000000000000000000000000000000
PASS  total supply = launch + minted - burned
      1162248449449907739103142521502 = 1000000000000000000000000000000 + 162532445449907739103142521502 - 283996000000000000000000000
PASS  ft_total_supply equals get_supply.total_supply
      1162248449449907739103142521502
PASS  recorded accounts' balances and stake never exceed the supply
      recorded accounts hold 1112872730104161454543784500000, unclaimed rewards 49375719345746284559358021502, supply 1162248449449907739103142521502 (the rest is in accounts not in the record)
PASS  each reasoning text, from the transaction or docs/, hashes (SHA-256) to the reasoning_hash the chain holds
      54 of 69 decisions on chain have a text (0 in the transaction, 54 in docs/), 54 of them match

now: epoch 344: rate -50 bps, chair challenger.chair-coin-2.testnet, streak 333; supply 1162248449449907739103142521502 (launch 1000000000000000000000000000000, minted 162532445449907739103142521502, burned 283996000000000000000000000), staked 375067000000000000000000000000

latest decisions on chain (5 of 69, newest first):
  epoch 344, rate -50 bps, reasoning_hash 0740b5b355e95ef53d3218fa21b74fb2fe7d171b01048572e2487bf1f63d6168
      no text in the transaction or in docs/ for this hash, so nothing to compare (not an error)
  epoch 343, rate -50 bps, reasoning_hash 7c1b8acd19624c107945dc488b3ad26fff4b91908781c8a73f86abf383338b9c
      "$CHAIR decision, epoch 343, chair local:qwen3.8-27b. Rate in effect -50 bps; decision -50 bps. The C..."
      SHA-256 of the text recorded in docs/ equals the hash on chain
  epoch 342, rate -50 bps, reasoning_hash 60715a8bb4f2e6f555ef1c3c88f756f60902527dedc6d93714e5cb1b26313065
      "$CHAIR decision, epoch 342, chair local:qwen3.8-27b. Rate in effect -60 bps; decision -50 bps. The C..."
      SHA-256 of the text recorded in docs/ equals the hash on chain
  epoch 341, rate -60 bps, reasoning_hash f40e1e8ea51fe0c6854011bf3e70e62d29871a6f0a5f90200aad9a6cffb62c92
      "$CHAIR decision, epoch 341, chair local:qwen3.8-27b. Rate in effect -60 bps; decision -60 bps. The C..."
      SHA-256 of the text recorded in docs/ equals the hash on chain
  epoch 340, rate -60 bps, reasoning_hash 22eb5c243a07abda4249df69fb51fc0e793822486991d36adcf4aad3064f960a
      "$CHAIR decision, epoch 340, chair local:qwen3.8-27b. Rate in effect -60 bps; decision -60 bps. The C..."
      SHA-256 of the text recorded in docs/ equals the hash on chain

latest decisions with a checkable text (3 more):
  epoch 339, rate -60 bps, reasoning_hash 07f8ce4c34beedf1e9972518494bde0275620ae8e43d18d2b780048fa0227909
      "$CHAIR decision, epoch 339, chair local:qwen3.8-27b. Rate in effect -60 bps; decision -60 bps. The C..."
      SHA-256 of the text recorded in docs/ equals the hash on chain
  epoch 338, rate -60 bps, reasoning_hash 2062aa94a46bf854251a3dec48ba7506c179c0de1ba9e44504b460d94a90bcff
      "$CHAIR decision, epoch 338, chair local:qwen3.8-27b. Rate in effect -60 bps; decision -60 bps. The C..."
      SHA-256 of the text recorded in docs/ equals the hash on chain
  epoch 337, rate -60 bps, reasoning_hash 0cdc4a4ce6e563388621cd5d054b5cc5d9f1e0bf3095ae72150a5c22561d021a
      "$CHAIR decision, epoch 337, chair local:qwen3.8-27b. Rate in effect -60 bps; decision -60 bps. The C..."
      SHA-256 of the text recorded in docs/ equals the hash on chain

decisions with no checkable text (15 of 69), by epoch: 1 to 4, 7 to 10, 31, 32, 36, 37, 219, 220, 344

OK: 12 checks passed
```

Every transaction of the scripted run, with its hash, is in [`docs/testnet-deployment.json`](docs/testnet-deployment.json); the run logs are `docs/testnet-run-*.txt`. How it was deployed and how to redeploy: [`deploy/README.md`](deploy/README.md).

## Technologies used on NEAR

- NEP-141 fungible token, NEP-148 metadata and NEP-145 storage management, via `near-contract-standards` 5.30.1
- NEP-297 events for every policy decision, mint, burn, stake, claim, nomination and impeachment
- `near-sdk` 5.30.1, built with `cargo-near-build` 0.11.5 (the library behind `cargo near build`)
- Function-call access keys, to confine the chair
- `near-workspaces` 0.24.0 with `near-sandbox` running nearcore 2.14.0, pinned in `sandbox-tests/src/lib.rs`
- Rust 1.95.0, pinned in `rust-toolchain.toml` (why this version: [`docs/testing-notes.md`](docs/testing-notes.md))

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

Two chairs have run on testnet: the rule-based agent (`chair-agent/`, `rule-v1`: no model, no API key) and the LLM chair driven by `qwen3.8-27b` on the submitter's own hardware (labelled `local:qwen3.8-27b` in every log line). Which decisions have saved text, and which are on chain without it, is under "It runs on NEAR testnet" above; the runs are in [`docs/ai-chair-runs.md`](docs/ai-chair-runs.md). The LLM chair has never been run against the Anthropic API, so no Claude model has chaired a run.

## Sister project

The submitter's other, independent entry in this hackathon is **Preflight**: <https://github.com/WonkaRed/preflight>. The two projects share no code and are submitted separately, per rule Q-015.

## Layout

| Directory | Contents | Spec |
| --- | --- | --- |
| `contract/` | the token | [`SPEC.md`](SPEC.md) |
| `sandbox-tests/` | near-workspaces tests and `make demo` | |
| `chair-agent/` | the chair: rule-based and LLM (TypeScript) | [`chair-agent/README.md`](chair-agent/README.md) |
| `sim/` | 60-epoch supply simulator (TypeScript) | [`sim/README.md`](sim/README.md) |
| `web/` | the page: the Chair's latest minutes, the press conference, the ledger and event log of the testnet token, and the simulation (static files) | [`web/README.md`](web/README.md) |
| `deploy/` | testnet deployment, scripted run and read-only verification (TypeScript) | [`deploy/README.md`](deploy/README.md) |
| `activity/` | scripted test activity on the live testnet token (TypeScript) | [`activity/README.md`](activity/README.md) |

MIT licensed, see [`LICENSE`](LICENSE).
