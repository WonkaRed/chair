# How it works

[Back to the README](../README.md)

## The idea

$CHAIR is a coin on a test network (NEAR testnet, not the real one). An AI called the Chair decides, every 90 seconds, whether to print more coins for the holders who staked them or to burn some, and writes down why. The coin's contract is the leash: it refuses to let the Chair print more than 2% of all coins a day, or burn more than 2% of any transfer, and nobody can change that rule.

$CHAIR is a central bank for a memecoin, with an AI in the chair. Once per epoch the AI prints new tokens or burns some, publishes its minutes (the written reasoning, hashed on chain), and any holder who stakes can vote to impeach it. The page shows the chair's minutes as they land, every refusal by the contract, and every mint and burn, read straight from the chain by your browser. A visitor can put one question to the Chair there; the answer is entered into the minutes on chain. The Chair replies only with a line from a reviewed book of 144 statements ([`chair-agent/src/press-book.ts`](../chair-agent/src/press-book.ts)); a locally run model only picks which line, so the model never writes a press answer. The closing sentence of each meeting's minutes is different: the model writes it itself, a filter checks it before the Chair signs, and a fixed line from the book stands in when the filter refuses it (see [`chair-agent/README.md`](../chair-agent/README.md#the-chairs-own-remark)). The press desk that takes the questions runs on my workstation, so it is closed whenever that machine is off, and the page then says "The Chair is not taking questions at this time."

The leash is the contract: it refuses any rate beyond 2% (200 bps) either way and any move of more than 0.5% (50 bps) per epoch, a silent chair's rate decays to zero, stakers can vote the chair out, and there is no admin or upgrade method. The rate is per day, spread over the day's meetings, and it is not a total: held at +200 bps the supply still grows by at most about 2.02% a day (1.82 times in 30 days), which is why the vote and the decay matter (see [The worst case, plainly](#the-worst-case-plainly)).

The chair has a voice: **The Chair**, a deadpan parody of a central banker, solemn and self-important about tiny moves, held to the numbers it was given (it invents no figure, claims no effect the data does not show, and says nothing about price). It changes only the wording of the reasoning text the agent writes and hashes; the rate rules and the contract's bounds are the same. A line from the locally run model in an offline probe, not an on-chain decision, in the earlier wording that counted in basis points (the minutes now say percent and meetings, as in the quote at the top) ([`docs/chair-voice-probe.txt`](chair-voice-probe.txt) keeps every answer and its check): "The Committee of One has met. The Chair has seen the numbers and remains the Chair. The motion to hold the rate at 190 basis points carries unanimously, and the supply change over the last six epochs was zero basis points. The Chair asks that this be recorded."

## The worst case, plainly

The Chair can print at most 2% of all coins a day. A meeting comes every 90 seconds, and each one prints 1/960 of that day's rate: a meeting mints `supply * rate / (10_000 * meetings_per_day)`, with `meetings_per_day = ceil(86_400_000 / epoch_ms)`, which is 960 at 90 seconds. It cannot jump to that ceiling either: the rate moves at most 0.5% a meeting, so getting there takes 4 meetings. Even if the Chair holds the rate at the ceiling forever, the supply grows by at most about 2.02% a day (exactly 2.02011%: the 2% plus a little, because each meeting's new coins count toward the next), about 1.15 times in a week and about 1.82 times in 30 days. The only hard stop is a supply limit written into the code (`MAX_TOTAL_SUPPLY`, `u128::MAX / 10_000`), about 34,000 times the launch supply, and a Chair at the ceiling would need about 17 months to reach it. The rate is per day for epochs of 12 hours or less, and at most that rate per day for longer ones (the divisor is rounded up; [`SPEC.md`](../SPEC.md), "The leash in numbers"). Three things restrain it further:

1. **Holders can fire the Chair.** Anyone who stakes can back a challenger. A challenger with more than 30% of the staked coins behind them (and more than 5% of all coins) takes the seat at the next meeting. This has already happened on the testnet, at meeting 10 ([`6Wd6BQSZ...`](https://testnet.nearblocks.io/txns/6Wd6BQSZ7GdNYcD2sXkaubK86y4DSnAYeVWnT2SWE7Cn)). My own scripted accounts did it, not a crowd.
2. **New coins go only to people who staked.** Nothing is printed while nobody is staked, and every printed coin goes to the stakers: the same people who can fire the Chair. Holders who do not stake are diluted. Stake or be diluted.
3. **A silent Chair fades out.** Each meeting without a decision moves the rate 0.5% toward zero, and at zero nothing is printed.

The page shows this live under "What holders control" (the staked share, the seated Chair, any challengers and how far each is from the bar), and it computes these figures from the contract's own numbers (`get_params`, including `meetings_per_day`; `web/site/js/bound.js`). A token that does not report `meetings_per_day` is the older per-meeting rule, and the page then states that rule's much faster worst case instead.

## What it is

$CHAIR is a NEP-141 token on NEAR. Time is cut into epochs of fixed length. Once per epoch the current **chair** account may call `set_policy(rate_bps, reasoning_hash)`:

- A positive rate **eases**. The rate is basis points of supply **per day**: at the end of each epoch the contract mints `total_supply * rate / (10_000 * meetings_per_day)` into a reward pool paid to stakers, where `meetings_per_day = ceil(86_400_000 / epoch_ms)` (960 for 90-second epochs).
- A negative rate **tightens**: during that epoch every transfer burns `|rate|` bps of the amount (per transfer, not per day), and nothing is minted.
- The chair seat is built for an AI agent. The contract does not trust whoever holds it: the rate is bounded, the step is bounded, and each epoch the chair misses moves the rate 50 bps toward zero.
- Stakers can nominate and back a replacement. A candidate whose backing exceeds both the threshold (a share of the staked tokens) and a 5% quorum of the whole supply becomes chair at the next epoch rollover, and the chair's streak (the complete epochs the sitting chair has held the seat, `epoch - chair_since_epoch`) resets to 0. Below the quorum nobody can be seated, however little is staked.

Every launch parameter is set once in `new()` and readable by a view method. There is no admin or owner method and no upgrade path.

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

Rollover is integer arithmetic with floor rounding, specified exactly in [`SPEC.md`](../SPEC.md) with worked vectors. The whole mechanic is in the contract: epochs, `set_policy` and its bounds, the missed-epoch decay, the epoch mint to stakers, the transfer burn, staking with a two-epoch lock, and nomination, backing and impeachment. If the chair never acts, the rule is still total: the rate moves 50 bps toward zero in each epoch without a decision and stays at zero, where nothing is minted or burned. `get_supply` returns the supply ledger (launch supply, total minted, total burned) and every mint and burn emits an event with its amount and epoch.

## What the chair can and cannot do

No key can change the launch parameters. The bounds (rate within 200 bps either way, step of at most 50 bps per epoch, 5% quorum) are constants in the code. The epoch length, the impeachment threshold and the nomination bond are set once in `new` and no method writes them afterwards. The token account has no key at all. The only thing the chair's key can move is the rate, once per epoch, inside those fixed bounds.

Can:
- Choose one rate per epoch within the bounds. That is the entire surface.
- Record a hash of its reasoning, which is emitted on-chain with the decision.

Cannot:
- Exceed 200 bps either way, or move more than 50 bps per epoch. The contract panics.
- Decide twice in one epoch, or decide as anyone but the chair.
- Change any parameter, mint directly, burn directly, move anyone's tokens, or upgrade the contract. No such method exists.
- Call anything but `set_policy`: the contract gives the chair no other method, and the chair owns nothing. The **launch** chair's account also holds only a function-call key limited to `set_policy` on the token, never a full-access key, so the protocol refuses any other method before the contract runs (`MethodNameMismatch`) and the key cannot attach a deposit. A chair seated later **by vote** is an ordinary account that may hold any key and can call the public methods like anyone. The sandbox tests perform the launch setup in code (`Chair::scoped_chair`) and prove both halves; the equivalent `near` CLI commands are in [`SPEC.md`](../SPEC.md) ("The chair's key"), with flags checked against `near --help` but not run against a live network.

Silence does not unseat the chair. Each epoch without a decision moves the rate 50 bps toward zero, and at zero nothing is minted or burned. A silent chair keeps the seat and may decide again in any later epoch. Only a stake vote replaces it: a nominated candidate backed past the threshold and the quorum. This has happened on testnet: epochs 11 to 16 passed with no decision, the rate fell from -10 bps to 0, and `challenger.chair-coin-3.testnet` kept the seat and decided again at epoch 17.

## Technologies used on NEAR

- NEP-141 fungible token, NEP-148 metadata and NEP-145 storage management, via `near-contract-standards` 5.30.1
- NEP-297 events for every policy decision, mint, burn, stake, claim, nomination and impeachment
- `near-sdk` 5.30.1, built with `cargo-near-build` 0.11.5 (the library behind `cargo near build`)
- Function-call access keys, to confine the chair
- `near-workspaces` 0.24.0 with `near-sandbox` running nearcore 2.14.0, pinned in `sandbox-tests/src/lib.rs`
- Rust 1.95.0, pinned in `rust-toolchain.toml` (why this version: [`docs/testing-notes.md`](testing-notes.md))

## Layout

| Directory | Contents | Spec |
| --- | --- | --- |
| `contract/` | the token | [`SPEC.md`](../SPEC.md) |
| `sandbox-tests/` | near-workspaces tests and `make demo` | |
| `chair-agent/` | the chair: rule-based and LLM (TypeScript) | [`chair-agent/README.md`](../chair-agent/README.md) |
| `sim/` | 60-epoch supply simulator (TypeScript) | [`sim/README.md`](../sim/README.md) |
| `web/` | the page: the Chair's latest minutes, the press conference, the ledger and event log of the testnet token, and the simulation (static files) | [`web/README.md`](../web/README.md) |
| `deploy/` | testnet deployment, scripted run and read-only verification (TypeScript) | [`deploy/README.md`](../deploy/README.md) |
| `activity/` | scripted test activity on the live testnet token (TypeScript) | [`activity/README.md`](../activity/README.md) |
