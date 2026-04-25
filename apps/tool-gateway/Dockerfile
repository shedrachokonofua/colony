# syntax=docker/dockerfile:1.7
# Build context: repo root. Built via Buildah on Aether's GitLab Kubernetes runner.
# See ADR-006 for the per-app Dockerfile rationale.

FROM docker.io/library/node:24-bookworm-slim AS deps
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/webhook-dispatcher/package.json ./apps/webhook-dispatcher/
COPY apps/tool-gateway/package.json ./apps/tool-gateway/
COPY apps/web/package.json ./apps/web/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/config/package.json ./packages/config/
COPY packages/db/package.json ./packages/db/
COPY packages/domain/package.json ./packages/domain/
COPY packages/observability/package.json ./packages/observability/
COPY packages/policy/package.json ./packages/policy/
COPY packages/provider/package.json ./packages/provider/
COPY packages/provider-gitlab/package.json ./packages/provider-gitlab/
COPY packages/schemas/package.json ./packages/schemas/
COPY packages/testing/package.json ./packages/testing/
COPY packages/workflows/package.json ./packages/workflows/
RUN npm ci --include=dev

FROM docker.io/library/node:24-bookworm-slim AS runtime
WORKDIR /workspace
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=deps /workspace/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/tool-gateway ./apps/tool-gateway
USER node
WORKDIR /workspace/apps/tool-gateway
EXPOSE 4200
CMD ["npm", "run", "start"]
