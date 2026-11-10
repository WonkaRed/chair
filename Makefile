# Root orchestration only. Every lane owns its directory and its own Makefile with `build`,
# `test` and `demo` targets, so lanes never edit this file except to add themselves to LANES.
SHELL := bash -o pipefail
LANES := contract sandbox-tests chair-agent sim web

.PHONY: build test demo
build test demo:
	@for lane in $(LANES); do $(MAKE) --no-print-directory -C $$lane $@ || exit 1; done
