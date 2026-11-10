# Proves the repo from a clean clone: `docker build .` fails unless `make test` passes.
# `docker run <image>` then runs `make demo`.
# trixie, not bookworm: the nearcore sandbox binary needs glibc 2.39 or newer.
FROM rust:1.95-trixie

WORKDIR /chair

# The toolchain layer only changes when rust-toolchain.toml does.
COPY rust-toolchain.toml .
RUN rustup toolchain install

COPY . .
RUN make test

CMD ["make", "demo"]
