# Testing notes

Detail behind `make test` that the root [README](../README.md) leaves out because it is not needed to run the tests.

## Timing

The first `make test` takes 5 to 13 minutes (781 s measured cold from a clean copy on a loaded 16-core machine): it compiles the NEAR dependency tree and downloads the sandbox binary. Later runs skip both.

The sandbox tests need no network node and no account. Each test starts its own local NEAR node, one test file at a time, so that lane is the slow part: `staking` about 15 s, `chair_rules` about 120 s, the others 10 to 57 s on an idle machine.

## Why the harness fast-forwards the way it does

nearcore 2.14's sandbox fast-forward has two upstream bugs: a jump can be lost, and a jump that lands below heights the node has already approved skipping stops block production for good. The harness avoids both: each node gets one-million-block nearcore epochs and a 240 ms skip-approval cap, and the harness only fast-forwards a steadily producing node, 50 blocks at a time. The doc comments in `sandbox-tests/src/lib.rs` have the details.

## Toolchain

Rust 1.95.0 is pinned in `rust-toolchain.toml`. It is the minimum supported version of near-sdk 5.30.1 and the version its own CI builds contracts with, and it was verified here to produce wasm the 2.14.0 sandbox accepts (1.98.1 was also verified).
