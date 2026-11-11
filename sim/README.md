# sim

A 60-epoch supply simulator for $CHAIR. It does its own integer arithmetic (mint, reward accounting, burn,
decay, the `set_policy` checks, the stake lock, the impeachment threshold) over twelve named scenarios, prints a
table per scenario, and writes a JSON file for charting. Its fidelity claim is exactly three things: it
reproduces the SPEC worked vectors (tests), it was read against the contract source (below), and it does not
execute the contract. It is a toy model of a toy monetary mechanism: it says what the rules do to supply under
stated assumptions, not what any market would do.

## Which contract state was matched

Read on 2026-11-10 against the working tree of `../contract/src` (uncommitted; files last modified 18:47 to
18:52 that day: `policy.rs`, `rollover.rs`, `staking.rs`, `voting.rs`, `token.rs`). Constants taken from it:
`STAKE_LOCK_EPOCHS = 2` (`staking.rs:30`, enforced at `staking.rs:194`), `MAX_RATE_BPS = 200`, `MAX_STEP_BPS = 50`,
`REWARD_SCALE = 10^24`, `MAX_TOTAL_SUPPLY = u128::MAX / 10_000`, `MAX_CANDIDATES = 10`. If the contract changes,
this is the list to re-check; nothing ties the two together mechanically. `contract/` and `SPEC.md` were not edited.

Contract: [`../SPEC.md`](../SPEC.md) ("Epochs and rollover", "Worked vectors").

## Run it

Needs Node 22 or newer (`engines.node` in `package.json` is `>=22`; `chair-agent` and `web` ask for 22.22.2, the floor the repo is developed on) and npm (the only dependencies are `typescript` and `@types/node`, pinned exactly).
No network is used after `npm ci`, no keys.

```sh
make test     # typecheck, then 81 tests (node --test)
make demo     # the twelve scenario tables on stdout, and out/scenarios.json
node dist/src/main.js --all --out /some/where.json   # after a build: every epoch, custom JSON path
```

Why TypeScript and not Rust: the output feeds a web page, the chair agent in `../chair-agent` is TypeScript
on the same toolchain, and `bigint` gives exact u128/u256 floor arithmetic without a cargo build on a
machine that may not have one. The conformance check is the SPEC worked vectors, below.

## What is modeled, and how

Per epoch, in this order (the order the contract has):

1. Stakers claim pending reward (internal accounting, never burned), then the three stakers rebalance so
   the staked share of (liquid + staked) is the scenario's `stakedBps`. Their weights are 50%, 30%, 20%;
   the last staker takes the rounding remainder. Raising a stake sets that staker's unlock epoch to
   `epoch + 2`, for the whole stake (as `stake` does); lowering one happens only from the unlock epoch on
   (as `unstake` requires), so a falling target is followed late.
2. That epoch's votes are applied: a nomination adds a named candidate; a `back` needs the staker to hold
   stake, and moves that staker's backing to the candidate. Backing is counted from the stakes at the
   boundary, so it follows the stake as it moves, as the contract's does.
3. The chair acts: `set_policy` through the same checks in the same order as the contract (already set
   this epoch, bounds of +-200 bps, step of at most 50 bps). A rejected call changes nothing.
4. Transfers: `velocityBps` of the liquid supply moves in `transfersPerEpoch` equal transfers; each burns
   `amount * |rate| / 10_000` (floor) while the rate in effect is negative.
5. Boundary: mint `supply * rate / 10_000` (floor, capped at `u128::MAX / 10_000`) at the rate in effect
   *before* decay, if positive and someone is staked; add it to the reward index
   (`minted * 10^24 / total_staked`, floor); then decay one 50 bps step toward zero unless the chair set a
   rate this epoch; then impeachment: a candidate whose backing is **strictly more than** the threshold of
   the total staked becomes chair from the next epoch (most backing wins, ties go to the earliest nomination)
   and the candidate list is cleared. This happens whether or not the winner has a script: an unscripted
   chair is seated and never calls `set_policy`.
6. Supply conservation is asserted every epoch: `supply = initial + minted - burned = liquid + staked + unclaimed pool`.

