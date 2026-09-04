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

# Pinned in colony-versions.json: BUN_VERSION is its .bun value, NODE_MAJOR
# is the major of its .node value (the leading v and patch digits are
# stripped - image tags only exist per major). Bump there.
ARG BUN_VERSION=1.3.14
ARG NODE_MAJOR=24

FROM docker.io/library/node:${NODE_MAJOR}-bookworm-slim
# Re-declared for stage scope: the global ARGs above are only visible to FROM.
ARG BUN_VERSION
ARG NODE_MAJOR
WORKDIR /workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates git tar \
    chromium fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
# Bun is the repo's runtime and test runner. PINNED via BUN_VERSION (default
# from colony-versions.json) to the same version as the colonyd image and the
# CI shell: an unpinned `npm install -g bun` drifted to 1.4.0 while everything
# else ran 1.3.14, and every validate on 2026-09-01 failed five tests that
# pass on the pinned runtime. Bump all three together via the JSON file.
RUN npm install -g bun@${BUN_VERSION}
# The PVC mounts /workspace root-owned (fsGroup fixes the group, not the
# owner) while the transferred files are uid 1000. git's ownership check
# looks at the repo ROOT, sees root != node, and refuses every command:
# `git ls-files` printed nothing, so `xargs bun test` ran the whole tree
# including Playwright specs, and every agent burned turns rediscovering
# `safe.directory` (2026-09-02). Trust the workspace at the system level.
RUN git config --system --add safe.directory /workspace
# Test-suite browser contract (see task specs): Playwright configs point
# executablePath here instead of downloading browsers per run.
ENV COLONY_TEST_CHROMIUM_PATH=/usr/bin/chromium
RUN mkdir -p /workspace && chown node:node /workspace
USER node
CMD ["sleep", "infinity"]
