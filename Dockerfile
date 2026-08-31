# syntax=docker/dockerfile:1.7
# Build context: repo root. Built via Buildah on Aether's GitLab Kubernetes runner.
#
# Bun, not Node: the agent runtime depends on @oh-my-pi/pi-coding-agent, which
# ships TypeScript source as its import entry and declares engines.bun. Bun also
# executes colonyd's TypeScript directly, so the image needs no build step and no
# loader.

# Manifests stage: harvest every workspace package.json with paths intact.
# The deps layer below keys its cache on this stage's CONTENT, so unchanged
# manifests still cache-hit - and a new workspace package can never silently
# break the image again (apps/cli did exactly that to a hand-kept COPY list
# on 2026-08-31: five consecutive build failures on its MR).
FROM docker.io/oven/bun:1.3.14-debian AS manifests
WORKDIR /src
COPY . .
RUN mkdir -p /manifests \
  && cp --parents package.json bun.lock tsconfig.base.json tsconfig.json /manifests/ \
  && find apps packages -maxdepth 2 -name package.json -not -path "*/node_modules/*" \
     -exec cp --parents {} /manifests/ \;

FROM docker.io/oven/bun:1.3.14-debian AS deps
WORKDIR /workspace
COPY --from=manifests /manifests/ ./
RUN bun install --frozen-lockfile

FROM docker.io/oven/bun:1.3.14-debian AS runtime
WORKDIR /workspace
ARG COLONY_VERSION=unknown
ENV NODE_ENV=production \
    HOME=/tmp \
    TMPDIR=/tmp \
    COLONY_VERSION=$COLONY_VERSION
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /workspace/node_modules ./node_modules
COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY config ./config
USER bun
CMD ["bun", "apps/colonyd/src/main.ts"]
