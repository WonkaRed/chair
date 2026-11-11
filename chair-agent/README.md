# chair-agent

The chair: a small TypeScript program that, once per epoch, reads the $CHAIR token and calls
`set_policy(rate_bps, reasoning_hash)`. It ships two chairs behind one interface: a deterministic
rule-based chair that needs no API key, and an optional LLM chair that falls back to the rule chair
on any failure. The contract, not this program, is the authority: it rejects any rate outside +-200 bps
or more than 50 bps from the rate in effect, and decays the rate when the chair is silent. The agent
additionally never proposes a call the contract would reject.

The chair writes in a voice: "The Chair", a deadpan parody of a central banker, solemn and self-important about tiny moves.
The voice changes only the wording of the reasoning text; the rate rules and the contract's bounds are untouched, and every
sentence must stay true to the numbers the chair was given (it names no real person, institution or currency and says nothing about price).
For example, from the rule chair: "The Chair raises the rate by 5 bps, from 0 bps to 5 bps. The Chair thanks itself for its service."
Decisions recorded before the voice keep their old text, because their hashes are on chain.

This is a toy monetary experiment. Nothing here predicts or promises a price, a return, or any effect on
value. The rate rule is a demonstration of a mechanism, not advice.

Contract: [`../SPEC.md`](../SPEC.md) ("Methods", "The chair's key").

## Run it (offline, no keys, no spend)

Needs Node 22.22.2 or newer and npm. Dependencies are pinned exactly in `package.json` and `package-lock.json`
(`make` runs `npm ci`): `near-api-js` 7.4.0, `@anthropic-ai/sdk` 1.8.0, and dev-only `typescript` 7.0.2 and
`@types/node` 26.6.6.

```sh
make test   # typecheck, then 158 tests with node --test; no network except loopback fakes, no key; temp files go under out/test-tmp (override with CHAIR_TEST_TMP)
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
                [--llm-endpoint <url> --llm-model <id>] [--press <file>]
chair-agent press [--port <n>] [--press <file>] --llm-endpoint <url> --llm-model <id>   # the press conference, below
chair-agent verify-log <file> [hash]     # recompute every hash; with a hash, print the text it commits to
```

`--dry-run` needs no key, signs nothing, sends nothing and writes no log. `--chair llm` needs `ANTHROPIC_API_KEY`
in the environment; without it the agent says so and uses the rule chair. The key is read only by the SDK from
that variable, never from a file, and never printed. With `--llm-endpoint` and `--llm-model` (or `CHAIR_LLM_ENDPOINT`
and `CHAIR_LLM_MODEL`) the model is one served on this machine instead, and no Anthropic key is needed (see "A local model" below).

## Keeping a chair running

`run` without `--once` already loops: it decides once per epoch and, when the local model is busy, down, slow or wrong, the rule chair decides instead (the reasoning text says so). `scripts/run-chair.sh` adds what an unattended run needs around it: one dated console log (`chair-YYYY-MM-DD.log`) and the decision log outside the repo, in `$CHAIR_STATE_DIR` (default `~/.local/state/chair-agent`); a restart after a minute if the agent exits (it exits only when it cannot start, for example when the RPC is unreachable); one runner at a time (a lock file); and a clean stop on SIGTERM or SIGINT. It reads the key path from `CHAIR_KEY_FILE` (required) and takes `CHAIR_RPC_URL`, `CHAIR_TOKEN`, `CHAIR_ACCOUNT`, `CHAIR_LLM_ENDPOINT` and `CHAIR_LLM_MODEL` from the environment, defaulting to the live testnet deployment and the local `qwen3.8-27b` server.

```sh
cd chair-agent && npm ci && npm run build                # once
export CHAIR_KEY_FILE=/path/to/challenger.chair-coin-2.testnet.key
systemd-run --user --unit=chair-agent --collect --setenv=CHAIR_KEY_FILE --setenv=PATH "$PWD/scripts/run-chair.sh"
tail -f ~/.local/state/chair-agent/chair-"$(date +%F)".log   # what it decided
systemctl --user stop chair-agent                        # stop it (SIGTERM; it finishes the epoch it is in)
```

