.PHONY: test verify

# `npm ci` installs exactly what package-lock.json pins. Needs Node 22.22.2 or newer (it runs the .ts files directly).
node_modules/.package-lock.json: package.json package-lock.json
	npm ci --no-audit --no-fund

# Offline: no key, no network.
test: node_modules/.package-lock.json
	npm run --silent typecheck
	npm test --silent

# Read-only: re-checks the recorded testnet deployment from public views. Needs no key.
verify: node_modules/.package-lock.json
	node src/cli.ts verify $(if $(WASM),--wasm $(WASM),)
