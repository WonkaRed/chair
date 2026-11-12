# chair-agent

The chair: a small TypeScript program that, once per epoch, reads the $CHAIR token and calls
`set_policy(rate_bps, reasoning_hash)`. It ships two chairs behind one interface: a deterministic
rule-based chair that needs no API key, and an optional LLM chair that falls back to the rule chair
on any failure. The contract, not this program, is the authority: it rejects any rate outside +-200 bps
or more than 50 bps from the rate in effect, and decays the rate when the chair is silent. The agent
additionally never proposes a call the contract would reject.

The chair writes in a voice: "The Chair", a deadpan parody of a central banker, solemn and self-important about tiny moves.
The minutes are for a reader who has never seen a blockchain: the decision comes first and says what the rate does in plain words, every
rate and change is a percent with two decimals (5 bps is 0.05%), and "meetings" and the "90-second meeting" stand for epochs. Basis points stay
in the code, the contract and the first lines of the on-chain text (`Rate in effect 5 bps; decision 5 bps.`), where the web page reads them;
there a positive figure is basis points of supply per day and a negative one is basis points of each transfer.
The voice changes only the wording of the reasoning text; the rate rules and the contract's bounds are untouched, and every
sentence must stay true to the numbers the chair was given (it names no real person, institution or currency and says nothing about price).
For example, from the rule chair: "The Committee of One has met. The Chair moves the rate from zero to a printing rate of 0.05%: 0.05% more coins are printed a day, a little at every 90-second meeting, for holders who staked. 48.00% of all coins are staked, and the Chair would like 50.00%. The Chair thanks itself for its service."
Decisions recorded before the voice keep their old text, because their hashes are on chain.

This is a toy monetary experiment. Nothing here predicts or promises a price, a return, or any effect on
value. The rate rule is a demonstration of a mechanism, not advice.

Contract: [`../SPEC.md`](../SPEC.md) ("Methods", "The chair's key").

## Run it (offline, no keys, no spend)

Needs Node 22.22.2 or newer and npm. Dependencies are pinned exactly in `package.json` and `package-lock.json`
(`make` runs `npm ci`): `near-api-js` 7.4.0, `@anthropic-ai/sdk` 1.8.0, and dev-only `typescript` 7.0.2 and
`@types/node` 26.6.6.

