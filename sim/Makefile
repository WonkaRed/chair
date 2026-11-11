.PHONY: build test demo

# `npm ci` installs exactly what package-lock.json pins. Needs Node 22.22.2 or newer.
node_modules/.package-lock.json: package.json package-lock.json
	npm ci --no-audit --no-fund

build: node_modules/.package-lock.json
	npm run --silent typecheck
	npm run --silent build

test: node_modules/.package-lock.json
	npm run --silent typecheck
	npm test --silent

demo: node_modules/.package-lock.json
	npm run --silent demo
