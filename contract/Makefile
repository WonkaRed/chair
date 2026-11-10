.PHONY: build test demo

# The deployable wasm, contract/res/chair_token.wasm. The build pipeline lives in sandbox-tests
# (the same code the tests run), so the wasm that is tested is the wasm that ships.
build:
	cargo run -p sandbox-tests --example build_wasm --locked --quiet

# Unit tests of the policy math and launch checks. The contract itself is tested in ../sandbox-tests.
test:
	cargo test -p chair-token --locked

demo:
	@:
