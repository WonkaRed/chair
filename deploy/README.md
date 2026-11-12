# $CHAIR on NEAR testnet: deploy, run, verify

Everything here is **testnet only**. Every command connects first and refuses unless the RPC reports `chain_id == "testnet"`, and
every account id must end in `.testnet` (`src/guard.ts`: a `TestnetAccount` cannot be built from anything else, and `Rpc.connect`
is the only way to get an `Rpc`). Testnet NEAR is free; nothing here touches mainnet or real funds.

Needs Node 22.22.2 or newer (it runs the `.ts` files directly). One dependency, `near-api-js`; `verify` also reads the transaction index with the page's own modules in `web/` (a clone of the whole repo has them, no install needed).

```sh
make -C deploy test      # offline: typecheck and 44 unit tests, no key, no network
make -C deploy verify    # read-only: re-checks the live deployment from public view calls; needs no key
```

## What is deployed

The record is `docs/testnet-deployment.json` (written by the tool, one entry per transaction with its hash, what it proves and
its outcome). The run logs are `docs/testnet-run-scenario.txt` and `docs/testnet-run-verify.txt`. The previous token, `token.chair-coin-2.testnet`
(the one before the contract's rate became per day), keeps its records under `docs/chair-coin-2/`; verify it with
`node src/cli.ts verify --record docs/chair-coin-2/testnet-deployment.json`. The logs of the agents that chaired it are `docs/testnet-run-agent-*` (index in `docs/ai-chair-runs.md`).

| account | role | keys on chain |
|---|---|---|
| `token.chair-coin-3.testnet` | the $CHAIR contract | **none**: created, funded, given the code and initialised in one transaction with no `AddKey`. Nobody can upgrade or drain it. |
| `chair.chair-coin-3.testnet` | the founding chair | one function-call key: receiver the token, methods `["set_policy"]`, no allowance cap. No full-access key ever existed. |
| `challenger.chair-coin-3.testnet` | the nominated chair the stakers voted in (the scripted impeachment); the chair agent signs as this account | the same kind of key |
| `alice` / `bob` / `carol` `.chair-coin-3.testnet` | holders: two stakers and one liquid holder | one full-access key each (ordinary users) |
| `chair-coin-3.testnet` | parent, created by the testnet faucet | one full-access key; only used to fund and create the accounts above |

The chair accounts are created with the function-call key already in the creating transaction, so the "the chair holds a key that can
only call `set_policy`" claim is a property of the account's history, not a promise. The protocol (not the contract) refuses any
other call signed with it (`MethodNameMismatch`, step `e4-chair-key-ft-transfer`).

Epochs are 90 s, so a day is 960 meetings. The contract's own bounds are fixed at +-200 bps and 50 bps per epoch step; a positive rate is basis points of
supply per day, so +200 prints at most 2.02% of supply in a day, a little at each of the 960 meetings. 90 s is long enough for the busiest scripted epoch
(a decision, a transfer, a nomination and two backings, each waited to finality) and short enough for a complete run in under half an hour.

## Keys

Secret keys live only in one directory outside the repository, `~/.config/chair-testnet-keys/` by default (directory mode 700,
files mode 600, one `<account>.key` file per account; override the directory with `CHAIR_TESTNET_KEYS` or `--keys`). The tool creates a key file with
exclusive-create, refuses to read one that anyone else can read, and writes only public keys into the record. Nothing prints a
secret key. A stranger needs no keys at all to `verify`.

## Commands

```sh
node src/cli.ts bootstrap --parent <name>.testnet                  # the faucet creates the parent with 10 NEAR; its key is saved
node src/cli.ts deploy --parent <name>.testnet --wasm <file.wasm>  # creates every account, launches the token, then verifies
node src/cli.ts scenario                                           # the scripted run (about 17 minutes, resumable)
node src/cli.ts verify [--wasm <file.wasm>]                        # read-only checks (below)
```

Options: `--record <file>` (default `docs/testnet-deployment.json`), `--rpc <url>` (default `https://test.rpc.fastnear.com`; several endpoints may be given comma separated: reads move to the next on a 429 or a failure, transactions are sent through the first),
`--keys <dir>`.

`deploy` and `scenario` are **resumable**: each step has an id, and a step already in the record is skipped. A step that ends
differently from what it expects (a decision that was meant to succeed but was refused, a "refused" step that succeeded) is not
recorded and stops the run, with the transaction hash, so a rerun retries it. A scripted epoch that has already passed stops the
run rather than reshaping the story; start a new deployment then.

### What `verify` checks (public views only)

1. the token's `code_hash` equals the recorded wasm's, and the hash equals sha256 of the bytes `view_code` serves; with `--wasm`,
   also the sha256 of your own build;
2. the token account has no access key at all;
3. `chair` and `challenger` each hold exactly one key: function-call, receiver the token, methods exactly `["set_policy"]`,
   no allowance cap, the recorded public key;
4. the bounds the contract reports (`get_params`: `max_rate_bps` 200, `max_step_bps` 50, `quorum_bps` 500, and `meetings_per_day` equal to the day divided by the epoch, 960 at 90 s) and the recorded launch parameters;
5. the supply identity `total_supply = launch + minted - burned`, `ft_total_supply` equal to it, and recorded accounts' balances plus
   stake plus the reward pool not exceeding the supply; and launch plus minted staying inside the per-day bound, at most what +200 bps a day,
   spread over the day's meetings and compounded over every meeting so far, allows (1.0202011 times the launch supply after a day at 90 s);
6. every reasoning text hashes with SHA-256 to the `reasoning_hash` of the `policy_set` event the chain holds for that decision. The text comes
   from the `reasoning` argument of the decision's own `set_policy` transaction (compared with the hash in that transaction's event) or, for
   decisions made before the agent sent it, from the text recorded in `docs/testnet-run-agent-*` (the page's own bundler,
   `web/scripts/minutes.mjs`). The transactions come from the index the page uses (`web/config.js`, FastNEAR), read with the page's own code
   (`web/site/js`), so this check needs that index as well as the RPC. If the index cannot be read, `verify` prints one `NOTE:` line, skips this
   check and does not count it (12 checks; the others read the RPC only), and exits by the rest. A decision with no text anywhere is not a
   failure: it is counted and its epoch listed. A text that does not match, or a record in `docs/` that does not hash to its own hash (also
   when the index is down), is a failure.

