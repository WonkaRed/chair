# web

The public page for $CHAIR: the chair's decisions with their written reasoning checked against the hash on chain, every mint and burn the token contract has made, checked against its own ledger, and a
60-epoch simulation of what the contract's rules do under five behaviours of the chair. Static files: plain ES modules,
no framework, no backend, no external fonts or scripts. It works from `make serve` and from any static host.

## Build, serve, test

Needs Node 22.22.2 or newer and npm (the build compiles `../sim` first).

```sh
make -C web build    # compiles ../sim, writes web/dist (site + config + fixture + the reasoning bundle + a verbatim copy of the compiled simulator + the CSP)
make -C web serve    # builds, then serves web/dist at http://127.0.0.1:8080/ (`PORT=8081 make -C web serve` to change it; a busy port is reported with that hint)
make -C web test     # builds, then `node --test "test/*.test.mjs"`: 33 tests, no browser, no network
```

Deploying is copying `web/dist` to any static host.

## Config: `config.js`

The one file to edit after deployment: `account` (the token account; shipped pointing at the live testnet token `token.chair-coin-2.testnet`, see `docs/testnet-deployment.json`),
`rpcUrl` (NEAR JSON-RPC, the source of truth for every total), `indexerUrl` (FastNEAR transactions API, the source of the event list),
`explorerUrl`, `repoUrl`/`repoRef` (spec and test links), and `fixture`. `fixture: null` (as shipped) reads the live chain; setting it to a path, as the tests do, shows
`fixtures/sandbox-run.json` instead and says, in a banner, "recorded sandbox run, not a live chain". The build writes the page's
Content-Security-Policy from this file: `connect-src` allows `'self'` and, only when `fixture` is `null`, exactly the origins of `rpcUrl` and
`indexerUrl` (https only). Scripts and styles are `'self'` only; the page has no inline script or style.

## How the log works, and how it fails

1. Views (`get_params`, `get_policy`, `get_supply`, access keys) come from the RPC. Those totals are shown even when the index is down.
2. The indexer lists the transactions that touched the token, and each transaction's receipts and logs are read. NEP-297 events
   (`ft_mint`/`ft_burn` with the contract's memos, and the `chair` standard's `epoch_minted`/`transfer_burned`) become log rows with epoch,
   amount, reason and a transaction link. Anything it cannot parse is listed as an anomaly, not dropped.
3. Event sums are compared for exact equality with `get_supply` (launch, minted, burned), **at the block of the last transaction that logged an event**:
   views project a mint that is due but not yet applied, and no event exists for it until the next transaction, so the page shows that separately as "due".
   The identity `total = launch + minted - burned` is checked in the page on the chain's own numbers.
4. Statuses: *complete* (sums equal), *mismatch* (they differ: "the log is not complete"), *incomplete* (the index failed or ended early: no event total is claimed,
   and a retry button is shown when trying again may help), *unverified* (the RPC node no longer has the block needed to pin the comparison). An RPC failure shows no numbers at all.

Chain strings are text only (`textContent`, never markup). Control, bidi and invisible characters are shown as `\u{...}`, and an account id that is not a valid NEAR id is shown as invalid.

## Chair minutes

The first section of the page lists the chair's decisions, newest first: the latest in full, older ones collapsed behind "Show all". Each shows the epoch, the rate and its move from the
previous rate, who decided, the reasoning text, the transaction, and a mark. From the voice change on, the reasoning is written in character ("The Chair", a deadpan parody of a central banker); older decisions keep their plain text, and the page shows either exactly as hashed. When the chair has been silent the section says for how many epochs and what the rate has decayed to.

- **From the chain:** every `policy_set` event (`epoch`, `rate_bps`, `previous_rate_bps`, `reasoning_hash`, the chair account) in the same transactions the log reads (`js/decisions.js`), so the feed is live and shares the log's trust rules.
- **From the transaction:** the live agent sends the reasoning text as an extra `reasoning` argument of its `set_policy` call, which the contract ignores. The page reads it from the transaction's arguments (`argsOf` and `chainText` in `js/decisions.js`), keyed by transaction, and checks it against the hash in that transaction's own event, so a text that does not belong to its transaction is shown as a mismatch, never hidden. Arguments that are not a text (another method, bad base64 or UTF-8, a non-string or empty `reasoning`, oversize arguments) count as no text.
- **From the build:** older decisions have no text in the transaction. `scripts/minutes.mjs` reads `../docs/testnet-run-agent-*decisions.jsonl` (the text exactly, as JSON) and `../docs/testnet-run-agent-*.txt` (the same text behind a `  | ` prefix on each line)
  and writes `dist/minutes.json`, keyed by hash, with the chair's label and kind from the record. It bundles a text only if its SHA-256 equals the hash the record claims; anything else (a missing folder or file, a bad line, a text that does not hash)
  is skipped with a warning and never stops the build. Add a run record to `docs/` under that naming and rebuild to publish its texts.
- **In the browser:** `crypto.subtle.digest("SHA-256", ...)` over the exact UTF-8 bytes of the text, compared with the on-chain hash: verified, mismatch, or not checked (a browser without `crypto.subtle`, which needs https or localhost). A decision with no bundled text shows its hash and
  "reasoning text not published for this decision". The text is shown through `textContent`, with control and bidi characters escaped and said so; the check still runs on the exact text.

A decision with neither a text in its transaction nor a bundled one shows "reasoning text not published for this decision". When both exist, the one that verifies is used.

A match shows the text is the one the chair committed to in that transaction. It does not show the chair was right or that the text caused the rate.

## Refusals

A `set_policy` call the contract turns down changes nothing and logs no event, but the indexer lists the failed transaction. The Refusals section (`js/refusals.js`, from `refusalsOfTxs` in `js/decisions.js`) lists every such call, newest first, with the rate it asked for when its arguments can be read, the contract's own panic text taken from the failed receipt (`Smart contract panicked: ...`), and a transaction link. It reads the same transactions as the log, so it shares its trust rules: an index that cannot be read is said, not shown as "no refusals". A refusal by the protocol before the contract runs (for example a wrong method on the chair's restricted key) creates no transaction and so cannot appear.

## Simulation

`site/js/simview.js` runs the repo's own simulator (`../sim`, copied byte for byte into `dist/vendor/sim` by the build; a test checks the copy) in the browser:
`honest-rule-chair` (the shipped `rule-v1`), `chair-goes-silent`, `max-inflation`, `max-deflation`, `max-step-pusher` (swings between the bounds). The assumptions are listed
on the page (staked share, three stakers, 20% velocity, scripted chairs, no price or demand). Every chart has a table view and a legend that also filters.

## What it proves, and what it does not

It shows what the contract has logged and whether those events add up to the contract's own ledger. It does not prove the chair is wise, says nothing about price,
liquidity or returns, and the simulation is a model of supply under stated assumptions, written from SPEC.md and read against the contract source; it does not run the contract.
The event list comes from an index, so it is checked (against the RPC) rather than signed: a difference is shown, never hidden. The fixture is one scripted run of the real
wasm in a local sandbox, recorded once; it is not a deployment and its tokens are not real.

## Layout

`config.js`, `site/` (index.html, style.css, theme.js, `js/`), `fixtures/sandbox-run.json`, `scripts/` (build, minutes bundler, serve), `test/`.
