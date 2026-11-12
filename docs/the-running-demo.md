# The running demo

[Back to the README](../README.md)

## What a visitor can do

- **Make the Chair overreach.** Type a rate beyond the limit (2% a day) and watch the contract refuse it, on the real testnet, in its own words.
- **Join the Committee.** One button stakes a small step of test coins from a pool account the project controls; a meeting later the Chair's own minutes cite the changed staked share and the rate it then chose.
- **Get your own test coins.** The page makes a key in your browser, and my faucet funds a new testnet account with 50 test CHAIR and a little test NEAR for gas. You then stake, unstake, claim and send with your own signature. They are test coins from an account I control, 10,000 in all, and the faucet is off whenever my workstation is off.
- **Ask the Chair a question.** The answer is added to the Chair's minutes on the chain. The Chair answers questions with a line from a reviewed book of statements, never free text (the one sentence that closes each meeting's minutes is the only part the model writes itself, checked by a filter, with a fixed line as the fallback; see `chair-agent/README.md`), and the desk that takes questions is closed whenever my workstation is off (the page says so).

## A sample of the minutes

The Chair's latest minutes, the written record of a decision, as of 2026-11-11:

> The Committee of One has met. The Chair changes the rate from printing 0.29% a day to printing 0.23% a day, a little at every 90-second meeting, for holders who staked. 40.65% of all coins are staked. Supply has moved less than 0.01% over the last 6 meetings. The Chair asks that this be recorded.
>
> Meeting 31 (the Chair holds one every 90 seconds; [how it works](how-it-works.md)), written by the AI model running on my own GPUs in the chair's seat. The text is public in [the transaction](https://testnet.nearblocks.io/txns/8c7e6FYiHMob4diojGo9RPj8y6LP6WPtmvBXtEQb7izN), and its SHA-256, a fingerprint of the text, is the `reasoning_hash` the chain holds.

## The running chair, and the page

A chair agent (`chair-agent/scripts/run-chair.sh`: the `qwen3.8-27b` model run locally on my own GPUs, with the rule chair deciding whenever the model is unavailable) has been running since 2026-11-11 and sets the rate once per epoch; if it stops, the contract decays the rate toward zero. It reaches the chain through a list of public RPC endpoints (a comma-separated `CHAIR_RPC_URL`): a read that fails moves to the next endpoint, and a signed transaction is sent to another endpoint only when the first refused it before taking it, and moving it never signs it again. Token: [`token.chair-coin-3.testnet`](https://testnet.nearblocks.io/address/token.chair-coin-3.testnet), epochs of 90 s.

- Accepted `set_policy` by the launch chair, +40 bps (epoch 1): [`26tWcCFj...`](https://testnet.nearblocks.io/txns/26tWcCFjehFhcs9FMqmaFhwQ8SVLqjj8DoeCqKC8Muno); twin: `tx 26tWcCFjehFhcs9FMqmaFhwQ8SVLqjj8DoeCqKC8Muno | jq -r '.transactions[0].receipts[].execution_outcome.outcome.logs[]'` prints its `policy_set` event
- **The page**: the Chair's latest minutes in the hero, then one line of the Chair's, the **Press conference** panel, **What holders control** (live staked share, the seated chair, challengers against the impeachment bar), then **Chair minutes** (every decision the chair has put on chain, newest first, with its rate, the reasoning text and a mark). The chair sends the text in the same `set_policy` call as an extra `reasoning` argument the contract ignores, so it is public in the transaction; your browser reads it there, computes its SHA-256 and compares it with the `reasoning_hash` in the chain's event. The page also has a section, **Times the contract told the Chair no**: every `set_policy` the contract turned down, with its panic text. Open it with `make -C web serve`, then http://127.0.0.1:8080/ (needs Node 22.22.2 or newer and npm; if the port is busy, the command says so and `PORT=8081 make -C web serve` uses another). What happens when a decision has no text is under [Verification](verify-walkthrough.md#verification).
- No browser: `git clone https://github.com/WonkaRed/chair.git && cd chair && make -C deploy verify` runs 13 read-only checks (12 if the transaction index cannot be reached), then lists the latest decisions from the chain with the start of the reasoning text and whether its SHA-256 equals the hash on chain, and the epochs that have no checkable text ([Verification](verify-walkthrough.md#verification)).

## It runs on NEAR testnet

Launch supply 1,000,000. The token account was created, given its code and initialised in one transaction that adds no key, so it has no access key and nobody can upgrade it or move its NEAR.

- The impeachment: stakers backing 400,000 of 400,000 staked tokens seat `challenger.chair-coin-3.testnet`; the contract applies the vote in the first call after meeting 10, [`6Wd6BQSZ...`](https://testnet.nearblocks.io/txns/6Wd6BQSZ7GdNYcD2sXkaubK86y4DSnAYeVWnT2SWE7Cn) (its `impeached` event)
- The chair's key can call `set_policy` and nothing else: the protocol refuses any other method signed with it (`MethodNameMismatch`, no transaction exists to link; the run log shows it).

An AI model has chaired this token live. `qwen3.8-27b`, the local server's name for a 4-bit quantized community fine-tune of Qwen3.8-27B run on my own GPUs (no cloud API, no Claude model), has held the seat as `challenger.chair-coin-3.testnet` since epoch 17. Each epoch it reads the on-chain numbers, chooses a rate and writes its reasoning; the SHA-256 of that text is in each transaction, for example [`6eGCY5a7...`](https://testnet.nearblocks.io/txns/6eGCY5a7tXN2TUCJ9LNv7oBpKAUu2wQGeHaECcQ9kCn5) (epoch 19) and [`7RjKgZcr...`](https://testnet.nearblocks.io/txns/7RjKgZcrdN1rywMib4jUr9H8domQ9Sc8eKX114cU4bEq) (epoch 22), both readable without the explorer with the `curl` from [the box at the top](verify-walkthrough.md#check-it-in-60-seconds). The contract holds the model to the same bounds as anyone else. When the model times out, the rule-based chair from `chair-agent/` decides that epoch (24, 27, 32 and 34 so far). Its reasoning is recorded, not vouched for; what the model got wrong in its runs on the previous token is in [`docs/ai-chair-runs.md`](ai-chair-runs.md).

Every decision the agent made carries its reasoning text in the `set_policy` transaction itself ([`chair-agent/README.md`](../chair-agent/README.md)), so anyone can read it from the chain and hash it. The scripted run's eight decisions carry none, see [Verification](verify-walkthrough.md#verification).

The token's testnet activity (transfers, stakes, claims) comes from `activity/`: scripted test activity by three accounts I control, not organic users. It acts every 6th epoch and never nominates, backs or sets policy. Accounts that visitors make with "Your own test coins" can add their own stakes, claims and transfers to the ledger; the faucet funded them.

Below the chair minutes the same page lists every mint and burn and checks the sums against the contract's own `get_supply`.
