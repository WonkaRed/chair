.PHONY: build test serve

# The page runs the repo's own simulator, so the sim is compiled first (needs Node 22.22.2 or newer and npm).
build:
	$(MAKE) -C ../sim build
	node scripts/build.mjs

test: build
	node --test "test/*.test.mjs"

serve: build
	node scripts/serve.mjs
