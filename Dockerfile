# syntax=docker/dockerfile:1.7
# Build context: repo root. Built via Buildah on Aether's GitLab Kubernetes runner.
#
# Bun, not Node: the agent runtime depends on @oh-my-pi/pi-coding-agent, which
# ships TypeScript source as its import entry and declares engines.bun. Bun also
# executes colonyd's TypeScript directly, so the image needs no build step and no
# loader.

FROM docker.io/oven/bun:1.3.14-debian AS deps
WORKDIR /workspace
COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY apps/colonyd/package.json ./apps/colonyd/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/config/package.json ./packages/config/
COPY packages/console/package.json ./packages/console/
COPY packages/core/package.json ./packages/core/
COPY packages/domain/package.json ./packages/domain/
COPY packages/observability/package.json ./packages/observability/
COPY packages/provider/package.json ./packages/provider/
COPY packages/provider-gitlab/package.json ./packages/provider-gitlab/
COPY packages/schemas/package.json ./packages/schemas/
COPY packages/sandbox-k8s/package.json ./packages/sandbox-k8s/
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
COPY apps/colonyd ./apps/colonyd
COPY config ./config
USER bun
CMD ["bun", "apps/colonyd/src/main.ts"]
