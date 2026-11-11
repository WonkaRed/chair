# chair-agent

The chair: a small TypeScript program that, once per epoch, reads the $CHAIR token and calls
`set_policy(rate_bps, reasoning_hash)`. It ships two chairs behind one interface: a deterministic
rule-based chair that needs no API key, and an optional LLM chair that falls back to the rule chair
on any failure. The contract, not this program, is the authority: it rejects any rate outside +-200 bps
or more than 50 bps from the rate in effect, and decays the rate when the chair is silent. The agent
additionally never proposes a call the contract would reject.

This is a toy monetary experiment. Nothing here predicts or promises a price, a return, or any effect on
value. The rate rule is a demonstration of a mechanism, not advice.

Contract: [`../SPEC.md`](../SPEC.md) ("Methods", "The chair's key").

## Run it (offline, no keys, no spend)

Needs Node 22.22.2 or newer and npm. Dependencies are pinned exactly in `package.json` and `package-lock.json`
(`make` runs `npm ci`): `near-api-js` 7.4.0, `@anthropic-ai/sdk` 1.8.0, and dev-only `typescript` 7.0.2 and
`@types/node` 26.6.6.

```sh
make test   # typecheck, then 112 tests with node --test; no network except loopback fakes, no key; temp files go under out/test-tmp (override with CHAIR_TEST_TMP)
make demo   # 16 epochs against an in-memory model of the token; prints a table, writes out/demo-decisions.jsonl
```

The demo exercises the guard rails: the agent is "down" for two epochs (the rate decays), a scripted stand-in for the LLM answers
garbage (fallback to the rule chair) and later asks for +900 bps (clamped). No model is called: the stand-in is labelled `llm:scripted-stand-in` in the demo output and in `out/demo-decisions.jsonl`; only the real client carries the model id. It ends with `PASS` only if
every decision stayed inside the bounds and every on-chain hash matches its logged text.

## Use it against a test network

```sh
npm ci && npm run build
export CHAIR_RPC_URL=https://rpc.testnet.near.org   # any NEAR JSON-RPC endpoint; mainnet is refused
export CHAIR_TOKEN=chair.example.testnet            # the $CHAIR contract
export CHAIR_ACCOUNT=chair.example.testnet          # the chair account
node dist/src/main.js run --dry-run --once          # prints the decision and the transaction, sends nothing
```

A real run needs the chair's function-call key in `CHAIR_KEY` (the `ed25519:...` secret) or in a file whose path is
in `CHAIR_KEY_FILE` (bare key or JSON with `private_key`). The key is never printed or logged. Before signing, the
agent reads the key's permission from the chain and refuses a full-access key or any key not scoped to the
token contract and the single method `set_policy`. It also lists every key on the chair account and refuses
to run if any is full-access (SPEC: the chair account holds none); `--allow-full-access-key` downgrades that
to a loud warning. A key file readable by group or others draws a `chmod 600` warning. It refuses to act if
the contract's `get_params` bounds differ from the 200/50 this agent was built for. Without `--once` it loops,
acting once per epoch.

```
chair-agent run [--rpc <url>] [--token <acct>] [--account <acct>] [--log <file>] [--chair rule|llm]
                [--dry-run] [--once] [--allow-full-access-key] [--margin-ms <n>] [--llm-timeout-ms <n>]
chair-agent verify-log <file> [hash]     # recompute every hash; with a hash, print the text it commits to
```

`--dry-run` needs no key, signs nothing, sends nothing and writes no log. `--chair llm` needs `ANTHROPIC_API_KEY`
in the environment; without it the agent says so and uses the rule chair. The key is read only by the SDK from
that variable, never from a file, and never printed.

## The rule chair (`rule-v1`)

It wants half of the supply staked: it asks for `(5000 - staked share in bps) / 40` bps, so thin staking
eases (up to +125) and heavy staking tightens (down to -125). It never eases after supply grew more than 3% over
the last 6 epochs and never tightens after it shrank more than 3%. It moves toward the wanted rate one contract
step at a time, ignores gaps under 5 bps unless the wanted rate is 0, and with no staking figures at all it
walks the rate back to 0. It reads `get_params`, `get_policy`, `ft_total_supply` and `get_reward_pool` at one
final block; supply history comes from its own decision log.

## The LLM chair

