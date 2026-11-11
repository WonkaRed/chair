# Root orchestration only. Every lane owns its directory and its own Makefile with `build`
# and `test` targets, and `demo` where it has one, so lanes never edit this file except to add themselves to LANES.
SHELL := bash -o pipefail
# The compiler comes from rust-toolchain.toml; an exported RUSTUP_TOOLCHAIN would silently override it.
unexport RUSTUP_TOOLCHAIN
LANES := contract sandbox-tests chair-agent sim web activity

# The web page has nothing to narrate in a terminal (`make -C web serve` shows it), and the activity bot has no demo.
DEMO_LANES := $(filter-out web activity,$(LANES))

.PHONY: build test demo
build test:
	@for lane in $(LANES); do $(MAKE) --no-print-directory -C $$lane $@ || exit 1; done
demo:
	@for lane in $(DEMO_LANES); do $(MAKE) --no-print-directory -C $$lane $@ || exit 1; done
