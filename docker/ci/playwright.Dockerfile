# CI image for playwright-tests. Built by `build:ci-playwright` (only when
# docker/ci or the lockfile changes) and pulled as
# `$CI_REGISTRY_IMAGE/ci-playwright:latest`. The upstream Playwright image
# carries browsers and node; this adds the pinned bun and a warm install cache.
# Build context: repo root.
#
# PLAYWRIGHT_VERSION must match @playwright/test in package.json; BUN_VERSION
# is pinned in colony-versions.json. Bump there.
ARG PLAYWRIGHT_VERSION=1.62.1
ARG BUN_VERSION=1.3.14

FROM docker.io/oven/bun:${BUN_VERSION}-debian AS manifests
WORKDIR /src
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
RUN mkdir -p /manifests \
  && cp --parents package.json bun.lock /manifests/ \
  && find apps packages -maxdepth 2 -name package.json -not -path "*/node_modules/*" \
     -exec cp --parents {} /manifests/ \;

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ARG BUN_VERSION
ENV BUN_INSTALL_CACHE_DIR=/opt/bun-cache \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --global "bun@${BUN_VERSION}"
WORKDIR /warm
COPY --from=manifests /manifests/ ./
RUN bun install --frozen-lockfile --ignore-scripts \
  && rm -rf /warm
WORKDIR /
