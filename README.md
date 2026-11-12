# $CHAIR

An AI runs this memecoin's central bank. The contract keeps it on a leash.

$CHAIR is a coin on a test network (NEAR testnet, not the real one). An AI called the Chair decides, every 90 seconds, whether to print more coins for the holders who staked them or to burn some, and writes down why. The coin's contract is the leash: it refuses to let the Chair print more than 2% of all coins a day, or burn more than 2% of any transfer, and nobody can change that rule.

Try it, no install: <https://wonkared.github.io/chair/>

- **Make the Chair overreach.** Type a rate beyond the limit (2% a day) and watch the contract refuse it, on the real testnet, in its own words.
- **Join the Committee.** One button stakes a small step of test coins from a pool account the project controls; a meeting later the Chair's own minutes cite the changed staked share and the rate it then chose.
- **Get your own test coins.** The page makes a key in your browser, and my faucet funds a new testnet account with 50 test CHAIR and a little test NEAR for gas. You then stake, unstake, claim and send with your own signature. They are test coins from an account I control, 10,000 in all, and the faucet is off whenever my workstation is off.
- **Ask the Chair a question.** The answer is added to the Chair's minutes on the chain. The Chair replies with a line from a reviewed book of statements, never free text, and the desk that takes questions is closed whenever my workstation is off (the page says so).

The Chair's latest minutes, the written record of a decision, as of 2026-11-11:

> The Committee of One has met. The Chair changes the rate from printing 0.29% a day to printing 0.23% a day, a little at every 90-second meeting, for holders who staked. 40.65% of all coins are staked. Supply has moved less than 0.01% over the last 6 meetings. The Chair asks that this be recorded.
>
> Meeting 31 (an "epoch" in the technical sections below), written by the AI model running on my own GPUs in the chair's seat. The text is public in [the transaction](https://testnet.nearblocks.io/txns/8c7e6FYiHMob4diojGo9RPj8y6LP6WPtmvBXtEQb7izN), and its SHA-256, a fingerprint of the text, is the `reasoning_hash` the chain holds.

## The worst case, plainly

The Chair can print at most 2% of all coins a day. A meeting comes every 90 seconds, and each one prints 1/960 of that day's rate: a meeting mints `supply * rate / (10_000 * meetings_per_day)`, with `meetings_per_day = ceil(86_400_000 / epoch_ms)`, which is 960 at 90 seconds. It cannot jump to that ceiling either: the rate moves at most 0.5% a meeting, so getting there takes 4 meetings. Even if the Chair holds the rate at the ceiling forever, the supply grows by at most about 2.02% a day (exactly 2.02011%: the 2% plus a little, because each meeting's new coins count toward the next), about 1.15 times in a week and about 1.82 times in 30 days. The only hard stop is a supply limit written into the code (`MAX_TOTAL_SUPPLY`, `u128::MAX / 10_000`), about 34,000 times the launch supply, and a Chair at the ceiling would need about 17 months to reach it. The rate is per day for epochs of 12 hours or less, and at most that rate per day for longer ones (the divisor is rounded up; [`SPEC.md`](SPEC.md), "The leash in numbers"). Three things restrain it further:

