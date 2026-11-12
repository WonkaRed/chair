# VERIFY.md: checking $CHAIR quickly

$CHAIR is a memecoin on NEAR testnet whose print or burn rate is picked every 90 seconds by an AI (a local LLM, called the Chair). The contract caps the rate at 2% a day, 50 bps per step, and one decision per meeting, and the Chair's only key can call `set_policy` and nothing else.

## Fastest checks, in order

1. **Live chain check (read-only, no key, no wallet, about 5 to 20 s):** `make -C deploy verify`. Needs git, make, Node 22.22.2 or newer, and network. It asks public NEAR testnet RPC for the token's code hash, access keys, bounds and supply. Success is exit 0 and a last line `OK: 13 checks passed`. If the transaction index is rate limited it prints a NOTE, skips the reasoning-hash check and ends `OK: 12 checks passed`, still exit 0. Any failure prints `FAIL` lines and `FAILED: n of m checks`, exit 1.
2. **Offline Node suites (seconds each):** `make -C deploy test`, `make -C sim test`, `make -C chair-agent test`, `make -C web test`, `make -C activity test`. No key, no network after `npm ci`.
3. **Everything: `make test`** at the repo root. Rust contract unit tests, then sandbox tests against the real wasm on a local NEAR node, then the Node suites. Needs Linux x86-64, glibc 2.39 or newer, rustup (toolchain pinned in `rust-toolchain.toml`), Node 22.22.2 or newer. First run 5 to 13 minutes (781 s measured cold), later runs skip the compile. Success is exit 0. `make demo` narrates the leash and ends `PASS: every bound held`. The same `make test` runs in CI: `.github/workflows/test.yml`.

Test counts and per-file timings: `docs/tests.md`.

## Live page

<https://wonkared.github.io/chair/> shows the Chair's newest minutes, the rate in force, and lets a visitor make the contract refuse an over-limit rate. The page is static files built from `web/`; it reads public testnet RPC. The model runs on the author's workstation, so some features (question desk, overreach, Join, faucet) are closed when it is off.

## Where things live

- `contract/`: the token (Rust, near-sdk). Rules in `contract/src/policy.rs`; spec in `SPEC.md`.
- `sandbox-tests/`: Rust tests against the real wasm and `examples/demo.rs`.
- `chair-agent/`: the Chair, a rule chair and an LLM chair (TypeScript).
- `sim/`: 60-epoch supply simulator, 12 scenarios (TypeScript).
- `web/`: the public page (static, no backend).
- `deploy/`: testnet deploy, scripted run, `verify` (TypeScript); the recorded deployment is `docs/testnet-deployment.json`.
- `activity/`: scripted test activity by three accounts the author controls.
- `docs/`: mechanic, walkthrough, limits, history; start at the README's "Go deeper".

## Honest limits

Read [the README's "What it is not"](README.md#what-it-is-not) and [`docs/limits.md`](docs/limits.md) before scoring.
