# CI image for validate / unit-tests / integration-tests. Built by the
# `build:ci` job (only when docker/ci or the lockfile changes) and pulled as
# `$CI_REGISTRY_IMAGE/ci:latest`. Bakes what every job otherwise redid:
# apt git + ca-certificates, and a warm bun install cache so
# `bun install --frozen-lockfile` in the job is a link step, not a download.
# Build context: repo root.
#
# Pinned in colony-versions.json (shared with Dockerfile, docker/sandbox and
# flake.nix). Bump there.
ARG BUN_VERSION=1.3.14
ARG NODE_MAJOR=24

# Same harvest as the root Dockerfile: every workspace package.json, paths
# intact, so a new workspace package can never break the install.
FROM docker.io/oven/bun:${BUN_VERSION}-debian AS manifests
WORKDIR /src
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
RUN mkdir -p /manifests \
  && cp --parents package.json bun.lock /manifests/ \
  && find apps packages -maxdepth 2 -name package.json -not -path "*/node_modules/*" \
     -exec cp --parents {} /manifests/ \;

FROM docker.io/oven/bun:${BUN_VERSION}-debian
ARG BUN_VERSION
ARG NODE_MAJOR
ENV DEBIAN_FRONTEND=noninteractive \
    BUN_INSTALL_CACHE_DIR=/opt/bun-cache
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
# The pinned node: oven/bun images ship only Bun's `node` CLI shim, which
# rejects `node --version` ("does not support a repl") — the sandbox
# conformance suite pins the real node from colony-versions.json, so the CI
# shell carries the same node major as the sandbox image (tags exist per
# major only; the full pin is asserted at test time, not install time).
COPY --from=docker.io/library/node:${NODE_MAJOR}-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=docker.io/library/node:${NODE_MAJOR}-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/bin/node /usr/local/bin/nodejs
# Warm the cache only; node_modules belongs to the job checkout. A stale
# cache still works, it just downloads the delta.
WORKDIR /warm
COPY --from=manifests /manifests/ ./
RUN bun install --frozen-lockfile --ignore-scripts \
  && rm -rf /warm
WORKDIR /
