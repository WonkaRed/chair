# Tests, demos and troubleshooting

[Back to the README](../README.md)

## Run the tests and the demos

Needs a Linux x86-64 machine (the only platform tried) with glibc 2.39 or newer, because that is what the NEAR sandbox binary is linked against (Ubuntu 24.04, Debian 13, Fedora 40 or later); `git`, `make`, `curl`, a C/C++ compiler; [rustup](https://rustup.rs) (the compiler, 1.95.0, is pinned by `rust-toolchain.toml`); Node 22.22.2 or newer with npm (the highest `engines` floor of `deploy/` and `chair-agent/`; `sim/` asks for 22); and network access (crates, npm packages, and the sandbox binary, which the first test run downloads into the build directory). No API keys, no wallet, no account.

```sh
git clone https://github.com/WonkaRed/chair.git chair && cd chair
rustup toolchain install     # installs the toolchain pinned in rust-toolchain.toml
make test                    # unit tests, the sandbox tests against the real wasm, then the agent, simulator, web and activity tests
make -C deploy test          # the testnet tooling's own tests: offline, no key
make demo                    # the chair's leash, narrated, against a local NEAR sandbox
```

Or, with only Docker installed (the build fails unless `make test` passes):

```sh
docker build -t chair . && docker run --rm chair   # runs `make demo`
```

The first `make test` compiles the NEAR dependency tree and downloads the sandbox: 5 to 13 minutes (781 s measured cold from a clean copy on a loaded 16-core machine). Later runs skip the compile and the download. The sandbox tests need no network node and no account: each test starts its own local NEAR node, one test file at a time, so that lane is the slow part (the longest file, `chair_rules`, takes about 120 s on an idle machine). Per-file timings and the local-node limits the test harness works around are in [`docs/testing-notes.md`](testing-notes.md). The contract lane ends with the unit-test result and then a line for the doc-tests, which has none; the sandbox lane prints one result line per test file:

```
test result: ok. 68 passed; 0 failed; ...      # contract/ unit tests (policy math, rollover, rewards, launch checks, withdrawal)
test result: ok. 0 passed; 0 failed; ...       # contract/ doc-tests: there are none
test result: ok. 7 passed; 0 failed; ...       # sandbox-tests/ against the real wasm: 10 files, one line each (7, 7, 2, 9, 3, 3, 2, 10, 3, 7 tests)
```

The sandbox files hold 53 tests in all. The other lanes run 363 (`chair-agent`), 95 (`sim`), 243 (`web`) and 31 (`activity`) tests, and `deploy` runs 49 (`make -C deploy test`).

Root `make demo` runs three demos in order and exits non-zero if any of them fails.

1. The sandbox demo (`sandbox-tests/examples/demo.rs`) prints the chair setting rates for four epochs, then being refused four ways (second decision in an epoch, a non-chair caller, a rate above 200 bps, a 90 bps jump), then `ft_transfer` being refused to its key, then two silent epochs decaying the rate with the decay events, then a mint epoch paying a staker, a burn epoch destroying part of a transfer, and an impeachment seating a new chair by stake vote. It ends with `PASS: every bound held`, the last line of the sandbox part, and it exits non-zero if the contract ever behaves differently from what it prints.
2. The chair agent demo (`chair-agent/`) runs the shipped rule chair against a model of the contract for 14 decisions and ends with `PASS: every decision stayed inside the bounds and every hash matches its logged text`.
3. The simulator (`sim/`) prints one table per scenario (12 of them, from an honest chair to an impeachment with a silent successor and the staking-share variants) and ends by writing `sim/out/scenarios.json`. Its last line is `wrote .../sim/out/scenarios.json`, not a `PASS` line.

`make build` writes the deployable `contract/res/chair_token.wasm`, using the same in-process `cargo near build` pipeline the tests use. No `cargo-near` CLI is needed.

Offline sandbox: set `NEAR_SANDBOX_BIN_PATH` to a `near-sandbox` 2.14.0 binary to skip the download.

## Troubleshooting

Under heavy machine load the local sandbox node has occasionally stopped mid-run (`Sandbox failed to fast forward: error sending request`). Rerun the test, and run the sandbox suite with no other sandbox running.
