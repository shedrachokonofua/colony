# The colony sandbox image used by the kubernetes engine
# (`sandbox.kubernetes.image`, default `registry.gitlab.home.shdr.ch/so/colony/sandbox:latest`).
# Built by the `build:sandbox` GitLab CI job from the repository root (it reads
# the toolset manifest under packages/sandbox). Self-contained at runtime: the
# engine streams the workspace in over `pods/exec`, so the image carries no
# colony code.
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
# The merge gate's built-in SAST step (apps/colonyd merge-gate.ts) runs this
# semgrep against the rules vendored below. Both are pinned so a gate verdict
# never changes because a registry moved underneath it.
ARG SEMGREP_VERSION=1.179.0
ARG SEMGREP_RULES_COMMIT=a84ff9cc2453ca91d581380de4b8b3f272f6f4be

# Rust toolchain for wasmtime-host crates and wasm32-wasip1/p2 components.
# rustup itself is a pinned release binary; the toolchain is an exact stable.
# Neither belongs in colony-versions.json: that file is only the bun/node
# strings shared with the colonyd image and the CI shell.
ARG RUST_VERSION=1.99.0
ARG RUSTUP_VERSION=1.28.2
# Pinned release binaries. The final stage has no curl (the toolset forbids
# it); the fetch stage below downloads these and they are copied in.
ARG WASMTIME_VERSION=49.0.2
ARG WASI_SDK_VERSION=34
ARG WASI_SDK_VERSION_FULL=34.0

FROM docker.io/library/debian:bookworm-slim AS fetch
ARG RUSTUP_VERSION
ARG WASMTIME_VERSION
ARG WASI_SDK_VERSION
ARG WASI_SDK_VERSION_FULL
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/rustup-init \
      "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
  && curl -fsSL -o /tmp/wasmtime.tar.xz \
      "https://github.com/bytecodealliance/wasmtime/releases/download/v${WASMTIME_VERSION}/wasmtime-v${WASMTIME_VERSION}-x86_64-linux.tar.xz" \
  && tar -xJf /tmp/wasmtime.tar.xz -C /tmp \
  && install -m 755 "/tmp/wasmtime-v${WASMTIME_VERSION}-x86_64-linux/wasmtime" /tmp/wasmtime \
  && curl -fsSL -o /tmp/wasi-sdk.tar.gz \
      "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_VERSION_FULL}-x86_64-linux.tar.gz"

FROM docker.io/library/node:${NODE_MAJOR}-bookworm-slim
ARG BUN_VERSION
ARG NODE_MAJOR
ARG SEMGREP_VERSION
ARG SEMGREP_RULES_COMMIT
ARG RUST_VERSION
ARG RUSTUP_VERSION
ARG WASMTIME_VERSION
ARG WASI_SDK_VERSION
ARG WASI_SDK_VERSION_FULL
WORKDIR /workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates git tar \
    chromium fonts-liberation \
    python3 python3-venv \
    gcc libc6-dev pkg-config \
  && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/semgrep \
  && /opt/semgrep/bin/pip install --no-cache-dir "semgrep==${SEMGREP_VERSION}" \
  && ln -s /opt/semgrep/bin/semgrep /usr/local/bin/semgrep
# Only rule files: the upstream repository interleaves rules with their test
# fixtures, and a fixture under --config is a parse error, not a rule.
RUN git init -q /tmp/semgrep-rules \
  && git -C /tmp/semgrep-rules fetch -q --depth 1 https://github.com/semgrep/semgrep-rules.git "${SEMGREP_RULES_COMMIT}" \
  && git -C /tmp/semgrep-rules checkout -q FETCH_HEAD \
  && mkdir -p /opt/semgrep-rules \
  && cp -r /tmp/semgrep-rules/javascript /tmp/semgrep-rules/typescript /opt/semgrep-rules/ \
  && find /opt/semgrep-rules -type f ! -name '*.yaml' ! -name '*.yml' -delete \
  && rm -rf /tmp/semgrep-rules
# Bun is the repo's runtime and test runner. PINNED via BUN_VERSION (default
# from colony-versions.json) to the same version as the colonyd image and the
# CI shell: an unpinned `npm install -g bun` drifted to 1.4.0 while everything
# else ran 1.3.14, and every validate on 2026-09-01 failed five tests that
# pass on the pinned runtime. Bump all three together via the JSON file.
RUN npm install -g bun@${BUN_VERSION}
# Rust: rustup proxies and the toolchain live under /opt/rustup (read-only
# content, world-executable). CARGO_HOME is the node user's own directory so
# uid 1000 can write the registry cache at runtime; the image creates it
# empty and owned by node. Minimal profile plus rustfmt and clippy, with
# both WASI targets wasmtime runs.
COPY --from=fetch /tmp/rustup-init /tmp/rustup-init
RUN chmod 755 /tmp/rustup-init \
  && RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/rustup \
    /tmp/rustup-init -y --no-modify-path --profile minimal \
      --default-toolchain "${RUST_VERSION}" \
      --target wasm32-wasip2 --target wasm32-wasip1 \
      --component rustfmt,clippy \
  && rm /tmp/rustup-init \
  && chmod -R a+rX /opt/rustup
# wasmtime CLI, pinned release binary extracted in the fetch stage.
COPY --from=fetch /tmp/wasmtime /usr/local/bin/wasmtime
# wasi-sdk, unpacked so WASI_SDK_PATH is exactly /opt/wasi-sdk.
COPY --from=fetch /tmp/wasi-sdk.tar.gz /tmp/wasi-sdk.tar.gz
RUN tar -xzf /tmp/wasi-sdk.tar.gz -C /opt \
  && mv "/opt/wasi-sdk-${WASI_SDK_VERSION_FULL}-x86_64-linux" /opt/wasi-sdk \
  && rm /tmp/wasi-sdk.tar.gz
ENV RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/home/node/.cargo \
    WASI_SDK_PATH=/opt/wasi-sdk \
    PATH="/opt/rustup/bin:/home/node/.cargo/bin:${PATH}"
RUN install -d -o node -g node /home/node/.cargo
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
# The toolset contract agents are told about (packages/sandbox image-tools):
# the build fails when a declared tool is missing or an excluded one exists.
COPY packages/sandbox/src/image-tools.json /etc/colony/sandbox-tools.json
COPY docker/sandbox/verify-tools.mjs /etc/colony/verify-tools.mjs
USER node
RUN node /etc/colony/verify-tools.mjs /etc/colony/sandbox-tools.json
CMD ["sleep", "infinity"]
