# syntax=docker/dockerfile:1.7
# Build context: repo root. Built via Buildah on Aether's GitLab Kubernetes runner.

FROM docker.io/library/node:24-bookworm-slim AS deps
WORKDIR /workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY apps/colonyd/package.json ./apps/colonyd/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/config/package.json ./packages/config/
COPY packages/core/package.json ./packages/core/
COPY packages/domain/package.json ./packages/domain/
COPY packages/observability/package.json ./packages/observability/
COPY packages/provider/package.json ./packages/provider/
COPY packages/provider-gitlab/package.json ./packages/provider-gitlab/
COPY packages/schemas/package.json ./packages/schemas/
# tsx lives in the root workspace; keep it in the image so `npm start` works.
RUN npm ci --include=dev --no-audit --no-fund

FROM docker.io/library/node:24-bookworm-slim AS runtime
WORKDIR /workspace
ENV NODE_ENV=production \
    HOME=/tmp \
    TMPDIR=/tmp
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /workspace/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps/colonyd ./apps/colonyd
USER node
CMD ["npm", "--workspace", "@colony/colonyd", "run", "start"]