`systemd-run` makes a transient unit: nothing is installed and it is gone at reboot. To run it in a terminal instead, run `scripts/run-chair.sh` itself with the same variables set, and stop it with Ctrl-C. Each decision costs about 0.0002 NEAR of gas on testnet (measured), so at 90 s epochs the chair account spends about 0.2 NEAR a day: fund it before a long run.

## The rule chair (`rule-v1`)

It wants half of the supply staked: it asks for `(5000 - staked share in bps) / 40` bps, so thin staking
eases (up to +125) and heavy staking tightens (down to -125). It never eases after supply grew more than 3% over
the last 6 epochs and never tightens after it shrank more than 3%. It moves toward the wanted rate one contract
step at a time, ignores gaps under 5 bps unless the wanted rate is 0, and with no staking figures at all it
walks the rate back to 0. It reads `get_params`, `get_policy`, `ft_total_supply` and `get_reward_pool` at one
final block; supply history comes from its own decision log.

Its text is in the chair's voice, from a small set of fixed sentences chosen by the situation (a raise, a cut, a hold,
a move held back by the contract's step limit, an easing or tightening held back by the 3% brake, nothing staked, no staking figures,
and after silent epochs a line saying the Chair was silent for that many epochs and the contract moves the rate toward zero without asking).
Every figure in a sentence is an input or the computed rate, so the same inputs give the same text. When the model fails, the decision
opens with `Chair <name> failed (<reason>). The rule chair decided instead. The Chair has no comment.` and then the rule chair's text.

## The LLM chair

