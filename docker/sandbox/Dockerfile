# The colony sandbox image used by the kubernetes engine
# (`sandbox.kubernetes.image`, default `registry.gitlab.home.shdr.ch/so/colony/sandbox:latest`).
# Built by the `build:sandbox` GitLab CI job. Self-contained: the engine streams the
# workspace in over `pods/exec` at runtime, so the image carries no colony code.
# Runs as the pre-existing `node` user (uid 1000) with workingDir `/workspace`.
#
# The image is the substrate contract for agent runs: anything every attempt
# would otherwise download at run time (browser binaries, the Bun runtime)
# is baked in, because a fresh pod per attempt turns per-run setup into pure
# attempt-budget waste - the Playwright task burned whole 60-minute walls on
# repeated Chromium downloads that a preinstalled browser makes free.

FROM docker.io/library/node:24-bookworm-slim
WORKDIR /workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates git tar \
    chromium fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
# Bun is the repo's runtime and test runner (bun install / bun test).
RUN npm install -g bun
# Test-suite browser contract (see task specs): Playwright configs point
# executablePath here instead of downloading browsers per run.
ENV COLONY_TEST_CHROMIUM_PATH=/usr/bin/chromium
RUN mkdir -p /workspace && chown node:node /workspace
USER node
CMD ["sleep", "infinity"]