```sh
make test   # typecheck, then 162 tests with node --test; no network except loopback fakes, no key; temp files go under out/test-tmp (override with CHAIR_TEST_TMP)
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

`run` without `--once` already loops: it decides once per epoch and, when the local model is busy, down, slow or wrong, the rule chair decides instead (the reasoning text says so). `scripts/run-chair.sh` adds what an unattended run needs around it: one dated console log (`chair-YYYY-MM-DD.log`) and the decision log outside the repo, in `$CHAIR_STATE_DIR` (default `~/.local/state/chair3-agent`; the previous token's log, in `~/.local/state/chair-agent`, stays apart); a restart after a minute if the agent exits (it exits only when it cannot start, for example when the RPC is unreachable); one runner at a time (a lock file); and a clean stop on SIGTERM or SIGINT. It reads the key path from `CHAIR_KEY_FILE` (required) and takes `CHAIR_RPC_URL`, `CHAIR_TOKEN`, `CHAIR_ACCOUNT`, `CHAIR_LLM_ENDPOINT` and `CHAIR_LLM_MODEL` from the environment, defaulting to the live testnet deployment and the local `qwen3.8-27b` server.

```sh
cd chair-agent && npm ci && npm run build && cd ..          # once
mkdir -p ~/.config/systemd/user && cp deploy/systemd/chair3-*.service deploy/systemd/chair3-*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now chair3-agent chair3-activity chair3-press chair3-press-tunnel chair3-balance-watch.timer
tail -f ~/.local/state/chair3-agent/chair-"$(date +%F)".log   # what it decided
systemctl --user stop chair3-agent                       # stop it (SIGTERM; it finishes the epoch it is in)
```

The units in [`../deploy/systemd/`](../deploy/systemd/) are how the live demo runs, for `token.chair-coin-3.testnet`, from a runtime checkout of this repo at `~/Desktop/Projects/Survival/chair-worktrees/runtime` (a worktree pinned to the commit that is live, so development here never changes what runs): `chair3-agent` (this script), `chair3-activity` (the scripted holders, `../activity`), `chair3-press` and `chair3-press-tunnel` (see "Press conference"), and `chair3-balance-watch.timer` (every 6 h, runs `../deploy/scripts/balance-watch.mjs`: whether each gas account lasts to 2026-11-26, the four units are active, the decision log is fresh and the published tunnel answers `/health`; a problem runs `pixelbot-notify` and fails the unit). Each is `Restart=always` with no start limit, `WantedBy=default.target`, and the machine has user lingering on, so the whole demo comes back after a reboot without a login; the agent falls back to its rule chair until the local model server at `127.0.0.1:18020` is up. The units name no secret: `CHAIR_KEY_FILE` (in `chair3-agent.service`) and `CHAIR_ACTIVITY_KEY_DIR` (in `chair3-activity.service`) are paths under `~/.claude/secrets/survival-testnet/chair3/`, so edit them for another machine, along with the repo path (`%h/Desktop/Projects/Survival/chair-worktrees/runtime`). The press desk listens on 18791 and keeps its state, with the agent's, in `~/.local/state/chair3-agent`; the previous token's units ran as `chair-*` on 18790 with `~/.local/state/chair-agent`. To run it in a terminal instead, export `CHAIR_KEY_FILE` and run `scripts/run-chair.sh`, and stop it with Ctrl-C. Each decision costs about 0.0002 NEAR of gas on testnet (measured), so at 90 s epochs the chair account spends about 0.2 NEAR a day: fund it before a long run.

## The rule chair (`rule-v1`)

I want half of the supply staked, so I ask for `(5000 - staked share in bps) / 40` bps: thin staking
eases (up to +125) and heavy staking tightens (down to -125). That rate is my mandate, "the more holders stake, the
less the Chair prints", and every chair works to it. A positive rate is per day: +35 is 0.35% of supply a day, and
the contract mints a 960th of that at each 90-second meeting. I move toward the wanted rate one contract
step at a time, ignore gaps under 5 bps unless the wanted rate is 0, and with no staking figures at all I
walk the rate back to 0. I read `get_params`, `get_policy`, `ft_total_supply` and `get_reward_pool` at one
final block; supply history comes from my own decision log.

Its text is in the chair's voice, from a small set of fixed sentences chosen by the situation (a hold, a move, a move held back by the contract's
step limit, nothing staked, no staking figures, and after silent meetings a line saying
the Chair was silent for that many meetings and the contract moves the rate toward zero without asking). Each says what the rate does
(prints a percent of new coins a day, a little at every meeting, for the holders who staked; burns a slice of every transfer; or neither), in percent, and the meeting length is the chain's own.
Every figure in a sentence is an input or the computed rate, so the same inputs give the same text. When the model fails, the decision
opens with `Chair <name> failed (<reason>). The rule chair decided instead. The Chair has no comment.` and then the rule chair's text.

### The rate is per day

The contract reads a positive rate as basis points of supply per day. Each meeting mints
`supply * rate / (10_000 * meetings_per_day)`, with `meetings_per_day = ceil(86_400_000 / epoch_ms)`, which is 960 at 90 s. With a supply
of 1_000_001_000, a rate of 33 and 500 staked, a meeting mints 3437 (3437.5034 floored); the fake chain in `src/fake-chain.ts` and its test
use that vector. The most the contract allows is +200, which is 2.02% of supply in a day (exactly 2.02011%, because each meeting compounds),
about 1.15 times in a week and about 1.82 times in 30 days. The contract holds that line, so I keep no second budget of my own and no brake on
supply growth. A negative rate burns that percent of every transfer, as before, and stays per transfer.

I read `meetings_per_day` from `get_params`. A token that does not report it is the old one, where the rate was per meeting, and I refuse to
run against it (as I do against one that reports a figure other than the day divided by its epoch), so the minutes never say "a day" of a
token that prints every meeting.

Each decision line in the log also carries `mandate_rate_bps` (what the mandate asks for, per day), `followed` (`mandate` when the rate set is
the mandate's as near as the contract's step allows, within the rule's 5 bps dead band, and `judgment` when the chair chose its own),
`supply_change_24h_bps` and `supply_change_24h_meetings` (supply over the last day, over the meetings the log really covers; null with no
history). Lines written before this lack the four fields.

## The LLM chair

`LlmChair` sends the model only numbers (the rate in effect, the mandate rate and what it does, the bounds, the meeting length, the supply change and the staked share each as a finished sentence in percent, the meetings missed since the last decision and, when the agent has its decision log, how many meetings before this one the Chair itself set the rate now in effect and how many times the contract refused one of the Chair's own calls, as that log records them), asks for a JSON object
`{rate_bps, reasoning}` through structured output, and uses model `claude-sonnet-5-5` via the official SDK (the chair name `llm:claude-sonnet-5-5` is reported by that client only; any other client is `llm:unlabelled-client` unless it names itself). The
agent then clamps the rate into the bounds of the window read after the model answered (see below). Any error, timeout (`--llm-timeout-ms`, default 30000; the live run (`scripts/run-chair.sh`) passes 60000), refusal,
truncated answer, wrong or duplicate keys, non-integer or out-of-range type falls back to the rule chair, and the reasoning
text says so. A malformed answer (the truncated, wrong-key and wrong-type cases) is asked for once more when at least 10 seconds of the timeout remain; the second try has only the time that is left, and a second malformed answer falls back. The system prompt asks the model for the voice and fences it in: it may state the decision and the figures it was given and nothing the numbers do
not show (no cause, purpose, forecast, price talk or real names), and it is told that a printing rate is per day, with the sentence to use ("printing 0.05% more coins a day, a little at every 90-second meeting, for holders who staked"), and how to read the silence and run fields. Every figure reaches it already converted to percent, so it copies; its text is refused, once asked again and then replaced by the rule chair's, when it says "basis points", "bps" or "epoch", writes a percent the numbers do not give (the rate it decided, the rate in effect, the staked share and the supply change are the only ones), writes a printing rate as a burn or the reverse, gives a printing rate without its day or ties it to each meeting or each stretch of seconds, claims a run of meetings the Chair may not, or leaves a rate without its unit. [`docs/chair-voice-probe.txt`](../docs/chair-voice-probe.txt) holds
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

**It runs on the submitter's workstation, behind a free tunnel, and may be offline.** A locally run model on that machine picks each answer from the book of approved statements. When the machine, the model or the tunnel is down, the page cannot ask (`/record` reports `taking_questions: false`, or the connection fails), and nothing on chain depends on it: the Chair decides every epoch with or without the press.

`chair-agent press` (`scripts/run-press.sh`) serves three routes on `127.0.0.1:18790` (`CHAIR_PRESS_PORT`; the live unit sets 18791) and nothing else, JSON only, bodies capped at 1 KiB:

| Route | Reply |
| --- | --- |
| `POST /ask` `{"question": "..."}` | `{"id","answer","question_hash","asked_at_ms","status":"answered"}`; errors `{"error": "..."}` with 400 (bad input), 429 (rate limited, with `Retry-After`), 503 (with `"code": "desk_closed"` when the Chair is not taking questions, the model is down or the record cannot be written; with `"code": "press_full"` when the press room is full and the page should ask again shortly) |
| `GET /record?limit=N` (default 20, max 50) | `{"taking_questions": bool, "entries": [{"id","question_hash","answer","asked_at_ms","epoch","tx_hash"}]}`, newest first; `epoch` and `tx_hash` are `null` until the question is in a landed decision |
| `GET /health` | `{"ok": true}` |

**Join pool idle reset.** The desk's Join pool takes steps in when visitors press and out when it is full. After `CHAIR_JOIN_IDLE_RESET_S` seconds (default 600, 1 to 86400) with no press, the desk takes one step back out while the pool holds any stake, one step per idle window and never in the same meeting as a visitor's press, so a full pool drains on its own and the next visitor finds a seat. It reads the stake from the chain, so a restart loses nothing. Log lines: `join idle-reset tx <hash>`.

CORS allows `https://wonkared.github.io` and loopback origins only. A question is cleaned (the minutes' text rules, then whitespace collapsed and trimmed) and must then be 1 to 140 characters; `question_hash` is the SHA-256 of that cleaned text in UTF-8, so anyone can recompute it from the words they typed. The store keeps the question text locally (that is what the hash is checked against) and no route ever returns it. Limits: 3 questions per IP per 10 minutes (the IP is Cloudflare's `CF-Connecting-IP`, read only on a loopback connection, IPv6 by /56; `X-Forwarded-For` is never read), 80 per hour overall (the two entries per 90 s epoch the chain carries), one model call at a time, at most 5 waiting, and at most 40 answered questions waiting to be entered (past that the desk says `press_full` until the agent has caught up). The record is `~/.local/state/chair-agent/press.jsonl` (mode 0600), appended to by the server and by the agent.