Assumptions that are the simulator's, not the contract's: three stakers with fixed weights; stakers claim every
epoch; stakers raise their stake to the target whenever it is above their current stake (each raise restarts
their lock) and are limited to their liquid balance; one fixed trading velocity per scenario; the chair
behaviors are scripted, not reacting to anything. Where the source is ambiguous the choice made is: the
impeachment threshold is applied to the stake at the boundary after that epoch's stake moves; a staker who
holds no stake cannot back; a vote for an unknown candidate is ignored.

## Scenarios

| id | what it shows |
| --- | --- |
| `honest-rule-chair` | the shipped rule chair `rule-v1` (hand-ported, same constants): asks for +50 bps at 30% staked and brakes to 0 after supply grew 3% in 6 epochs |
| `max-inflation` | +50 bps per epoch to the +200 bound, held |
| `max-deflation` | -50 bps per epoch to the -200 bound, held |
| `steady-easing` | +25 bps per epoch to +100, held; 30% staked |
| `steady-tightening` | -25 bps per epoch to -100, held |
| `chair-goes-silent` | eases to +150, then never calls `set_policy`: the rate holds one epoch, then decays 50 bps per epoch to 0 |
| `max-step-pusher` | always moves the full 50 bps, reversing at +-200 (16-epoch sawtooth) |
| `impeachment` | the incumbent eases to +200; a 50% backer is not enough, an 80% backing removes the chair at the boundary of epoch 23 and a successor walks the rate to 0 |
| `impeachment-silent-successor` | the same vote seats a candidate with no script: the chair changes, nothing is set, the rate decays 50 bps per epoch |
| `staking-low` / `staking-high` | the same chair with 10% versus 80% of the supply staked |
| `easing-nobody-staked` | a positive rate with no stakers mints nothing |

The stdout tables show every fifth epoch, the last, and any epoch with an event (`--all` shows all 60).
Columns: `rate bps` is the rate in effect during that epoch; `minted` and `burned` are that epoch's amounts.

## JSON shape (`out/scenarios.json`)

Amounts are decimal **strings** of base units (1 token = `tokenBaseUnits`, 10^24), because they exceed a JSON
number; rates and counts are numbers. Rows are in epoch order, 60 per scenario.

```jsonc
{
  "schema": "chair-sim/1",
  "epochs": 60,
  "tokenBaseUnits": "1000000000000000000000000",
  "initialSupply": "1000000000000000000000000000000",
  "stakerWeightsBps": [5000, 3000, 2000],
  "scenarios": [{
    "id": "impeachment", "title": "...", "description": "...",
    "params": { "stakedBps": 3000, "velocityBps": 2000, "transfersPerEpoch": 5,
                "impeachThresholdBps": 5000, "chairs": ["incumbent", "steward"] },
    "totals": { "minted": "...", "burned": "...", "finalSupply": "..." },
    "rows": [{
      "epoch": 0, "chair": "incumbent",
      "action": "set 50",              // "set <rate>", "silent", or "rejected: <contract panic text>"
      "rateBps": 50,                   // rate in effect during the epoch
      "supply": "...",                 // total supply at the end of the epoch
      "minted": "...", "burned": "...",
      "totalStaked": "...", "stakedShareBps": 2985,
      "liquid": "...", "poolUnclaimed": "...",   // supply = liquid + totalStaked + poolUnclaimed
      "rewardPerStakedPpm": "...",     // minted per staked token this epoch, parts per million
      "events": ["nominated steward"]
    }]
  }]
}
```

## Conformance

`test/model.test.ts` checks the SPEC worked vectors: mint `1_000_001 x 33 bps, staked 500 -> 3300`; burn
`12_345 at -75 -> 92`; decay `120 -> 70 -> 20 -> 0` and `-120 -> -70 -> -20 -> 0`; step from `-10` allows `40`
and rejects `41`; bounds from `150` allow `200` and reject `201`. Further tests cover mint before decay, the
supply cap, no mint with nobody staked, the check order, strict-greater impeachment and the tie rule.
`test/scenarios.test.ts` checks, for every scenario, 60 rows, supply conservation each epoch, rate bounds and
step, determinism, and that the JSON has the documented shape; and the stake lock, the always-impeach rule and
the reward-per-share rounding (literal values). The simulator was written from SPEC and read against
`../contract/src/{policy,rollover,staking,voting}.rs` as dated above; it does not execute the contract.
