# Verify it, step by step

[Back to the README](../README.md)

## Check it in 60 seconds

This one command asks public servers about the live token, not me, and prints PASS or FAIL for each claim above: nobody can change the rules, the Chair's key can do one thing only, and every minute on the chain matches its fingerprint. Coin amounts print in the smallest unit, 10^24 to the coin, which is why the launch supply of 1,000,000 coins appears as a 1 followed by 30 zeros.

```sh
git clone https://github.com/WonkaRed/chair.git && cd chair && make -C deploy verify
```

Read-only: no key, no wallet. It needs `git`, `make`, Node 22.22.2 or newer and network access, and takes about 5 s (the first run installs the 72 npm packages of `deploy/` first). It re-checks the live testnet token against public RPC and exits 0 only if every check passes. A live run on 2026-11-11 (epoch 32) ends like this; the full output is under [Verification](#verification):

```
PASS  each reasoning text, from the transaction or docs/, hashes (SHA-256) to the reasoning_hash the chain holds
      16 of 24 decisions on chain have a text (16 in the transaction, 0 in docs/), 16 of them match

now: epoch 32: rate 23 bps, chair challenger.chair-coin-3.testnet, streak 21; supply 1000142301970020077030984795172 (launch 1000000000000000000000000000000, minted 152301970020077030984795172, burned 10000000000000000000000000), staked 406571000000000000000000000000

latest decisions on chain (5 of 24, newest first):
  epoch 32, rate +23 bps, reasoning_hash df3357d2dfb11be70394eb61f138c656b11e6c563dcf91f1c4d33e4f94f6ba67
      "$CHAIR decision, epoch 32, chair rule-v1. Chair local:qwen3.8-27b failed (timeout). The rule chair d..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain
  ...
OK: 13 checks passed
```

No clone: the Chair's minutes for epoch 31 (the quote above) are in one transaction. `jq` decodes the `set_policy` arguments and prints the text; its SHA-256 is the `reasoning_hash` the chain holds (`sha256sum` of the same text, with `jq -j` in place of `-r`, prints `ef83f980...e2705`, the hash in the arguments):

```sh
curl -s https://tx.test.fastnear.com/v0/transactions -H 'content-type: application/json' \
  -d '{"tx_hashes":["8c7e6FYiHMob4diojGo9RPj8y6LP6WPtmvBXtEQb7izN"]}' \
  | jq -r '.transactions[0].transaction.actions[0].FunctionCall.args | @base64d | fromjson | .reasoning'
```

```
$CHAIR decision, epoch 31, chair local:qwen3.8-27b.
Rate in effect 29 bps; decision 23 bps.
The Committee of One has met. The Chair changes the rate from printing 0.29% a day to printing 0.23% a day, a little at every 90-second meeting, for holders who staked. 40.65% of all coins are staked. Supply has moved less than 0.01% over the last 6 meetings. The Chair asks that this be recorded.
```

Proof, each one click. The explorer answers 403 to scripts, so every link has a `curl` twin that reads the same transaction from the public transactions index (FastNEAR; `tx()` is `curl -s https://tx.test.fastnear.com/v0/transactions -H 'content-type: application/json' -d "{\"tx_hashes\":[\"$1\"]}"`):

- A deliberate test by this project: the launch chair's account asks for +201 bps and the contract refuses it ("rate_bps out of bounds"). The AI chair was not involved: [`8AB8SGqG...`](https://testnet.nearblocks.io/txns/8AB8SGqGAfiWfPerFDPxv29DYg9FL2XrEbGzctZEHLMu). Twin: `tx 8AB8SGqGAfiWfPerFDPxv29DYg9FL2XrEbGzctZEHLMu | jq -r '.transactions[0].receipts[].execution_outcome.outcome.status | select(.Failure) | .Failure.ActionError.kind.FunctionCallError.ExecutionError'` prints `Smart contract panicked: rate_bps out of bounds: must be within -200..=200`
- The stakers impeaching the chair and seating a new one: [`6Wd6BQSZ...`](https://testnet.nearblocks.io/txns/6Wd6BQSZ7GdNYcD2sXkaubK86y4DSnAYeVWnT2SWE7Cn). Twin: `tx 6Wd6BQSZ7GdNYcD2sXkaubK86y4DSnAYeVWnT2SWE7Cn | jq -r '.transactions[0].receipts[].execution_outcome.outcome.logs[] | select(contains("impeached"))'` prints the `impeached` event (`previous_chair` chair.chair-coin-3.testnet, `new_chair` challenger.chair-coin-3.testnet)
- The chair at work, its decisions as they land: the token's explorer page, [`token.chair-coin-3.testnet`](https://testnet.nearblocks.io/address/token.chair-coin-3.testnet). Twin, the rate in effect right now: `curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"token.chair-coin-3.testnet","method_name":"get_policy","args_base64":"e30="}}' | jq -r '.result.result | implode'` prints the policy as JSON, for example `{"epoch":34,"rate_bps":23,"chair":"challenger.chair-coin-3.testnet","streak":23,...}` (read on 2026-11-11; the epoch moves on every 90 s)

## Verification

Every decision the agent made carries its reasoning text in the `set_policy` transaction, and `verify` checks each text it finds against the hash on chain and prints the counts. The chain also holds 8 older decisions with no checkable text, which `verify` lists by epoch: 1 to 4 and 7 to 10, by `chair.chair-coin-3.testnet` in the scripted run (it sent only the hashes, and the chain shows nothing more about them).

Read-only. It needs no key and no Rust build, only `git`, `make`, npm, Node 22.22.2 or newer and network access, and took about 5 s here with the packages installed (the first run installs the 72 packages of `deploy/` first). The command is the one in the box at the top. It prints 13 checks, then a `now:` line, the latest decisions and the epochs that have no checkable text, and exits 0 only if every check passes. The last check finds a reasoning text for each decision on chain, from the `reasoning` argument of its `set_policy` transaction or, for decisions made before the agent sent it, from the chair's saved text in `docs/`, recomputes its SHA-256 and compares it with the `reasoning_hash` the chain holds for that decision; a text that does not match fails the command. A decision with neither text is not an error: it is counted and its epoch is listed. `verify` reads the decisions from a third-party transaction index (FastNEAR, the one the page uses): if the index cannot be read, it prints one `NOTE:` line instead of the decisions, skips that check and does not count it (12 checks; the others read the RPC only), and exits by the remaining checks. With `WASM=<file>` it adds one more check, that the code on chain equals your local wasm ([`deploy/README.md`](../deploy/README.md)). The recorded run in [`docs/testnet-run-verify.txt`](testnet-run-verify.txt) used `WASM`, so it shows 14 checks: the 13 below, plus the wasm check.

Below is one live run, from the first check to the last line, made on 2026-11-11 at epoch 32 and taking 5.5 s. Epochs, rates, hashes, supply figures and the decision counts move on with the chain, so the newest decisions are later than these. All 16 texts found match, every one read from the transaction's arguments. The last line before `OK` lists the 8 scripted-run decisions with no checkable text.

```
PASS  code hash on chain equals the recorded wasm
      chain 5pexa4j7UxF3tHW1F1eVfDShRr7aWsU7HNdTT7CdsPCz (sha256 47a3f710a59701a14af6ca001feaf397e030e035c38cb3242f2c7bb9f218903f); record 5pexa4j7UxF3tHW1F1eVfDShRr7aWsU7HNdTT7CdsPCz (sha256 47a3f710a59701a14af6ca001feaf397e030e035c38cb3242f2c7bb9f218903f)
PASS  the reported code hash is the hash of the code the node serves
      view_account code_hash (base58) against sha256 of view_code
PASS  the token account holds no access key at all
      0 keys
PASS  chair holds only a function-call key limited to set_policy on the token
      ed25519:B37WSVA1XCtubsPnnKWYp7gXTg8zcerHjxEePAfy4jBB token.chair-coin-3.testnet.[set_policy]
PASS  challenger holds only a function-call key limited to set_policy on the token
      ed25519:55tYZpqx8ZfakHZs4mtJ2xVMPYwX91sxpEmRYHrcDSs8 token.chair-coin-3.testnet.[set_policy]
PASS  hard bounds: rate within +-200 bps (a day's share of supply), step at most 50 bps, backing over 5% of the supply to seat a chair, meetings_per_day the day over the epoch
      max_rate_bps 200, max_step_bps 50, quorum_bps 500, meetings_per_day 960
PASS  launch parameters are the recorded ones
      epoch_ms 90000, impeach_threshold_bps 3000, nominate_bond 100000000000000000000000
PASS  launch supply is the recorded one
      1000000000000000000000000000000
PASS  total supply = launch + minted - burned
      1000142301970020077030984795172 = 1000000000000000000000000000000 + 152301970020077030984795172 - 10000000000000000000000000
PASS  ft_total_supply equals get_supply.total_supply
      1000142301970020077030984795172
PASS  minted supply stays inside the per-day bound: no meeting mints more than 200 bps a day spread over the day's meetings
      launch + minted 1000152301970020077030984795172, at most 1000687729216008866853121675843 after 33 meetings at +200 bps a day
PASS  recorded accounts' balances and stake never exceed the supply
      recorded accounts hold 950088600541375827963959492702, unclaimed rewards 47310385199221629001195172, supply 1000142301970020077030984795172 (the rest is in accounts not in the record)
PASS  each reasoning text, from the transaction or docs/, hashes (SHA-256) to the reasoning_hash the chain holds
      16 of 24 decisions on chain have a text (16 in the transaction, 0 in docs/), 16 of them match

now: epoch 32: rate 23 bps, chair challenger.chair-coin-3.testnet, streak 21; supply 1000142301970020077030984795172 (launch 1000000000000000000000000000000, minted 152301970020077030984795172, burned 10000000000000000000000000), staked 406571000000000000000000000000

latest decisions on chain (5 of 24, newest first):
  epoch 32, rate +23 bps, reasoning_hash df3357d2dfb11be70394eb61f138c656b11e6c563dcf91f1c4d33e4f94f6ba67
      "$CHAIR decision, epoch 32, chair rule-v1. Chair local:qwen3.8-27b failed (timeout). The rule chair d..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain
  epoch 31, rate +23 bps, reasoning_hash ef83f980c78122c23f0ec67b6982decd914d4e3c6f9312b5b75d3837710e2705
      "$CHAIR decision, epoch 31, chair local:qwen3.8-27b. Rate in effect 29 bps; decision 23 bps. The Comm..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain
  epoch 30, rate +29 bps, reasoning_hash cf4b5a9788b53609fedf9ea3675bcfefe1ea2cf285346be1524b2f372bf7b908
      "$CHAIR decision, epoch 30, chair local:qwen3.8-27b. Rate in effect 29 bps; decision 29 bps. The Comm..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain
  epoch 29, rate +29 bps, reasoning_hash bc8774067a4df05b5acc71e91518b94460874d72af68cabef9a119915731406f
      "$CHAIR decision, epoch 29, chair local:qwen3.8-27b. Rate in effect 29 bps; decision 29 bps. The Comm..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain
  epoch 28, rate +29 bps, reasoning_hash a1da84a97e28e50f9e2c294f63e7a44bcd08636e6377c1fec4b5fdd27f29dd5c
      "$CHAIR decision, epoch 28, chair local:qwen3.8-27b. Rate in effect 29 bps; decision 29 bps. The Comm..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain

latest decisions with a checkable text (3 more):
  epoch 27, rate +29 bps, reasoning_hash ca77873644a142ee5992e62630f4b09a88b71c70673bd877356fe19ff9db8f5a
      "$CHAIR decision, epoch 27, chair rule-v1. Chair local:qwen3.8-27b failed (timeout). The rule chair d..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain
  epoch 26, rate +29 bps, reasoning_hash 7b7bb5906496b02f05ac7d130ea74f98ee6952e85924bd6d533bbe79272458fe
      "$CHAIR decision, epoch 26, chair local:qwen3.8-27b. Rate in effect 29 bps; decision 29 bps. The Comm..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain
  epoch 25, rate +29 bps, reasoning_hash 128c250b6ac267b1c0404ed1c8f11bd60c2b81a6e9d77ad68f5c43e85f8ea653
      "$CHAIR decision, epoch 25, chair local:qwen3.8-27b. Rate in effect 26 bps; decision 29 bps. The Comm..."
      SHA-256 of the text in the transaction's arguments equals the hash on chain

decisions with no checkable text (8 of 24), by epoch: 1 to 4, 7 to 10

OK: 13 checks passed
```

Every transaction of the scripted run, with its hash, is in [`docs/testnet-deployment.json`](testnet-deployment.json); the run logs are `docs/testnet-run-*.txt`. How it was deployed and how to redeploy: [`deploy/README.md`](../deploy/README.md).
