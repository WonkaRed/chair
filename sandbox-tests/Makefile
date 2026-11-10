.PHONY: build test demo

build:
	@:

# Builds the contract wasm itself (cargo-near-build), launches a local NEAR sandbox per test.
test:
	cargo test -p sandbox-tests --locked

demo:
	cargo run -p sandbox-tests --example demo --locked --quiet