**How a question reaches the chain.** `run --press <file>` (set by `run-chair.sh`) reads the questions not yet entered. At the next decision the reasoning gains a section after the decision text: "The press asked N question(s) since the last meeting." and, for the oldest up to 2, "A member of the press asked a question (3fa9c1d2e4b7). The Chair replied: ...", where the number is the first 12 hex characters of `question_hash`. The question text never goes on chain. The section is cut to fit the 2000-character cap (2 entries, then 1, then none; the rest wait for the next meeting, oldest first) and the final text passes the same sanitizer as any reasoning. The decision itself, its bounds and its fall-backs are untouched. When the transaction lands, the entries it carried are marked with its epoch and transaction hash, by exact match against the text that was sent, so a failed send, a dry run or a trimmed section marks nothing it did not carry. Two questions per epoch is 80 an hour, the overall limit, and the 40-question backlog bound means a stalled agent cannot grow the record without end; `/record` shows a question as waiting (`epoch` and `tx_hash` null) until it is entered.

**The Chair speaks only from its approved statements.** The answer is never written by a model. `src/press-book.ts` is a reviewed book of 144 short in-voice statements, grouped by what they deflect (greetings, the Chair's mood, price and advice, the rate in general terms, the press, philosophy, orders, nonsense, compliments, complaints, and so on), each safe to sign whatever the question was. The question goes to a locally run model as untrusted data in a delimited block, with the numbered book in the system prompt; the model returns up to three line numbers, and the reply is the book line. Only the numbers are read: any other text, an out-of-range or fractional number, a failure or a timeout falls back to a line chosen by the question's hash from the matching group (the price group for a question about price or advice, which is answered only from that group). The Chair does not repeat any of its last 10 answers, unless every line of the group is among them. What is shown, stored and signed into the minutes is therefore always a line of the book, and a hostile question can only make the Chair say one of those lines in the wrong place. The public API does not say how a line was chosen (the JSONL does: `model` or `canned`). To add a line, put it in a group of the book and have it read by a person; the tests check the mechanical rules (clean, ASCII, at most 2 sentences, no promise, price, name, insult, rule or permanence words). `docs/press-and-memory-probe.txt` has the measurement with the real model.

**One model, two callers.** The desk and the agent's decision loop use the same local model endpoint. While the agent asks the model for a decision it holds a marker file next to the press record (`<record>.deciding`, fresh for 90 seconds at most); the desk waits for it to clear, up to 45 seconds, before starting an answer, so a decision is not queued behind press calls. A desk call already running when the decision starts can overlap it once; measured, a decision with the desk answering back to back took a median of 2.4 s and at most 10.7 s against a 30 s timeout (idle: 2.6 s and 9.9 s).

**Where the client address comes from.** `CF-Connecting-IP` is read only when the TCP peer is the loopback (cloudflared, on this machine); `X-Forwarded-For` is never read. Tested through a real quick tunnel: a `CF-Connecting-IP` sent by a client is refused by Cloudflare's edge (error 1000) and never reaches the desk, and a client `X-Forwarded-For` is appended to, not trusted, so a visitor cannot choose their own limit key. A process on this machine can set the header, which is the machine's own.

**Exposure.** A named Cloudflare tunnel would give a stable URL, but it needs a domain on Cloudflare and this machine has none. What is used instead is a quick tunnel (`cloudflared tunnel --url`, no account, free, no uptime promise) whose `https://<words>.trycloudflare.com` address changes at every start, plus a public gist file that `scripts/run-press-tunnel.sh` rewrites with the current address: `{"url": "https://<words>.trycloudflare.com", "updated_at_ms": 1234}`. The page reads the gist through the GitHub API (`https://api.github.com/gists/<PRESS_GIST_ID>`, CORS `*`, cached 60 seconds; measured, the raw URL lags a rewrite by about 2 to 2.5 minutes even with a `?t=` on it, so it is only the fallback), at most every 90 seconds and again only when the desk stops answering (the unauthenticated limit is 60 requests an hour per IP), then talks to `<url>/ask` and `<url>/record`. While the desk is unreachable the page retries quietly every 20 seconds, so it comes back without a reload. The tunnel script checks the public address every 30 seconds and exits after three misses, so systemd restarts it and a new address is published. Both run as systemd user units installed from `deploy/systemd/` (enabled, restarted on failure, back after a reboot). To set them up on a new machine:

```sh
cd chair-agent && npm ci && npm run build
# once: the gist that publishes the tunnel address (prints its id, which the page needs)
gh api --method POST gists -F public=true -f description="chair press endpoint" -f 'files[chair-press.json][content]={"url": "", "updated_at_ms": 0}' --jq .id
# put the id in PRESS_GIST_ID in deploy/systemd/chair3-press-tunnel.service, then install the units as in "Keeping a chair running"
journalctl --user -u chair3-press-tunnel -n 5     # "published https://....trycloudflare.com"
```

The tunnel script depends on `gh` being logged in as the gist's owner and on `cloudflared` being on `PATH`; it reads no secret. `run-chair.sh` already exports `CHAIR_PRESS`, so the running agent needs only a rebuild and a restart to start entering questions. The page's content-security policy must allow `https://api.github.com`, `https://gist.githubusercontent.com` and `https://*.trycloudflare.com` in `connect-src` (`web/scripts/build.mjs` writes it from `web/config.js`).

## Layout

`src/bounds.ts` (the branded `Rate` type: a rate outside the window cannot be constructed), `rule-chair.ts`,
`llm-chair.ts`, `decide.ts` (propose, then clamp against the fresh window, hash), `chain.ts` and `rpc.ts` (validated reads), `signer.ts`
(scoped-key transaction), `log.ts`, `text.ts` (the one sanitizer), `agent.ts` (one epoch, retries), `cli.ts`, the press conference (`press-server.ts`, `press-answer.ts`, `press-store.ts`, `press-section.ts`), plus `fake-chain.ts` and `demo.ts`. Tests are in `test/`; `scripts/run-chair.sh` is the unattended runner, `scripts/run-press.sh` and `scripts/run-press-tunnel.sh` run the press conference, and `scripts/voice-probe.mjs` is the probe harness.

## What is and is not verified

Verified by `make test`: bounds are never exceeded over randomized inputs; every LLM failure mode falls back; hashes match
logged text; the signed transaction is a single zero-deposit `set_policy` function call (decoded and checked);
full-access and wrongly scoped keys are refused; the real RPC, signing and SDK code paths run end to end against
loopback fake servers. Verified live on NEAR testnet (`docs/testnet-run-agent-rule.txt`): the signer, RPC client and chain reader decided and sent `set_policy` as `challenger.chair-coin-2.testnet` on the previous token (`token.chair-coin-2.testnet`), three epochs in a row
with the rule chair, and `verify-log` recomputes every hash. The LLM chair ran live on testnet, with a local model, not Claude, in five runs with saved text, every decision by `local:qwen3.8-27b`, 0 fall-backs: 17 decisions in the four runs below and the running agent's in `docs/testnet-run-agent-live-decisions.jsonl`. `docs/testnet-run-agent-llm.txt` (epochs 18-23; two transactions re-read by RPC and the on-chain hash equals the SHA-256 of the saved text), `docs/testnet-run-agent-llm-2.txt` (epochs 38-43, run while the demo video was recorded), `docs/testnet-run-agent-llm-3.txt` (epochs 217-218) and `docs/testnet-run-agent-llm-4.txt` (epochs 222-224); for the last two every transaction was re-read from chain as a `set_policy` on the token signed by the chair account, and its on-chain hash equals the SHA-256 of the saved text. Epoch 219 (the model) and epoch 220 (the rule fallback), from a runner test, are on chain too but have no saved text, as are epochs 31, 32, 36 and 37 (`make -C deploy verify` lists every decision with no checkable text). NOT verified: the Anthropic path has never answered from the real Anthropic API (the one attempt was refused for lack of credit), and the local model's reasoning was not audited for factual accuracy. It misread the prompt field for the chair's time in office (then called `streak_epochs`) as how long the current rate had held, in its epoch-23 text, and again in epoch 218 (log 3, "stable at 0 bps for 207 epochs") after a sentence defining the field was added to the system prompt. The prompt now names that field `epochs_this_chair_has_held_the_seat`, carries no definition and adds `epochs_since_last_decision`; the three decisions made with that prompt (log 4) never use either, so whether the change cures the misreading is not shown. One of them (epoch 224) says supply grew "9 bps over 6 epochs" when its history held only epochs 222 to 224: `supply_change_bps_last_6_epochs` is measured from the oldest saved supply inside the last 6 epochs, so on a fresh log it spans fewer.

`reasoning_hash` is a rule of the contract, not a choice of this agent: `set_policy` panics unless it is exactly 64
lowercase hex characters (`reasoning_hash must be a SHA-256 digest: 64 lowercase hex characters`), and `fake-chain.ts`
mirrors that check, in the contract's order. `test/contract-mirror.test.ts` fails if the agent ever signs another
shape or a hash that is not the SHA-256 of the text it logged. The agent calls `set_policy` only: it never calls
`back`, `unback`, `claim` or `withdraw_nomination` (now `#[payable]`, exactly 1 yoctoNEAR), `stake` or `nominate`, and its
key cannot attach a deposit. The agent acts late-epoch-safe: it picks a rate valid both before and after a
rollover that happens while the transaction is in flight (`--margin-ms`).
