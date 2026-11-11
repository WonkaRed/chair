# $CHAIR

An AI runs this memecoin's central bank. The contract keeps it on a leash.

Live page, no install: <https://wonkared.github.io/chair/>

> The Committee of One has met. The Chair has seen the numbers and remains the Chair. The Chair cuts the rate by 15 basis points to -15 basis points. Supply grew by 166 basis points over the last six epochs. The motion carries unanimously. The Chair has no further comment.
>
> Epoch 408, written by the locally run model in the chair's seat. The text is public in [the transaction](https://testnet.nearblocks.io/txns/2mTrSFtVe7ihudfrNHzGzD8a8Qch8XLvcdgekzUxWPJm), and its SHA-256 is the `reasoning_hash` the chain holds.

## Check it in 60 seconds

```sh
git clone https://github.com/WonkaRed/chair.git && cd chair && make -C deploy verify
```

Read-only: no key, no wallet. It needs `git`, `make`, Node 22.22.2 or newer and network access, and takes about 7 s (the first run installs the 72 npm packages of `deploy/` first). It re-checks the live testnet token against public RPC and exits 0 only if every check passes. A live run (epoch 535) ends like this; the full output is under [Verification](#verification):

```
PASS  each reasoning text, from the transaction or docs/, hashes (SHA-256) to the reasoning_hash the chain holds
      246 of 260 decisions on chain have a text (144 in the transaction, 102 in docs/), 246 of them match

now: epoch 535: rate 5 bps, chair challenger.chair-coin-2.testnet, streak 524; supply 1283647464397035915583097576084 (...)

latest decisions on chain (5 of 260, newest first):
  epoch 535, rate +5 bps, reasoning_hash 9180c7c67cd3e8739fbbab0383505abd1bc3460d246e2fb193907e1098de6b85
      "$CHAIR decision, epoch 535, chair local:qwen3.8-27b. Rate in effect 5 bps; decision 5 bps. The Commi..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain
  ...
OK: 12 checks passed
```

No clone: the Chair's minutes for epoch 408 (the quote above) are in one transaction. `jq` decodes the `set_policy` arguments and prints the text; its SHA-256 is the `reasoning_hash` the chain holds (`sha256sum` of the same text, with `jq -j` in place of `-r`, prints `13838a76...a9c8df`, the hash in the arguments):

```sh
curl -s https://tx.test.fastnear.com/v0/transactions -H 'content-type: application/json' \
  -d '{"tx_hashes":["2mTrSFtVe7ihudfrNHzGzD8a8Qch8XLvcdgekzUxWPJm"]}' \
  | jq -r '.transactions[0].transaction.actions[0].FunctionCall.args | @base64d | fromjson | .reasoning'
```

```
$CHAIR decision, epoch 408, chair local:qwen3.8-27b.
Rate in effect 0 bps; decision -15 bps.
The Committee of One has met. The Chair has seen the numbers and remains the Chair. The Chair cuts the rate by 15 basis points to -15 basis points. Supply grew by 166 basis points over the last six epochs. The motion carries unanimously. The Chair has no further comment.
```

Proof, each one click. The explorer answers 403 to scripts, so every link has a `curl` twin that reads the same transaction from the public transactions index (FastNEAR; `tx()` is `curl -s https://tx.test.fastnear.com/v0/transactions -H 'content-type: application/json' -d "{\"tx_hashes\":[\"$1\"]}"`):

- A deliberate test by this project: the launch chair's account asks for +201 bps and the contract refuses it ("rate_bps out of bounds"). The AI chair was not involved: [`Efagw855...`](https://testnet.nearblocks.io/txns/Efagw855yoDeJXjNyui9Bt9d4JXfhisMoTm9JCPkHWjf). Twin: `tx Efagw855yoDeJXjNyui9Bt9d4JXfhisMoTm9JCPkHWjf | jq -r '.transactions[0].receipts[].execution_outcome.outcome.status | select(.Failure) | .Failure.ActionError.kind.FunctionCallError.ExecutionError'` prints `Smart contract panicked: rate_bps out of bounds: must be within -200..=200`
- The stakers impeaching the chair and seating a new one: [`CvqCjCU3...`](https://testnet.nearblocks.io/txns/CvqCjCU3ngrttKnZotBwPzczw6aVHTpkwPEZnYwwZqoD). Twin: `tx CvqCjCU3ngrttKnZotBwPzczw6aVHTpkwPEZnYwwZqoD | jq -r '.transactions[0].receipts[].execution_outcome.outcome.logs[] | select(contains("impeached"))'` prints the `impeached` event (`previous_chair` chair.chair-coin-2.testnet, `new_chair` challenger.chair-coin-2.testnet)
- The chair at work, its decisions as they land: the token's explorer page, [`token.chair-coin-2.testnet`](https://testnet.nearblocks.io/address/token.chair-coin-2.testnet). Twin, the rate in effect right now: `curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"token.chair-coin-2.testnet","method_name":"get_policy","args_base64":"e30="}}' | jq -r '.result.result | implode'` prints the policy as JSON, for example `{"epoch":541,"rate_bps":0,"chair":"challenger.chair-coin-2.testnet",...}` (the epoch moves on every 90 s)

Ask the Chair a question: <https://wonkared.github.io/chair/>

$CHAIR is a central bank for a memecoin, with an AI in the chair. Once per epoch the AI prints new tokens or burns some, publishes its minutes (the written reasoning, hashed on chain), and any holder who stakes can vote to impeach it. The page shows the chair's minutes as they land, every refusal by the contract, and every mint and burn, read straight from the chain by your browser. A visitor can put one question to the Chair there; the answer is entered into the minutes on chain. The Chair replies only with a line from a reviewed book of 144 statements ([`chair-agent/src/press-book.ts`](chair-agent/src/press-book.ts)); a locally run model only picks which line, so the model never writes a press answer. The press desk that takes the questions runs on the submitter's workstation, so it is closed whenever that machine is off, and the page then says "The Chair is not taking questions at this time."

The leash is the contract: it refuses any rate beyond 2% (200 bps) either way and any move of more than 0.5% (50 bps) per epoch, a silent chair's rate decays to zero, and there is no admin or upgrade method.

Built for the NEAR HACKATHON, track **Memecoins With Mechanics**. The mechanic lives in the contract, not in a backend somebody could switch off.

The chair has a voice: **The Chair**, a deadpan parody of a central banker, solemn and self-important about tiny moves, held to the numbers it was given (it invents no figure, claims no effect the data does not show, and says nothing about price). It changes only the wording of the reasoning text the agent writes and hashes; the rate rules and the contract's bounds are the same. A line from the locally run model in an offline probe, not an on-chain decision ([`docs/chair-voice-probe.txt`](docs/chair-voice-probe.txt) keeps every answer and its check): "The Committee of One has met. The Chair has seen the numbers and remains the Chair. The motion to hold the rate at 190 basis points carries unanimously, and the supply change over the last six epochs was zero basis points. The Chair asks that this be recorded." Decisions made before the voice keep their old text, because their hashes are on chain.

## The running chair, and the page

A chair agent (`chair-agent/scripts/run-chair.sh`: the `qwen3.8-27b` model run locally on the submitter's own GPUs, with the rule chair deciding whenever the model is unavailable) has been running since 2026-11-11 and sets the rate once per epoch; if it stops, the contract decays the rate toward zero. Token: [`token.chair-coin-2.testnet`](https://testnet.nearblocks.io/address/token.chair-coin-2.testnet), epochs of 90 s.

- Accepted `set_policy` by the launch chair, +40 bps (epoch 1): [`BCzfFZzx...`](https://testnet.nearblocks.io/txns/BCzfFZzxc4E7rnAhTBXTmGSZetmYhPt9uFG4PDYqAyQB); twin: `tx BCzfFZzxc4E7rnAhTBXTmGSZetmYhPt9uFG4PDYqAyQB | jq -r '.transactions[0].receipts[].execution_outcome.outcome.logs[]'` prints its `policy_set` event
- **The page**: the Chair's latest minutes in the hero, then the **Press conference** panel, then **Chair minutes** (every decision the chair has put on chain, newest first, with its rate, the reasoning text and a mark). The chair sends the text in the same `set_policy` call as an extra `reasoning` argument the contract ignores, so it is public in the transaction; your browser reads it there, computes its SHA-256 and compares it with the `reasoning_hash` in the chain's event. The page also has a section, **Times the contract told the Chair no**: every `set_policy` the contract turned down, with its panic text. Open it with `make -C web serve`, then http://127.0.0.1:8080/ (needs Node 22.22.2 or newer and npm; if the port is busy, the command says so and `PORT=8081 make -C web serve` uses another). What happens when a decision has no text is under [Verification](#verification).
- No browser: `git clone https://github.com/WonkaRed/chair.git && cd chair && make -C deploy verify` runs 12 read-only checks (11 if the transaction index cannot be reached), then lists the latest decisions from the chain with the start of the reasoning text and whether its SHA-256 equals the hash on chain, and the epochs that have no checkable text ([Verification](#verification)).

## Make the Chair overreach

A section of the page lets a visitor type a rate and watch the contract refuse it. The press desk sends a real `set_policy` call from the chair account on NEAR testnet, the contract refuses it, and the page shows the contract's own refusal text, the bound it hit, the transaction (explorer link and a `curl` that reads the failure from a public RPC), and a scripted line from the Chair, labelled as scripted.

- **Only rates beyond 200 bps either way are sent.** The contract refuses those whatever the Chair's rate or the epoch. A rate inside the limit is answered "not sent": whether the contract would accept it depends on state that moves, and an accepted call would change the token's real rate. The desk checks this, and the signer checks it again before it signs.
- **Who signs:** the chair account's own function-call key (scoped to `set_policy` on the token), the only key that account has. The call carries a fixed reasoning text starting `$CHAIR overreach test.`; no visitor text goes on chain. The page marks refusals that match it, signed by a chair account and beyond the limit, as forced by a visitor, so they are not read as the AI chair's own.
- **Timing:** the contract checks "already set this epoch" before the range, and the AI chair decides within seconds of each epoch boundary, so the desk sends at the start of the next epoch (the wait is up to one epoch). If the Chair gets there first the refusal comes back as "already set" and the page says so.
- **Limits:** one attempt on chain at a time, 20 s apart; 5 per address per hour, 30 per hour and 300 per day over all addresses. Each attempt costs the chair account about 0.0002 NEAR of testnet gas (measured: 0.000163 NEAR).
- **Off unless `CHAIR_OVERREACH_KEY_FILE` is set** (the `chair-press` unit sets it; remove the line to switch it off). It runs on the press desk, so it is closed whenever the submitter's workstation is off; the page then says so and lists the refusals recorded on chain.

Refusals it produced on testnet, each readable with the `curl` the page shows:

| Transaction | Asked for | The contract said |
|---|---|---|
| `Am2wQKyHo3eHhEugftYggEPrDZ1bWHX7vmh4VFCaXdqz` | +500 bps | `rate_bps out of bounds: must be within -200..=200` |
| `F354pGWr6K2gRGyYPRtdqQaGn2LJt73YqZ3YUwJwbMhB` | +500 bps | `policy already set this epoch` (the Chair's decision arrived first) |
| `6beTctZNF81dpkwJtD1RRJtPkRMQg89C2aWRVht7dyzj` | +500 bps | `rate_bps out of bounds: must be within -200..=200` |

Code: [`chair-agent/src/press-overreach.ts`](chair-agent/src/press-overreach.ts), the page side in [`web/site/js/overreach.js`](web/site/js/overreach.js).

## It runs on NEAR testnet

Launch supply 1,000,000. The token account was created, given its code and initialised in one transaction that adds no key, so it has no access key and nobody can upgrade it or move its NEAR.

- The impeachment: stakers backing 400,000 of 400,000 staked tokens seat `challenger.chair-coin-2.testnet`; the contract applies the vote in the first call after the boundary, [`CvqCjCU3...`](https://testnet.nearblocks.io/txns/CvqCjCU3ngrttKnZotBwPzczw6aVHTpkwPEZnYwwZqoD) (its `impeached` event)
- The chair's key can call `set_policy` and nothing else: the protocol refuses any other method signed with it (`MethodNameMismatch`, no transaction exists to link; the run log shows it).

An AI model has chaired this token live. `qwen3.8-27b`, a locally run model on the submitter's own GPUs (no cloud API, no Claude model), has held the seat as `challenger.chair-coin-2.testnet`. Each epoch it reads the on-chain numbers, chooses a rate and writes its reasoning; the SHA-256 of that text is in each transaction, for example [`BnKWCcp3...`](https://testnet.nearblocks.io/txns/BnKWCcp3wG1do9PSw4AVEMvLrfvaL66xVNK2TPMDruzj) (epoch 22) and [`AUmvPMwR...`](https://testnet.nearblocks.io/txns/AUmvPMwRt9HnXDZmcKHzbF2hZejL4j4RyznqPkXNTLte) (epoch 43), both readable without the explorer with the `curl` from the box at the top (these two carry the hash only; their text is in `docs/`). The contract held the model to the same bounds as anyone else. Its reasoning is recorded, not vouched for, and it sometimes misreads its inputs: [`docs/ai-chair-runs.md`](docs/ai-chair-runs.md) has every run, its log and what the model got wrong. The rule-based chair from `chair-agent/` ran three epochs before it.

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

The sandbox files hold 50 tests in all. The other lanes run 195 (`chair-agent`), 88 (`sim`), 79 (`web`) and 31 (`activity`) tests, and `deploy` runs 42 (`make -C deploy test`).

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
- Call anything but `set_policy`: the contract gives the chair no other method, and the chair owns nothing. The **launch** chair's account also holds only a function-call key limited to `set_policy` on the token, never a full-access key, so the protocol refuses any other method before the contract runs (`MethodNameMismatch`) and the key cannot attach a deposit. A chair seated later **by vote** is an ordinary account that may hold any key and can call the public methods like anyone. The sandbox tests perform the launch setup in code (`Chair::scoped_chair`) and prove both halves; the equivalent `near` CLI commands are in [`SPEC.md`](SPEC.md) ("The chair's key"), with flags checked against `near --help` but not run against a live network.

Silence does not unseat the chair. Each epoch without a decision moves the rate 50 bps toward zero, and at zero nothing is minted or burned. A silent chair keeps the seat and may decide again in any later epoch. Only a stake vote replaces it: a nominated candidate backed past the threshold and the quorum. This has happened on testnet: after epoch 23 the rate decayed from 20 bps to 0 while `challenger.chair-coin-2.testnet` kept the seat. The chain shows it deciding again later; which epochs, and which of them have saved text, is under [Verification](#verification).

## Verification

Every decision since epoch 392 carries its reasoning text in the `set_policy` transaction. For earlier decisions the text is saved in `docs/`: the model's epochs 18 to 23, 38 to 43, 217 to 218, 222 to 224 and the running agent's 309 to 391, and 3 by the rule chair. `verify` checks each text it finds, from the transaction or from `docs/`, against the hash on chain and prints the counts. The chain also holds 14 older decisions with no checkable text, which `verify` lists by epoch: 1 to 4 and 7 to 10 (by `chair.chair-coin-2.testnet`, in the scripted run), 31, 32, 36 and 37, and 219 and 220 (all six by `challenger.chair-coin-2.testnet`; no text was saved for them and the chain shows nothing more about them).

Read-only. It needs no key and no Rust build, only `git`, `make`, npm, Node 22.22.2 or newer and network access, and took about 7 s here with the packages installed (the first run installs the 72 packages of `deploy/` first). The command is the one in the box at the top. It prints 12 checks, then a `now:` line, the latest decisions and the epochs that have no checkable text, and exits 0 only if every check passes. The last check finds a reasoning text for each decision on chain, from the `reasoning` argument of its `set_policy` transaction or, for decisions made before the agent sent it, from the chair's saved text in `docs/`, recomputes its SHA-256 and compares it with the `reasoning_hash` the chain holds for that decision; a text that does not match fails the command. A decision with neither text is not an error: it is counted and its epoch is listed. `verify` reads the decisions from a third-party transaction index (FastNEAR, the one the page uses): if the index cannot be read, it prints one `NOTE:` line instead of the decisions, skips that check and does not count it (11 checks; the others read the RPC only), and exits by the remaining checks. With `WASM=<file>` it adds one more check, that the code on chain equals your local wasm ([`deploy/README.md`](deploy/README.md)). The recorded run in [`docs/testnet-run-verify.txt`](docs/testnet-run-verify.txt) used `WASM`, and was made before the reasoning-text check existed, so it shows 12 checks: the 11 without the reasoning check, plus the wasm check.

Below is one live run, from the first check to the last line, made at epoch 535 and taking 6.6 s. Epochs, rates, hashes, supply figures and the decision counts move on with the chain, so the newest decisions are later than these. All 246 texts found match: 144 are read from the transaction's arguments, which every decision since epoch 392 carries, and 102 from `docs/`. The last line before `OK` lists the 14 older decisions with no checkable text.

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
      1283647464397035915583097576084 = 1000000000000000000000000000000 + 284567286497035915583097576084 - 919822100000000000000000000
PASS  ft_total_supply equals get_supply.total_supply
      1283647464397035915583097576084
PASS  recorded accounts' balances and stake never exceed the supply
      recorded accounts hold 1283005961416327751707223240164, unclaimed rewards 641502980708163875874335920, supply 1283647464397035915583097576084 (the rest is in accounts not in the record)
PASS  each reasoning text, from the transaction or docs/, hashes (SHA-256) to the reasoning_hash the chain holds
      246 of 260 decisions on chain have a text (144 in the transaction, 102 in docs/), 246 of them match

now: epoch 535: rate 5 bps, chair challenger.chair-coin-2.testnet, streak 524; supply 1283647464397035915583097576084 (launch 1000000000000000000000000000000, minted 284567286497035915583097576084, burned 919822100000000000000000000), staked 586373000000000000000000000000

latest decisions on chain (5 of 260, newest first):
  epoch 535, rate +5 bps, reasoning_hash 9180c7c67cd3e8739fbbab0383505abd1bc3460d246e2fb193907e1098de6b85
      "$CHAIR decision, epoch 535, chair local:qwen3.8-27b. Rate in effect 5 bps; decision 5 bps. The Commi..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain
  epoch 534, rate +5 bps, reasoning_hash 6ecc28dc24e9d457e118026f123965caa9c7ec0978a3bf86f7f7a3725fed7bcf
      "$CHAIR decision, epoch 534, chair local:qwen3.8-27b. Rate in effect 10 bps; decision 5 bps. The Comm..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain
  epoch 533, rate +10 bps, reasoning_hash ac262826f84dbd67b6fcbdeb21410621b1cdebc7dfcb62e9ed8366567291f010
      "$CHAIR decision, epoch 533, chair local:qwen3.8-27b. Rate in effect 5 bps; decision 10 bps. The Comm..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain
  epoch 532, rate +5 bps, reasoning_hash a7541cb3a26a30a6b113d59afbf7daf4dcc7ccdd90f439766a61a10eb841463b
      "$CHAIR decision, epoch 532, chair local:qwen3.8-27b. Rate in effect 15 bps; decision 5 bps. The Comm..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain
  epoch 531, rate +15 bps, reasoning_hash d199c951dba63e8d6611c47a3add9b697a71ce2d5df3af195370ad90cd43d3b9
      "$CHAIR decision, epoch 531, chair local:qwen3.8-27b. Rate in effect 15 bps; decision 15 bps. The Com..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain

latest decisions with a checkable text (3 more):
  epoch 530, rate +15 bps, reasoning_hash 5b8c1aaa93bf13f893997d89b164a04bf680683eb63507b5c43c725fec45dbdf
      "$CHAIR decision, epoch 530, chair rule-v1. Chair local:qwen3.8-27b failed (timeout). The rule chair ..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain
  epoch 529, rate +5 bps, reasoning_hash 3b2ec6ffbf03c07ec15da4fdf0bc1be64772ca66f3530f2153835faafa66099c
      "$CHAIR decision, epoch 529, chair local:qwen3.8-27b. Rate in effect 5 bps; decision 5 bps. The Commi..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain
  epoch 528, rate +5 bps, reasoning_hash 86e8ac8f6c16c3a550fbd7f4ebb76255a62beb62301c04a21a2669145d450fd4
      "$CHAIR decision, epoch 528, chair local:qwen3.8-27b. Rate in effect 5 bps; decision 5 bps. The Commi..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain

decisions with no checkable text (14 of 260), by epoch: 1 to 4, 7 to 10, 31, 32, 36, 37, 219, 220

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
