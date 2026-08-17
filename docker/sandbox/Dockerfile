# The colony sandbox image used by the kubernetes engine
# (`sandbox.kubernetes.image`, default `registry.gitlab.home.shdr.ch/so/colony/sandbox:latest`).
# Built by the `build:sandbox` GitLab CI job. Self-contained: the engine streams the
# workspace in over `pods/exec` at runtime, so the image carries no colony code.
# Runs as the pre-existing `node` user (uid 1000) with workingDir `/workspace`.

FROM docker.io/library/node:24-bookworm-slim
WORKDIR /workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tar \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /workspace && chown node:node /workspace
USER node
CMD ["sleep", "infinity"]