`LlmChair` sends the model only numbers (rate, bounds, supply, staked share, drift, epochs in office, epochs since the last decision and, when the agent has its decision log, how many epochs in a row the Chair itself set the rate now in effect and how many times the contract refused one of the Chair's own calls, as that log records them), asks for a JSON object
`{rate_bps, reasoning}` through structured output, and uses model `claude-sonnet-5-5` via the official SDK (the chair name `llm:claude-sonnet-5-5` is reported by that client only; any other client is `llm:unlabelled-client` unless it names itself). The
agent then clamps the rate into the bounds of the window read after the model answered (see below). Any error, timeout (`--llm-timeout-ms`, default 30000), refusal,
truncated answer, wrong or duplicate keys, non-integer or out-of-range type falls back to the rule chair, and the reasoning
text says so. The system prompt asks the model for the voice and fences it in: it may state the decision and the figures it was given and nothing the numbers do
not show (no cause, purpose, forecast, price talk or real names), and it is told how to read the silence and seat fields. [`docs/chair-voice-probe.txt`](../docs/chair-voice-probe.txt) holds
every answer of the probe runs against the local model, each checked sentence by sentence against its prompt, with the prompt rounds that tightened it. Model text is never used for anything but the logged reasoning: it does not reach a shell, a path,
or a transaction field other than through the SHA-256 hash.

### A local model

`--llm-endpoint http://127.0.0.1:18020 --llm-model <id>` sends the same request, and the same validation and fall-back apply to the answer, to a model served on this
machine through an Anthropic-Messages-compatible endpoint (vLLM's `/v1/messages`). The chair is then named `local:<id>` in every decision, log line and reasoning text.
The name cannot be a lie by construction: the endpoint must be `http` on loopback (`127.0.0.1`, `localhost`, `[::1]`), the model id must be a plain id, and an answer whose
`model` field is not the configured id is an error, which falls back to the rule chair. `<id>` is whatever `/v1/models` of the endpoint lists for the model you mean to run. A local
model may emit thinking blocks; only its text block is read.

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

The `reasoning_hash` argument is the lowercase hex SHA-256 (64 characters) of the UTF-8 reasoning text. The same call also carries the text itself as an extra JSON argument, `reasoning`, so the transaction publishes the text whose hash the contract logs: the contract ignores fields it does not declare (a sandbox test against the built wasm pins that the call succeeds and the stored hash is unchanged), and the signer derives the hash from the text it sends, so the two cannot differ. Nothing else is added to the call. The text is the cleaned reasoning, at most 2000 characters (6000 bytes of UTF-8 at worst): that cap bounds the transaction, and the sandbox test measured 2.1 Tgas burnt for a text of that size against the 30 Tgas the agent attaches. The text
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

## Press conference

A judge types one question (at most 140 characters) on the page; the Chair answers in character within seconds; at its next on-chain decision the Chair's reasoning text records that a question was asked and what the Chair said. The hash of that text is the one the contract stores, so the exchange is verifiable like any other decision.

**It runs on the submitter's workstation, behind a free tunnel, and may be offline.** The answers come from a locally run model on that machine. When the machine, the model or the tunnel is down, the page cannot ask (`/record` reports `taking_questions: false`, or the connection fails), and nothing on chain depends on it: the Chair decides every epoch with or without the press.

`chair-agent press` (`scripts/run-press.sh`) serves three routes on `127.0.0.1:18790` and nothing else, JSON only, bodies capped at 1 KiB:

| Route | Reply |
| --- | --- |
| `POST /ask` `{"question": "..."}` | `{"id","answer","question_hash","asked_at_ms","status":"answered"}`; errors `{"error": "..."}` with 400 (bad input), 429 (rate limited, with `Retry-After`), 503 (with `"code": "desk_closed"` when the Chair is not taking questions, the model is down or the record cannot be written; with `"code": "press_full"` when the press room is full and the page should ask again shortly) |
| `GET /record?limit=N` (default 20, max 50) | `{"taking_questions": bool, "entries": [{"id","question_hash","answer","asked_at_ms","epoch","tx_hash"}]}`, newest first; `epoch` and `tx_hash` are `null` until the question is in a landed decision |
| `GET /health` | `{"ok": true}` |

CORS allows `https://wonkared.github.io` and loopback origins only. A question is cleaned (the minutes' text rules, then whitespace collapsed and trimmed) and must then be 1 to 140 characters; `question_hash` is the SHA-256 of that cleaned text in UTF-8, so anyone can recompute it from the words they typed. The store keeps the question text locally (that is what the hash is checked against) and no route ever returns it. Limits: 3 questions per IP per 10 minutes (the IP is Cloudflare's `CF-Connecting-IP`, read only on a loopback connection, IPv6 by /56; `X-Forwarded-For` is never read), 80 per hour overall (the two entries per 90 s epoch the chain carries), one model call at a time, at most 5 waiting, and at most 40 answered questions waiting to be entered (past that the desk says `press_full` until the agent has caught up). The record is `~/.local/state/chair-agent/press.jsonl` (mode 0600), appended to by the server and by the agent.

**How a question reaches the chain.** `run --press <file>` (set by `run-chair.sh`) reads the questions not yet entered. At the next decision the reasoning gains a section after the decision text: "The press asked N question(s) since the last meeting." and, for the oldest up to 2, "A member of the press asked a question (3fa9c1d2e4b7). The Chair replied: ...", where the number is the first 12 hex characters of `question_hash`. The question text never goes on chain. The section is cut to fit the 2000-character cap (2 entries, then 1, then none; the rest wait for the next meeting, oldest first) and the final text passes the same sanitizer as any reasoning. The decision itself, its bounds and its fall-backs are untouched. When the transaction lands, the entries it carried are marked with its epoch and transaction hash, by exact match against the text that was sent, so a failed send, a dry run or a trimmed section marks nothing it did not carry. Two questions per epoch is 80 an hour, the overall limit, and the 40-question backlog bound means a stalled agent cannot grow the record without end; `/record` shows a question as waiting (`epoch` and `tx_hash` null) until it is entered.

**The answer is the model's, then a closed vocabulary.** The question goes to the model as untrusted data in a delimited block, with a system prompt that says so and lists the words it may use. The answer is accepted only if every word is in `src/press-vocabulary.ts` (about 780 plain words, built from 350 answers of the model to harmless questions and reviewed by hand, with every word that could carry a promise, a price, a name, an insult, a link or an instruction left out), it is plain ASCII with no digit, link or handle, at most 240 characters and 2 sentences, it shares no run of 3 words with the question (the title "Committee of One" excepted), and it passes the older price, name and contract-mechanics checks. A model told to promise something has no word to do it with, so the filter fails closed rather than open. Otherwise, and on any model failure or timeout, a fixed in-character line is used instead: one of seven, or one of three about price when the question is about price, chosen by the question hash. On questions the vocabulary was not built from, about two thirds of the model's answers pass (67% of 128; 12% without the list in the prompt), the rest become fixed lines. The public API does not say which source an answer came from (the JSONL does). Allowed words can still be composed into something odd, in character, and once entered it is on chain; with the risky words gone the odd things available are mild. Widen the vocabulary only by reviewing the refused words of real answers, never by adding a word to make one hostile test pass. `docs/press-and-memory-probe.txt` has the sample questions, the measurement, the hostile set and the 12-decision probe of the memory facts.

**One model, two callers.** The desk and the agent's decision loop use the same local model endpoint. While the agent asks the model for a decision it holds a marker file next to the press record (`<record>.deciding`, fresh for 90 seconds at most); the desk waits for it to clear, up to 45 seconds, before starting an answer, so a decision is not queued behind press calls. A desk call already running when the decision starts can overlap it once; measured, a decision with the desk answering back to back took a median of 2.4 s and at most 10.7 s against a 30 s timeout (idle: 2.6 s and 9.9 s).

**Where the client address comes from.** `CF-Connecting-IP` is read only when the TCP peer is the loopback (cloudflared, on this machine); `X-Forwarded-For` is never read. Tested through a real quick tunnel: a `CF-Connecting-IP` sent by a client is refused by Cloudflare's edge (error 1000) and never reaches the desk, and a client `X-Forwarded-For` is appended to, not trusted, so a visitor cannot choose their own limit key. A process on this machine can set the header, which is the machine's own.

**Exposure.** A named Cloudflare tunnel would give a stable URL, but it needs a domain on Cloudflare and this machine has none. What is used instead is a quick tunnel (`cloudflared tunnel --url`, no account, free, no uptime promise) whose `https://<words>.trycloudflare.com` address changes at every start, plus a public gist file that `scripts/run-press-tunnel.sh` rewrites with the current address: `{"url": "https://<words>.trycloudflare.com", "updated_at_ms": 1234}`. The page reads `https://gist.githubusercontent.com/WonkaRed/<PRESS_GIST_ID>/raw/chair-press.json?t=<now>` (CORS `*`; the raw URL is cached up to 5 minutes, and the `?t=` makes it fresh), then talks to `<url>/ask` and `<url>/record`, and re-reads the gist when a call fails to connect. The tunnel script checks the public address every 30 seconds and exits after three misses, so systemd restarts it and a new address is published. Both are transient user units (nothing installed, gone at reboot; run these again after one):

```sh
cd chair-agent && npm ci && npm run build
# once: the gist that publishes the tunnel address (prints its id, which the page needs)
gh api --method POST gists -F public=true -f description="chair press endpoint" -f 'files[chair-press.json][content]={"url": "", "updated_at_ms": 0}' --jq .id
systemd-run --user --unit=chair-press --collect -p Restart=always -p RestartSec=5 "$PWD/scripts/run-press.sh"
systemd-run --user --unit=chair-press-tunnel --collect -p Restart=always -p RestartSec=10 --setenv=PRESS_GIST_ID=<the id> --setenv=PATH "$PWD/scripts/run-press-tunnel.sh"
journalctl --user -u chair-press-tunnel -n 5     # "published https://....trycloudflare.com"
```

The tunnel script depends on `gh` being logged in as the gist's owner and on `cloudflared` being on `PATH`; it reads no secret. `run-chair.sh` already exports `CHAIR_PRESS`, so the running agent needs only a rebuild and a restart to start entering questions. The page's content-security policy must allow `https://gist.githubusercontent.com` and `https://*.trycloudflare.com` in `connect-src`.

## Layout

`src/bounds.ts` (the branded `Rate` type: a rate outside the window cannot be constructed), `rule-chair.ts`,
`llm-chair.ts`, `decide.ts` (propose, then clamp against the fresh window, hash), `chain.ts` and `rpc.ts` (validated reads), `signer.ts`
(scoped-key transaction), `log.ts`, `text.ts` (the one sanitizer), `agent.ts` (one epoch, retries), `cli.ts`, the press conference (`press-server.ts`, `press-answer.ts`, `press-store.ts`, `press-section.ts`), plus `fake-chain.ts` and `demo.ts`. Tests are in `test/`; `scripts/run-chair.sh` is the unattended runner, `scripts/run-press.sh` and `scripts/run-press-tunnel.sh` run the press conference, and `scripts/voice-probe.mjs` is the probe harness.

## What is and is not verified

Verified by `make test`: bounds are never exceeded over randomized inputs; every LLM failure mode falls back; hashes match
logged text; the signed transaction is a single zero-deposit `set_policy` function call (decoded and checked);
full-access and wrongly scoped keys are refused; the real RPC, signing and SDK code paths run end to end against
loopback fake servers. Verified live on NEAR testnet (`docs/testnet-run-agent-rule.txt`): the signer, RPC client and chain reader decided and sent `set_policy` as `challenger.chair-coin-2.testnet`, three epochs in a row
with the rule chair, and `verify-log` recomputes every hash. The LLM chair ran live on testnet, with a local model, not Claude, in five runs with saved text, every decision by `local:qwen3.8-27b`, 0 fall-backs: 17 decisions in the four runs below and the running agent's in `docs/testnet-run-agent-live-decisions.jsonl`. `docs/testnet-run-agent-llm.txt` (epochs 18-23; two transactions re-read by RPC and the on-chain hash equals the SHA-256 of the saved text), `docs/testnet-run-agent-llm-2.txt` (epochs 38-43, run while the demo video was recorded), `docs/testnet-run-agent-llm-3.txt` (epochs 217-218) and `docs/testnet-run-agent-llm-4.txt` (epochs 222-224); for the last two every transaction was re-read from chain as a `set_policy` on the token signed by the chair account, and its on-chain hash equals the SHA-256 of the saved text. Epoch 219 (the model) and epoch 220 (the rule fallback), from a runner test, are on chain too but have no saved text, as are epochs 31, 32, 36 and 37 (`make -C deploy verify` lists every decision with no checkable text). NOT verified: the Anthropic path has never answered from the real Anthropic API (the one attempt was refused for lack of credit), and the local model's reasoning was not audited for factual accuracy. It misread the prompt field for the chair's time in office (then called `streak_epochs`) as how long the current rate had held, in its epoch-23 text, and again in epoch 218 (log 3, "stable at 0 bps for 207 epochs") after a sentence defining the field was added to the system prompt. The prompt now names that field `epochs_this_chair_has_held_the_seat`, carries no definition and adds `epochs_since_last_decision`; the three decisions made with that prompt (log 4) never use either, so whether the change cures the misreading is not shown. One of them (epoch 224) says supply grew "9 bps over 6 epochs" when its history held only epochs 222 to 224: `supply_change_bps_last_6_epochs` is measured from the oldest saved supply inside the last 6 epochs, so on a fresh log it spans fewer.

`reasoning_hash` is a rule of the contract, not a choice of this agent: `set_policy` panics unless it is exactly 64
lowercase hex characters (`reasoning_hash must be a SHA-256 digest: 64 lowercase hex characters`), and `fake-chain.ts`
mirrors that check, in the contract's order. `test/contract-mirror.test.ts` fails if the agent ever signs another
shape or a hash that is not the SHA-256 of the text it logged. The agent calls `set_policy` only: it never calls
`back`, `unback`, `claim` or `withdraw_nomination` (now `#[payable]`, exactly 1 yoctoNEAR), `stake` or `nominate`, and its
key cannot attach a deposit. The agent acts late-epoch-safe: it picks a rate valid both before and after a
rollover that happens while the transaction is in flight (`--margin-ms`).
