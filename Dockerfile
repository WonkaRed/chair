# Proves the repo from a clean clone: `docker build .` fails unless `make test` passes.
# `docker run <image>` then runs `make demo`.
# trixie, not bookworm: the nearcore sandbox binary needs glibc 2.39 or newer.
# Node is copied from the official image of the same Debian release (22.22.2 or newer is required).
FROM node:22.23.4-trixie-slim AS node

FROM rust:1.95-trixie

# `node` is one binary; npm is a directory, and `npm` and `npx` are symlinks into it.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

WORKDIR /chair

# The toolchain layer only changes when rust-toolchain.toml does.
COPY rust-toolchain.toml .
RUN rustup toolchain install

COPY . .
RUN make test

CMD ["make", "demo"]