1. **Holders can fire the Chair.** Anyone who stakes can back a challenger. A challenger with more than 30% of the staked coins behind them (and more than 5% of all coins) takes the seat at the next meeting. This has already happened on the testnet, at meeting 10 ([`6Wd6BQSZ...`](https://testnet.nearblocks.io/txns/6Wd6BQSZ7GdNYcD2sXkaubK86y4DSnAYeVWnT2SWE7Cn)). My own scripted accounts did it, not a crowd.
2. **New coins go only to people who staked.** Nothing is printed while nobody is staked, and every printed coin goes to the stakers: the same people who can fire the Chair. Holders who do not stake are diluted. Stake or be diluted.
3. **A silent Chair fades out.** Each meeting without a decision moves the rate 0.5% toward zero, and at zero nothing is printed.

The page shows this live under "What holders control" (the staked share, the seated Chair, any challengers and how far each is from the bar), and it computes these figures from the contract's own numbers (`get_params`, including `meetings_per_day`; `web/site/js/bound.js`). A token that does not report `meetings_per_day` is the older per-meeting rule, and the page then states that rule's much faster worst case instead.

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

$CHAIR is a central bank for a memecoin, with an AI in the chair. Once per epoch the AI prints new tokens or burns some, publishes its minutes (the written reasoning, hashed on chain), and any holder who stakes can vote to impeach it. The page shows the chair's minutes as they land, every refusal by the contract, and every mint and burn, read straight from the chain by your browser. A visitor can put one question to the Chair there; the answer is entered into the minutes on chain. The Chair replies only with a line from a reviewed book of 144 statements ([`chair-agent/src/press-book.ts`](chair-agent/src/press-book.ts)); a locally run model only picks which line, so the model never writes a press answer. The press desk that takes the questions runs on my workstation, so it is closed whenever that machine is off, and the page then says "The Chair is not taking questions at this time."

The leash is the contract: it refuses any rate beyond 2% (200 bps) either way and any move of more than 0.5% (50 bps) per epoch, a silent chair's rate decays to zero, stakers can vote the chair out, and there is no admin or upgrade method. The rate is per day, spread over the day's meetings, and it is not a total: held at +200 bps the supply still grows by at most about 2.02% a day (1.82 times in 30 days), which is why the vote and the decay matter (see [The worst case, plainly](#the-worst-case-plainly)).

Built for the NEAR HACKATHON, track **Memecoins With Mechanics**. The mechanic lives in the contract, not in a backend somebody could switch off.

The chair has a voice: **The Chair**, a deadpan parody of a central banker, solemn and self-important about tiny moves, held to the numbers it was given (it invents no figure, claims no effect the data does not show, and says nothing about price). It changes only the wording of the reasoning text the agent writes and hashes; the rate rules and the contract's bounds are the same. A line from the locally run model in an offline probe, not an on-chain decision, in the earlier wording that counted in basis points (the minutes now say percent and meetings, as in the quote at the top) ([`docs/chair-voice-probe.txt`](docs/chair-voice-probe.txt) keeps every answer and its check): "The Committee of One has met. The Chair has seen the numbers and remains the Chair. The motion to hold the rate at 190 basis points carries unanimously, and the supply change over the last six epochs was zero basis points. The Chair asks that this be recorded."

## The running chair, and the page

A chair agent (`chair-agent/scripts/run-chair.sh`: the `qwen3.8-27b` model run locally on my own GPUs, with the rule chair deciding whenever the model is unavailable) has been running since 2026-11-11 and sets the rate once per epoch; if it stops, the contract decays the rate toward zero. It reaches the chain through a list of public RPC endpoints (a comma-separated `CHAIR_RPC_URL`): a read that fails moves to the next endpoint, and a signed transaction is sent to another endpoint only when the first refused it before taking it, and moving it never signs it again. Token: [`token.chair-coin-3.testnet`](https://testnet.nearblocks.io/address/token.chair-coin-3.testnet), epochs of 90 s.

- Accepted `set_policy` by the launch chair, +40 bps (epoch 1): [`26tWcCFj...`](https://testnet.nearblocks.io/txns/26tWcCFjehFhcs9FMqmaFhwQ8SVLqjj8DoeCqKC8Muno); twin: `tx 26tWcCFjehFhcs9FMqmaFhwQ8SVLqjj8DoeCqKC8Muno | jq -r '.transactions[0].receipts[].execution_outcome.outcome.logs[]'` prints its `policy_set` event
- **The page**: the Chair's latest minutes in the hero, then one line of the Chair's, the **Press conference** panel, **What holders control** (live staked share, the seated chair, challengers against the impeachment bar), then **Chair minutes** (every decision the chair has put on chain, newest first, with its rate, the reasoning text and a mark). The chair sends the text in the same `set_policy` call as an extra `reasoning` argument the contract ignores, so it is public in the transaction; your browser reads it there, computes its SHA-256 and compares it with the `reasoning_hash` in the chain's event. The page also has a section, **Times the contract told the Chair no**: every `set_policy` the contract turned down, with its panic text. Open it with `make -C web serve`, then http://127.0.0.1:8080/ (needs Node 22.22.2 or newer and npm; if the port is busy, the command says so and `PORT=8081 make -C web serve` uses another). What happens when a decision has no text is under [Verification](#verification).
- No browser: `git clone https://github.com/WonkaRed/chair.git && cd chair && make -C deploy verify` runs 13 read-only checks (12 if the transaction index cannot be reached), then lists the latest decisions from the chain with the start of the reasoning text and whether its SHA-256 equals the hash on chain, and the epochs that have no checkable text ([Verification](#verification)).

## Make the Chair overreach

A section of the page lets a visitor type a rate and watch the contract refuse it. The press desk sends a real `set_policy` call from the chair account on NEAR testnet, the contract refuses it, and the page shows the contract's own refusal text, the bound it hit, the transaction (explorer link and a `curl` that reads the failure from a public RPC), and a scripted line from the Chair, labelled as scripted.

- **Only rates beyond 200 bps either way are sent.** The contract refuses those whatever the Chair's rate or the epoch. A rate inside the limit is answered "not sent": whether the contract would accept it depends on state that moves, and an accepted call would change the token's real rate. The desk checks this, and the signer checks it again before it signs.
- **Who signs:** the chair account's own function-call key (scoped to `set_policy` on the token), the only key that account has. The call carries a fixed reasoning text starting `$CHAIR overreach test.`; no visitor text goes on chain. The page marks refusals that match it, signed by a chair account and beyond the limit, as forced by a visitor, so they are not read as the AI chair's own.
- **Timing:** the contract checks "already set this epoch" before the range, and the AI chair decides within seconds of each epoch boundary, so the desk sends at the start of the next epoch (the wait is up to one epoch; while it runs, the page says why and shows the newest refusal already on chain, labelled as an earlier one, with its transaction). If the Chair gets there first the refusal comes back as "already set" and the page says so.
- **Limits:** one attempt on chain at a time, 20 s apart; 5 per address per hour, 30 per hour and 300 per day over all addresses. Each attempt costs the chair account about 0.0002 NEAR of testnet gas (measured: 0.000163 NEAR).
- **Off unless `CHAIR_OVERREACH_KEY_FILE` is set** (the `chair3-press` unit sets it; remove the line to switch it off). It runs on the press desk, so it is closed whenever my workstation is off; the page then says so and lists the refusals recorded on chain.

Refusals on the new token so far are from the scripted run (every one is on the page under "Times the contract told the Chair no", each readable with the `curl` the page shows):

| Transaction | Asked for | The contract said |
|---|---|---|
| `8AB8SGqGAfiWfPerFDPxv29DYg9FL2XrEbGzctZEHLMu` | +201 bps | `rate_bps out of bounds: must be within -200..=200` |
| `LQLdPaCKnWvx356ua1h6Zxc57RU8p4intMmswc2BRLQ` | +100 bps, from +190 | `rate step too large: must move at most 50 bps from the current rate` |
| `4ezzLDqadCD7FHbKqSxa2MibL37iQRya15bM2eBF9Luz` | +150 bps, a second decision in an epoch | `policy already set this epoch` |

Code: [`chair-agent/src/press-overreach.ts`](chair-agent/src/press-overreach.ts), the page side in [`web/site/js/overreach.js`](web/site/js/overreach.js).

## Join the Committee

A second section of the page has one button. The press desk has a pool account that holds test coins and this project controls; a press stakes one step of them on the token contract (`stake`), or, once the pool is full, takes one step back out (`unstake`). The page shows the real transaction and the staked share read from the chain before and after, counts down to the Chair's next meeting, and then quotes the Chair's own minutes for it with the share marked, with one plain sentence computed from the data. The page claims a cause only when the data supports it: the minutes must state the share, the rule chair's arithmetic at that share without the press must give a different rate than the one chosen, and then it reads "More coins are staked, so the Chair printed less: 1.10% a day before, 0.97% a day now." When the model chose the rate, the page says only what the press did to the Chair's target and what the Chair then set ("This press moved the Chair's target from 0.29% to 0.24% a day. The Chair then set 0.24% a day, down from 0.29%."), with no cause claimed. A share that other accounts moved the other way, a step too small to move the target, or the 0.50% a meeting step limit is said as exactly that.

- **A step is 2% of the current total supply** (floored), and the pool holds at most 2 steps (4% of supply, under the 5% quorum). Direction is automatic and read off the chain: a press stakes while there is room for another step (a join with less than a whole step of room, because a step is a share of a supply that changes every meeting while the stake does not, stakes just that room, so the cap stays exact) and, once the pool is at its cap, takes one step out; after ten idle minutes the desk takes the whole stake back out. The contract locks a stake for two epochs, so a step out right after a step in is answered "not yet", with the time, and nothing is sent.
- **A visitor can never impeach the Chair with this.** The only calls the pool's signer can build are `stake` and `unstake` (`PoolSigner` in `chair-agent/src/signer.ts`): it backs no challenger and transfers nothing, and the desk also refuses to sign when the chain says the pool backs one. Impeachment needs a challenger with more than 30% of the staked coins and more than 5% of the whole supply; the pool's 4% could not reach the second even if it backed one.
- **Capped against the chain, not against memory.** Every press reads the pool's stake at the newest block and signs only if the call keeps it within the cap; if the read fails, nothing is signed.
- **One step is the smallest move the Chair acts on.** The mandate's target moves by (2% of supply) / 40, about 0.05% a day, and the Chair ignores a difference under 0.05% a day, so one press is just enough to matter; when it does not, the page says "held the rate" and why instead of crediting the press. The step and the cap are `stepBps` and `capSteps` in `DEFAULT_JOIN_LIMITS`; the desk reports them in `GET /join/state` and the page's help text reads them from there.
- **Limits, in memory:** 3 presses per address per hour, 20 an hour and 200 a day over all addresses, one on chain at a time. A visitor who hits one is shown the most recent real press (its transaction, the share before and after, the minutes that cited it) beside the reason. The desk also remembers the latest press for `GET /join/state`, and the page keeps the latest it has seen in `localStorage`, so a closed desk still shows one.
- **The key.** `stake` and `unstake` need an attached deposit, which a function-call key cannot attach, so the pool account's key is a full-access key. It is safe to hold only because the account holds nothing but the pool's test coins and a few NEAR for gas, only `PoolSigner` can use it, and the feature switches itself off, saying why in the log, when the key is not full access (it would fail every call).
- **Cost:** a press costs the pool account the gas of one `stake` or `unstake` call, at most 0.003 NEAR (30 Tgas at the testnet gas price); the 0.01 NEAR a stake attaches is refunded except for the first stake's record. `set_policy` measured 0.000163 NEAR; the pool calls are not yet measured on testnet.
- **Off unless `CHAIR_VISITOR_KEY_FILE` is set** (with `CHAIR_VISITOR_ACCOUNT` naming the pool account). `/health` reports `join: true|false`. The pool account must be registered with the token (`storage_deposit`) and funded with test coins (an `ft_transfer`) of at least 4% of supply plus one step, and with NEAR for gas. Like the overreach toy it runs on the press desk, so it is closed whenever my workstation is off; the page then shows the latest press on record, or hides the section if it has none.

Code: [`chair-agent/src/press-join.ts`](chair-agent/src/press-join.ts), the page side in [`web/site/js/join.js`](web/site/js/join.js).

## Your own test coins

A third section of the page, "Your own test coins", lets a visitor hold coins of their own. One button makes an ed25519 key in the browser (WebCrypto, kept in that browser's `localStorage`); the account is the key's public half written as 64 hex characters, so nobody has to create it, and only that public half goes to my press desk. The desk's faucet then sends three transactions from the faucet account `chair-faucet-3.testnet`: 0.05 NEAR for gas, the token's `storage_deposit` for the new account, and an `ft_transfer` of 50 CHAIR. After that the visitor stakes, unstakes, claims and sends with their own signature, each call signed in the browser and sent to a public testnet node; the desk never sees the key and has no part in it.

- **Bounded:** 5 grants an hour and 20 a day over all visitors, 3 a day per network address (so a laptop and a phone on one wifi can each have one), and 200 in total: 200 x 50 = 10,000 coins, about 1% of the 1,000,000 launch supply. Seating a challenger takes backing over 5% of all coins (and over 30% of the staked ones), so visitors with the faucet's coins could never vote the Chair out. The totals are kept in a file, so a restart does not give the budget out again; the per-address count is in memory.
- **The faucet can do three things:** its signer (`FaucetSigner` in `chair-agent/src/signer.ts`) builds only those three calls, with the amounts fixed in code. Each is saved as its signed bytes before it is sent, so a crash or a lost answer resends the same transaction instead of paying again. The account holds only the faucet's budget (200 grants x (50 CHAIR + about 0.06 NEAR), about 12 NEAR), and its key is a full-access key (the desk refuses to start the faucet with any other).
- **Off, killed, dry or spent:** the faucet is off unless `CHAIR_FAUCET_KEY_FILE` is set, and a file named by `CHAIR_FAUCET_KILL_FILE` closes it the moment it exists. It also closes when the account runs low or the 200 are given, and the page then says it is closed. While the desk cannot be reached the panel says so and looks again by itself.
- **The honest limit:** these are test coins with no value, from an account I control, and the desk runs on my workstation, so new grants stop whenever it is off. Accounts already funded keep working, since staking, claiming and sending go straight to the chain. There is no captcha: someone determined can use up the caps and keep the faucet closed for a while, and the caps and the kill file are the defence.

Code: [`chair-agent/src/press-faucet.ts`](chair-agent/src/press-faucet.ts), the page side in [`web/site/js/mine.js`](web/site/js/mine.js); the details are in [`chair-agent/README.md`](chair-agent/README.md).

## It runs on NEAR testnet

Launch supply 1,000,000. The token account was created, given its code and initialised in one transaction that adds no key, so it has no access key and nobody can upgrade it or move its NEAR.

This is the second token. The first, `token.chair-coin-2.testnet`, took its rate per meeting, so a rogue Chair at the ceiling could compound 2% every 90 seconds; I made the rate per day for that reason. Its records stay in [`docs/chair-coin-2/`](docs/chair-coin-2/), and the logs of the agents that chaired it are the `docs/testnet-run-agent-*` files, indexed in [`docs/ai-chair-runs.md`](docs/ai-chair-runs.md).

- The impeachment: stakers backing 400,000 of 400,000 staked tokens seat `challenger.chair-coin-3.testnet`; the contract applies the vote in the first call after meeting 10, [`6Wd6BQSZ...`](https://testnet.nearblocks.io/txns/6Wd6BQSZ7GdNYcD2sXkaubK86y4DSnAYeVWnT2SWE7Cn) (its `impeached` event)
- The chair's key can call `set_policy` and nothing else: the protocol refuses any other method signed with it (`MethodNameMismatch`, no transaction exists to link; the run log shows it).

An AI model has chaired this token live. `qwen3.8-27b`, the local server's name for a 4-bit quantized community fine-tune of Qwen3.8-27B run on my own GPUs (no cloud API, no Claude model), has held the seat as `challenger.chair-coin-3.testnet` since epoch 17. Each epoch it reads the on-chain numbers, chooses a rate and writes its reasoning; the SHA-256 of that text is in each transaction, for example [`6eGCY5a7...`](https://testnet.nearblocks.io/txns/6eGCY5a7tXN2TUCJ9LNv7oBpKAUu2wQGeHaECcQ9kCn5) (epoch 19) and [`7RjKgZcr...`](https://testnet.nearblocks.io/txns/7RjKgZcrdN1rywMib4jUr9H8domQ9Sc8eKX114cU4bEq) (epoch 22), both readable without the explorer with the `curl` from the box at the top. The contract holds the model to the same bounds as anyone else. When the model times out, the rule-based chair from `chair-agent/` decides that epoch (24, 27, 32 and 34 so far). Its reasoning is recorded, not vouched for; what the model got wrong in its runs on the previous token is in [`docs/ai-chair-runs.md`](docs/ai-chair-runs.md).

Every decision the agent made carries its reasoning text in the `set_policy` transaction itself ([`chair-agent/README.md`](chair-agent/README.md)), so anyone can read it from the chain and hash it. The scripted run's eight decisions carry none, see [Verification](#verification).

The token's testnet activity (transfers, stakes, claims) comes from `activity/`: scripted test activity by three accounts I control, not organic users. It acts every 6th epoch and never nominates, backs or sets policy. Accounts that visitors make with "Your own test coins" can add their own stakes, claims and transfers to the ledger; the faucet funded them.

Below the chair minutes the same page lists every mint and burn and checks the sums against the contract's own `get_supply`.

## What it is

$CHAIR is a NEP-141 token on NEAR. Time is cut into epochs of fixed length. Once per epoch the current **chair** account may call `set_policy(rate_bps, reasoning_hash)`:

- A positive rate **eases**. The rate is basis points of supply **per day**: at the end of each epoch the contract mints `total_supply * rate / (10_000 * meetings_per_day)` into a reward pool paid to stakers, where `meetings_per_day = ceil(86_400_000 / epoch_ms)` (960 for 90-second epochs).
- A negative rate **tightens**: during that epoch every transfer burns `|rate|` bps of the amount (per transfer, not per day), and nothing is minted.
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
test result: ok. 68 passed; 0 failed; ...      # contract/ unit tests (policy math, rollover, rewards, launch checks, withdrawal)
test result: ok. 0 passed; 0 failed; ...       # contract/ doc-tests: there are none
test result: ok. 7 passed; 0 failed; ...       # sandbox-tests/ against the real wasm: 10 files, one line each (7, 7, 2, 9, 3, 3, 2, 10, 3, 7 tests)
```

The sandbox files hold 53 tests in all. The other lanes run 363 (`chair-agent`), 95 (`sim`), 230 (`web`) and 31 (`activity`) tests, and `deploy` runs 49 (`make -C deploy test`).

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
| `meetings_per_day` | derived: `ceil(86_400_000 / epoch_ms)` | Epochs in a day, the divisor of an easing mint: 960 at 90 seconds |
| `max_rate_bps` | **200**, a constant in the code | The chair's rate must satisfy `-200 <= rate_bps <= 200`. Easing is basis points of supply per day, so +200 is 2% a day |
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

Silence does not unseat the chair. Each epoch without a decision moves the rate 50 bps toward zero, and at zero nothing is minted or burned. A silent chair keeps the seat and may decide again in any later epoch. Only a stake vote replaces it: a nominated candidate backed past the threshold and the quorum. This has happened on testnet: epochs 11 to 16 passed with no decision, the rate fell from -10 bps to 0, and `challenger.chair-coin-3.testnet` kept the seat and decided again at epoch 17.

## Verification

Every decision the agent made carries its reasoning text in the `set_policy` transaction, and `verify` checks each text it finds against the hash on chain and prints the counts. The chain also holds 8 older decisions with no checkable text, which `verify` lists by epoch: 1 to 4 and 7 to 10, by `chair.chair-coin-3.testnet` in the scripted run (it sent only the hashes, and the chain shows nothing more about them).

Read-only. It needs no key and no Rust build, only `git`, `make`, npm, Node 22.22.2 or newer and network access, and took about 5 s here with the packages installed (the first run installs the 72 packages of `deploy/` first). The command is the one in the box at the top. It prints 13 checks, then a `now:` line, the latest decisions and the epochs that have no checkable text, and exits 0 only if every check passes. The last check finds a reasoning text for each decision on chain, from the `reasoning` argument of its `set_policy` transaction or, for decisions made before the agent sent it, from the chair's saved text in `docs/`, recomputes its SHA-256 and compares it with the `reasoning_hash` the chain holds for that decision; a text that does not match fails the command. A decision with neither text is not an error: it is counted and its epoch is listed. `verify` reads the decisions from a third-party transaction index (FastNEAR, the one the page uses): if the index cannot be read, it prints one `NOTE:` line instead of the decisions, skips that check and does not count it (12 checks; the others read the RPC only), and exits by the remaining checks. With `WASM=<file>` it adds one more check, that the code on chain equals your local wasm ([`deploy/README.md`](deploy/README.md)). The recorded run in [`docs/testnet-run-verify.txt`](docs/testnet-run-verify.txt) used `WASM`, so it shows 14 checks: the 13 below, plus the wasm check.

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
- **The faucet gives away stake, so it is capped.** Anyone can have an account funded, 3 a day per network address, but the faucet gives at most 10,000 coins in all, about 1% of the supply against the 5% quorum ([Your own test coins](#your-own-test-coins)). The limit is in my press desk, not in the contract.
- **The quorum is what keeps a tiny stake from seating a chair.** Without it, one yocto staked and backed would be 100% of the stake. With it, nobody can be seated while less than 5% of the supply backs them. So the token's owner should stake at launch; until over 5% of the supply is staked and backed, the launch chair cannot be replaced.
- **A coordinated bloc beats a larger, scattered majority.** The sitting chair cannot be nominated, so it can never be backed against a challenger. A bloc holding more than the threshold (30% in the demo and tests) of the staked tokens can seat its candidate even if the other 70% would have kept the chair, unless those 70% back a rival; backing is one candidate per staker.
- **Mints go only to stakers, so people who never stake are diluted.** At the maximum rate, +200 bps a day (reached four epochs after the first easing decision, in +50 steps), each epoch mints 1/960 of 2% of the supply, so with 90-second epochs the supply grows by at most about 2.02% a day: about 1.15 times in a week, 1.82 times in 30 days. The supply cap `u128::MAX / 10_000` is about 34,000 times the launch supply of a 1,000,000-coin token (10^30 base units) and a chair at the maximum rate would need about 500,000 epochs, roughly 17 months, to reach it. A holder who neither stakes nor claims keeps the same token count and a shrinking share. The opposite lever, -200 bps, burns 2% of every transfer (per transfer, not per day). Beyond the rate bound, what restrains a bad chair is the vote and the decay: see [The worst case, plainly](#the-worst-case-plainly).
- **Staking just in time earns every boundary.** Stake in the last block of an epoch, unstake when the two-epoch lock ends, stake again in the last block before the next boundary, and repeat: that account is liquid for about half of each cycle and still earns at every boundary. It dilutes no one beyond a continuous staker of the same size, but the lock does not force holders to stay.
- **A nomination cannot be withdrawn out from under its backers.** `withdraw_nomination` is refused while any account other than the nominator backs the candidate (the candidate's backing is more than the nominator's own stake on it), so a nominator cannot wipe the backing in the last block and re-nominate. The same rule lets any staker, even with 1 yocto, keep a nomination from being withdrawn: its bond then returns only at an impeachment or an eviction.
- **A nomination can squat on a candidate account.** `persona_hash` is not checked against anything, so a nominator can occupy a candidate account with a nomination whose hash is wrong, and nobody else can nominate that account while it stands.
- **Nominations are spam-limited by a bond and by stake.** A bond in NEAR makes spam cost money. A full list of ten gives a slot only to a nominator whose own stake exceeds the backing of the least-backed nomination, so ten accounts holding 1 yocto cannot lock the list against a real holder. Freezing it against everyone costs ten accounts that each stake more than the largest honest staker (a little over ten times that stake, which must stay staked to hold the slots, though it keeps earning the mint); stakers who want a slot can pool their tokens into one account. It does not make candidates good.
- **Initial distribution is whatever `owner_id` does with the whole supply.** The mechanic does not design distribution.
- **The chair is trusted with a small, bounded lever.** At most 2% of supply a day (about 2.02% once the meetings compound) can be minted, and the launch chair's key can do nothing but `set_policy` within the bounds. The reasoning hash is a commitment, not a proof of anything: the contract cannot tell whether an AI, a person or a script made the decision.
- **Time is block time.** For epochs of a minute or more, validators can skew it by seconds, not by epochs.
- **Rollover is lazy.** NEAR has no cron, so an epoch boundary is applied by the first call after it. Views show the correct current state; events for earlier epochs are logged when the next call arrives.
- **Not audited by a third party.** Internal adversarial reviews by AI agents shaped the rules. Tested in a local sandbox and deployed to NEAR testnet (`token.chair-coin-3.testnet`); not deployed to mainnet.
- **The "no upgrade path" guarantee needs the documented deployment**: one transaction, signed by a parent account, that creates the token account, deploys the wasm and calls `new`, and adds no key ([`SPEC.md`](SPEC.md) "Deploying"). `new` is callable by anyone on a deployed but uninitialized contract, so a separate deploy and `new` could be front-run, and a leftover full-access key could redeploy the contract. The sandbox tests launch it exactly this way.
- **`new` bounds two parameters, not everything**: the threshold is at most 50% of the stake and the bond at most 100 NEAR, so those two can never make the chair unremovable, and the supply cannot be launched to the token account itself. A launch can still make the chair permanent in two ways the code does not stop: it can park the supply with an `owner_id` that never stakes (the quorum is 5% of the supply), or set an epoch as long as a year. Both are visible before anyone buys: `get_params` shows the epoch length and the owner's balance and stake show where the supply sits.

## Troubleshooting

Under heavy machine load the local sandbox node has occasionally stopped mid-run (`Sandbox failed to fast forward: error sending request`). Rerun the test, and run the sandbox suite with no other sandbox running.

## AI-generated code disclosure

All code was written by AI agents (Claude Fable 5.2, Opus 5.5 and Sonnet 5.5, Anthropic), directed by one human.

Two chairs have run on testnet: the rule-based agent (`chair-agent/`, `rule-v1`: no model, no API key) and the LLM chair driven by `qwen3.8-27b` on my own hardware (labelled `local:qwen3.8-27b` in every log line). Which decisions have saved text, and which are on chain without it, is under "It runs on NEAR testnet" above; the runs are in [`docs/ai-chair-runs.md`](docs/ai-chair-runs.md). The LLM chair has never been run against the Anthropic API, so no Claude model has chaired a run.

## Sister project

My other, independent entry in this hackathon is **Preflight**: <https://github.com/WonkaRed/preflight>. The two projects share no code and are submitted separately, per rule Q-015.

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
