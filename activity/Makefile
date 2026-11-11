.PHONY: build test

# `npm ci` installs exactly what package-lock.json pins. Needs Node 22.22.2 or newer (it runs the .ts files directly).
# The bot reuses the deploy package's testnet guards, key store and RPC reads, so that package must be installed too.
node_modules/.package-lock.json: package.json package-lock.json
	npm ci --no-audit --no-fund

../deploy/node_modules/.package-lock.json: ../deploy/package.json ../deploy/package-lock.json
	$(MAKE) --no-print-directory -C ../deploy node_modules/.package-lock.json

# Nothing to compile (Node runs the .ts files): `build` is the typecheck, so the root Makefile can run this lane like the others.
build: node_modules/.package-lock.json ../deploy/node_modules/.package-lock.json
	npm run --silent typecheck

# Offline: no key, no network.
test: node_modules/.package-lock.json ../deploy/node_modules/.package-lock.json
	npm run --silent typecheck
	npm test --silent