`LlmChair` sends the model only numbers (rate, bounds, supply, staked share, drift), asks for a JSON object
`{rate_bps, reasoning}` through structured output, and uses model `claude-sonnet-5-5` via the official SDK (the chair name `llm:claude-sonnet-5-5` is reported by that client only; any other client is `llm:unlabelled-client` unless it names itself). The
agent then clamps the rate into the bounds of the window read after the model answered (see below). Any error, timeout (`--llm-timeout-ms`, default 30000), refusal,
truncated answer, wrong or duplicate keys, non-integer or out-of-range type falls back to the rule chair, and the reasoning
text says so. Model text is never used for anything but the logged reasoning: it does not reach a shell, a path,
or a transaction field other than through the SHA-256 hash.

## One decision per epoch, and the epoch it is for

A model can answer slowly, so the chain is read again after the chair answers: the agent re-checks that it is
still the chair and that the policy is not yet set, builds the rate window from the fresh read, clamps against
it, and logs the epoch the decision is actually for (a rule proposal is recomputed if the epoch rolled over; a
model answer is clamped and noted). The decision is written to the log, then sent. A paid model call happens at
most once per epoch: after a failed send the agent re-sends the logged decision, with no new model call and no
new log line, backing off 10 s then 20 s, at most 3 sends, then waits for the next epoch. If the contract
rejects the call, or the logged rate has left the window, or the logged text no longer hashes to its hash, the
epoch is given up.

## Reasoning hash and the decision log

The `reasoning_hash` argument is the lowercase hex SHA-256 (64 characters) of the UTF-8 reasoning text. The text
(a header naming the epoch and chair, any fallback or clamp note, then the chair's reasoning, capped at 2000 characters) is what is hashed,
after control characters, line and paragraph separators, and the bidi embedding, override and isolate controls (U+202A-U+202E, U+2066-U+2069) are
replaced by spaces and the invisible formatting characters (U+200B-U+200F, U+061C, U+2060-U+2064, U+FEFF) are removed. It is appended to a JSON-lines log (`decisions.jsonl`, record version 2) before the transaction
is sent, followed by an outcome record (`executed`, `rejected`, or `send_failed`, and the transaction hash). Every record carries the token and
the chair account, history is read only for that pair, and `verify-log` reports (and fails on) a log that mixes pairs. When a decision is printed,
each reasoning line is prefixed `  | `, so chair-written text cannot pass for an agent line; the prefix is not part of the hashed text, and
`verify-log <file> <hash>` prints the bare text. Text that came from the RPC node (errors, failure messages) is escaped to printable ASCII and
length-capped before it reaches the terminal or an error message. To check a hash from chain events:

```sh
node dist/src/main.js verify-log decisions.jsonl            # recomputes every hash
node dist/src/main.js verify-log decisions.jsonl <hash>     # prints the text that hashes to <hash>
```

## Layout

`src/bounds.ts` (the branded `Rate` type: a rate outside the window cannot be constructed), `rule-chair.ts`,
`llm-chair.ts`, `decide.ts` (propose, then clamp against the fresh window, hash), `chain.ts` and `rpc.ts` (validated reads), `signer.ts`
(scoped-key transaction), `log.ts`, `text.ts` (the one sanitizer), `agent.ts` (one epoch, retries), `cli.ts`, plus `fake-chain.ts` and `demo.ts`. Tests are in `test/`.

## What is and is not verified

Verified by `make test`: bounds are never exceeded over randomized inputs; every LLM failure mode falls back; hashes match
logged text; the signed transaction is a single zero-deposit `set_policy` function call (decoded and checked);
full-access and wrongly scoped keys are refused; the real RPC, signing and SDK code paths run end to end against
loopback fake servers. Verified live on NEAR testnet (`docs/testnet-run-agent-rule.txt`): the signer, RPC client and chain reader decided and sent `set_policy` as `challenger.chair-coin-2.testnet`, three epochs in a row
with the rule chair, and `verify-log` recomputes every hash. NOT verified: the LLM chair has never answered from the real Anthropic API (the one attempt was refused for lack of credit) and has not run on testnet; it is tested against a scripted stand-in.

`reasoning_hash` is a rule of the contract, not a choice of this agent: `set_policy` panics unless it is exactly 64
lowercase hex characters (`reasoning_hash must be a SHA-256 digest: 64 lowercase hex characters`), and `fake-chain.ts`
mirrors that check, in the contract's order. `test/contract-mirror.test.ts` fails if the agent ever signs another
shape or a hash that is not the SHA-256 of the text it logged. The agent calls `set_policy` only: it never calls
`back`, `unback`, `claim` or `withdraw_nomination` (now `#[payable]`, exactly 1 yoctoNEAR), `stake` or `nominate`, and its
key cannot attach a deposit. The agent acts late-epoch-safe: it picks a rate valid both before and after a
rollover that happens while the transaction is in flight (`--margin-ms`).
