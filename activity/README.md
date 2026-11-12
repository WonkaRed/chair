# $CHAIR testnet activity bot

**This is scripted test activity by three accounts I control, not organic users.** It exists so the live testnet token has a
small, moving economy for the chair to react to: negative rates burn on transfers, the staked share changes, stakers claim.
Nothing here pretends to be a crowd: the log lines and every record in the JSON log say so in these words, and the three
accounts are named in the run script. Testnet only; the bot refuses any RPC that is not testnet and any account that does not
end in `.testnet`.

## What it does

It wakes when the contract's epoch changes (it reads `get_policy`; the timer only decides when to look again, at most every
30 s) and, in each epoch it acts in, gives each of the three holders one action, or two with a 40% chance, from a plan seeded by
`CHAIR_ACTIVITY_SEED` and the epoch number. The plan is a pure function of the seed and the chain state (`src/plan.ts`). It acts
in the epochs that are a multiple of `CHAIR_ACTIVITY_EVERY` (a whole number, at least 1, default 1: every epoch; an invalid
value stops the start with an error). The other epochs are passed over without a log line and without a transaction; the plan
for an acting epoch is the same whatever N is.

**The default deployment runs every 6th epoch (`CHAIR_ACTIVITY_EVERY=6`), so that the holders' testnet NEAR lasts the judging
week.** With bob and carol at about 0.5 NEAR each, acting every epoch would stop them at the floor after about a day and a third.

| action | size | when it is possible |
|---|---|---|
| `ft_transfer` to another holder | 1% to 5% of the sender's liquid balance, whole tokens | the 5% is at least 1 token |
| `stake` | 2% to 10% of the liquid balance | the staked share stays at or under 60% of the supply |
| `unstake` | 2% to 10% of the staked balance | the stake is out of its two-epoch lock, and the share stays at or over 20% |
| `claim` | everything pending | at least 1 token is pending |

What is built in, not checked afterwards:

- **No governance.** The only calls the bot can express are `ft_transfer`, `stake`, `unstake` and `claim` (`src/calls.ts`,
  an exhaustive switch over four action types). Holders never nominate, back, unback, withdraw a nomination or call
  `set_policy`; the chair and its votes belong to the live demo.
- **No account is drained.** Every amount is a fraction of a balance, at most 5% (transfer) or 10% (stake, unstake) of it, so a
  balance can shrink only geometrically and never reaches zero.
- **The staked share stays in a 20% to 60% band.** Stake against unstake is weighted by where the share is (always stake at 20%,
  never at 60%) and every amount is clamped so the share cannot leave the band. The rule chair's target is 50%, so the chair
  has room to ease and to tighten.

## Run it

Needs Node 22.22.2 or newer. It reuses the testnet guards, key store, RPC reads and token views of `../deploy` and installs
that package's dependencies too.

```sh
make -C activity test                                   # offline: typecheck and unit tests, no key, no network
export CHAIR_ACTIVITY_KEY_DIR=/path/to/keys             # one <account>.key file per holder; there is no default path
activity/scripts/run-activity.sh --epochs 3             # a trial: three acting epochs, then it stops
export CHAIR_ACTIVITY_EVERY=6                           # the default deployment: every 6th epoch
systemctl --user enable --now chair3-activity            # the live unit: deploy/systemd/chair3-activity.service (see chair-agent/README.md)
journalctl --user -u chair3-activity -f                 # what it does
systemctl --user stop chair3-activity                   # stop it (SIGTERM; it finishes the call in flight)
```

The run script defaults to the live deployment (`CHAIR_TOKEN`, `CHAIR_ACTIVITY_HOLDERS`, `CHAIR_RPC_URL`) and takes
`CHAIR_ACTIVITY_EVERY`, `CHAIR_ACTIVITY_SEED`, `CHAIR_ACTIVITY_STATE_DIR` (the runner lock and the log; the live unit uses `~/.local/state/chair3-activity`) and `CHAIR_ACTIVITY_LOG` if set. Key files are read only by the bot (`KeyStore` refuses one that group or
others can read), never printed, logged or copied. The chair's own key is not used and not needed.

## The log

`activity.jsonl` in `$CHAIR_ACTIVITY_STATE_DIR` (default `~/.local/state/chair-activity`; or `$CHAIR_ACTIVITY_LOG`), one JSON object per line: `start` (N, the
estimated NEAR a day at N, the days each holder lasts to the floor from the balances read at start, and which holder is first),
`near_balances` (the hourly read), `epoch` (the rate in effect, the staked share, how many actions were planned, how many
acting epochs were missed), one `action` per
call with its outcome (`success`, `refused` with the contract's panic text, or `error` when the outcome is unknown) and its
transaction hash, `read_error`, `floor` and `stopped`. Every line also goes to stdout, which is the journal under systemd.

## Failure and gas

- One failed call is logged and the next goes ahead. A failed chain read backs off 5 s, 10 s, 20 s and so on up to 5 minutes and
  retries; a good read resets it. An epoch is planned at most once, so a retry never repeats its transactions, and an epoch the
  bot slept through is logged as missed and not replayed.
- **NEAR floor: 0.05 NEAR per holder.** NEAR is read at the start and every hour. If any holder is under the floor the bot says
  which one and stops with exit status 0, before a call fails for want of gas. It calls no faucet and creates no account.
- **Cost, measured on the live token:** about 0.00025 NEAR of gas per call (12 calls: 0.0030 NEAR). The plan averages 4.2 calls
  in an acting epoch, so at 90 s epochs (960 a day) and N = 1 the three holders spend about **1.0 NEAR a day together, about
  0.34 each**; at N = 6 about **0.17 a day, 0.056 each**. The start line works out the same estimate from the balances it reads
  and says how many days the first holder lasts before the floor. It is an estimate from that measurement, not a promise.

## Tests

`make -C activity test`: `plan.test.ts` (determinism from the seed, the band, no drain, the stake lock, never governance),
`bot.test.ts` (one action round per acting epoch, every-N skipping and determinism, the start line, missed epochs, a failed call, read backoff and its cap and reset, the floor at start
and at the hourly read, stop on signal), `budget.test.ts`, `config.test.ts` (including the N validation), `log.test.ts`, `calls.test.ts`. The chain and the clock are
stubs and the clock only moves when the bot sleeps, so no test waits.