It prints PASS/FAIL per check, the current state (it moves, since the chair keeps deciding), the five newest decisions on chain (epoch, rate,
`reasoning_hash`, and for those with a text its first 100 characters and whether its SHA-256 equals the hash), up to three more recent
decisions that have a text, and the epochs of all decisions with no checkable text; it exits non-zero on any FAIL.

## Reproduce the wasm hash

```sh
make -C contract build                 # writes contract/res/chair_token.wasm
sha256sum contract/res/chair_token.wasm
make -C deploy verify WASM=../contract/res/chair_token.wasm
```

The recorded wasm (sha256 `47a3f710...218903f`, code hash `5pexa4j7UxF3tHW1F1eVfDShRr7aWsU7HNdTT7CdsPCz`, in the record) was built from commit `8b5acb5` (the contract is unchanged since).
`verify --wasm` passes when your build is byte-identical and says so when it is not. Whether a rebuild on another machine is
byte-identical has not been checked. The deployed file itself is not in the repository; a byte-identical build of the commit above passes the check.

## Redeploy after a contract change

A deployed token has no key, so it cannot be upgraded; a changed contract is a new deployment under a new parent.

1. `make -C contract build` and copy `contract/res/chair_token.wasm` somewhere stable (a later rebuild must not change the file you deploy).
2. Pick a fresh parent, e.g. `chair-coin-4.testnet`; create a key directory with mode 700 and
   `CHAIR_TESTNET_KEYS=<dir> node src/cli.ts bootstrap --parent chair-coin-4.testnet`.
3. `CHAIR_TESTNET_KEYS=<dir> node src/cli.ts deploy --parent chair-coin-4.testnet --wasm <copy> --record <new-record>.json`
   (a new record keeps the old deployment's record, which moves under `docs/<old parent>/` as `docs/chair-coin-2/` did; `deploy` refuses a record made for another wasm, sha256 mismatch).
4. `scenario` and `verify` with the same `--record` and `CHAIR_TESTNET_KEYS`.
5. Point `web/config.js` `account` at the new token (`web/README.md`), and the agent's `CHAIR_TOKEN`/`CHAIR_ACCOUNT` at the new accounts.
6. Update the account ids in `docs/` and the READMEs.

## What the first real run taught

- A function-call key cannot attach a deposit at all, so `ft_transfer` (which needs 1 yoctoNEAR) with the chair's key is refused for
  `DepositWithFunctionCall` before the method is even looked at. The scripted step sends it with no deposit so the refusal it records is
  `MethodNameMismatch`, the method restriction.
- The scripted run took about 17 minutes. It is resumable, and a resumed run passes through epochs it already began; a step that is not
  yet recorded and would land in the wrong epoch stops the run instead.
- The rule-based agent in `chair-agent/` ran against the previous token (`token.chair-coin-2.testnet`) as the challenger (`docs/testnet-run-agent-rule*`). The LLM chair has run against it
  with a local model, `local:qwen3.8-27b` (`docs/testnet-run-agent-llm*`, `docs/testnet-run-agent-live-decisions.jsonl`), in five runs; it has never run with Claude. `tools/llm-usage-proxy.mjs` measures the spend of a run against the Anthropic API without changing the agent: it is a
  pass-through that prints tokens and dollars per call and enforces a call and dollar cap (the local run cost nothing and did not use it).

## Sandbox versus the real chain

The scripted run is the story of `sandbox-tests/examples/demo.rs`, with these differences: epochs are 90 s wall clock instead of
fast-forwarded blocks; the chair's refusals are real transactions that fail in a receipt (visible on the explorer), except the
`ft_transfer` signed with the chair's key, which the protocol rejects before inclusion and so has no on-chain transaction;
accounts, deposits and gas are real testnet ones; and a step that misses its epoch cannot be rewound.
