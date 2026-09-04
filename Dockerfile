# syntax=docker/dockerfile:1.7
# Build context: repo root. Built via Buildah on Aether's GitLab Kubernetes runner.
#
# Bun, not Node: the agent runtime depends on @oh-my-pi/pi-coding-agent, which
# ships TypeScript source as its import entry and declares engines.bun. Bun also
# executes colonyd's TypeScript directly, so the image needs no build step and no
# loader.

# Pinned in colony-versions.json (the single source for the bun/node strings
# shared with docker/sandbox/Dockerfile and flake.nix). Bump there.
ARG BUN_VERSION=1.3.14

# Manifests stage: harvest every workspace package.json with paths intact.
# The deps layer below keys its cache on this stage's CONTENT, so unchanged
# manifests still cache-hit - and a new workspace package can never silently
# break the image again (apps/cli did exactly that to a hand-kept COPY list
# on 2026-08-31: five consecutive build failures on its MR).

FROM docker.io/oven/bun:${BUN_VERSION}-debian AS manifests
# An ARG declared before the first FROM is only visible to FROM lines, so
# every stage must re-declare it to use it in RUN/COPY instructions.
ARG BUN_VERSION=1.3.14
WORKDIR /src
COPY . .
RUN mkdir -p /manifests \
  && cp --parents package.json bun.lock tsconfig.base.json tsconfig.json /manifests/ \
  && find apps packages -maxdepth 2 -name package.json -not -path "*/node_modules/*" \
     -exec cp --parents {} /manifests/ \;

FROM docker.io/oven/bun:${BUN_VERSION}-debian AS deps
ARG BUN_VERSION=1.3.14
WORKDIR /workspace
COPY --from=manifests /manifests/ ./
RUN bun install --frozen-lockfile

FROM docker.io/oven/bun:${BUN_VERSION}-debian AS runtime
ARG BUN_VERSION=1.3.14
WORKDIR /workspace
ENV NODE_ENV=production \
    HOME=/tmp \
    TMPDIR=/tmp
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /workspace/node_modules ./node_modules
COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY config ./config
ARG COLONY_VERSION=unknown
ENV COLONY_VERSION=$COLONY_VERSION
USER bun
CMD ["bun", "apps/colonyd/src/main.ts"]
