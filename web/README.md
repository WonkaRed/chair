# web

The public page for $CHAIR: every mint and burn the token contract has made, checked against its own ledger, and a
60-epoch simulation of what the contract's rules do under five behaviours of the chair. Static files: plain ES modules,
no framework, no backend, no external fonts or scripts. It works from `make serve` and from any static host.

## Build, serve, test

Needs Node 22.22.2 or newer and npm (the build compiles `../sim` first; the Rust toolchain is only needed to re-record the fixture).

```sh
make -C web build    # compiles ../sim, writes web/dist (site + config + fixture + a verbatim copy of the compiled simulator + the CSP)
make -C web serve    # builds, then serves web/dist at http://127.0.0.1:8080/ (PORT=... to change)
make -C web test     # builds, then `node --test "test/*.test.mjs"`: 12 tests, no browser, no network
make -C web record   # re-records fixtures/sandbox-run.json from a local NEAR sandbox (slow: builds the contract)
```

Deploying is copying `web/dist` to any static host.

## Config: `config.js`

The one file to edit after deployment: `account` (the token account; shipped pointing at the live testnet token `token.chair-coin.testnet`, see `docs/testnet-deployment.json`),
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

## Simulation

`site/js/simview.js` runs the repo's own simulator (`../sim`, copied byte for byte into `dist/vendor/sim` by the build; a test checks the copy) in the browser:
`honest-rule-chair` (the shipped `rule-v1`), `chair-goes-silent`, `max-inflation`, `max-deflation`, `max-step-pusher` (swings between the bounds). The assumptions are listed
on the page (staked share, three stakers, 20% velocity, scripted chairs, no price or demand). Every chart has a table view and a legend that also filters.

## What it proves, and what it does not

It shows what the contract has logged and whether those events add up to the contract's own ledger. It does not prove the chair is wise, says nothing about price,
liquidity or returns, and the simulation is a model of supply under stated assumptions, written from SPEC.md and read against the contract source; it does not run the contract.
The event list comes from an index, so it is checked (against the RPC) rather than signed: a difference is shown, never hidden. The fixture is one scripted run of the real
wasm in a local sandbox (`recorder/`); it is not a deployment and its tokens are not real.

## Layout

`config.js`, `site/` (index.html, style.css, theme.js, `js/`), `fixtures/sandbox-run.json`, `recorder/` (Rust, uses `../sandbox-tests`), `scripts/` (build, serve), `test/`.
