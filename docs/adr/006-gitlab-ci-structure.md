# ADR-006: GitLab CI job structure and image build strategy

**Status:** Accepted
**Date:** 2026-04-24
**Revisions:**

- 2026-04-24 — replaced Helm chart packaging + a separate apply authority with in-repo Tofu applied from Colony's pipeline. Stages reduced to `validate → build → plan → apply`.
- 2026-04-24 — clarified that Colony deploys directly to the Aether **host** cluster (not into the seven30 vcluster), so the seven30 `ci-templates.yml` is not included; equivalent jobs are inlined here.

## Context

Colony's CI is GitLab CI (`design.md` §19, COL-0.3a). It must:

- Run Nix flake checks, install, typecheck, unit tests, schema generation diff (ADR-003), lint/format.
- Build per-app container images for all five apps and push them to Colony's GitLab project registry with SHA-tagged references.
- Use Aether's existing `gitlab-runner-k8s` pool (rootless Buildah, tagged `buildah`).
- Apply Colony's own Tofu against the Aether host cluster via the `aether-k8s` GitLab Agent (ADR-007). Apply authority is this pipeline.

## Decision

- **Single `.gitlab-ci.yml` at repo root**, with stages: `validate`, `build`, `plan`, `apply`.
- **No shared CI template `include:`.** The seven30 `ci-templates.yml` is wired to the seven30 vcluster (its OpenBao role, its KUBE_CONTEXT) and does not apply to a peer tenant of the host cluster. Equivalent reusable jobs (`.kube-auth-aether`, `.bao-auth`, `.image-build`, plus inline Tofu validate/plan/apply) live in Colony's own pipeline. If multiple host-tenants emerge, consolidating into an Aether-owned shared template is a follow-up.
- **Nix as the shared runtime for Colony's workspace jobs.** `format-check`, `lint`, `typecheck`, `schemas-check`, `unit-tests`, and `flake-check` start by entering `nix develop --command <cmd>` to pin toolchain versions to the flake. Tofu/build jobs use their own images (`ghcr.io/opentofu/opentofu:1.11`, `quay.io/buildah/stable`).
- **Buildah for image builds.** A per-app `Dockerfile` at `apps/<name>/Dockerfile` is built with `buildah bud` and pushed to `$CI_REGISTRY_IMAGE/<app>:$CI_COMMIT_SHA`. A `:latest` tag is also pushed on `main` (Tofu values must reference SHAs, not `:latest`). Image-build jobs `tags: [buildah]` so they land on Aether's k8s runner.
- **Tofu module at `tofu/`** (lands in COL-1.9). State is GitLab-managed (`backend "http"` → `gitlab.home.shdr.ch/api/v4/projects/<id>/terraform/state/colony`). Plan runs on every push to `main` and on MRs; apply is `when: manual` on `main` only.
- **No Helm chart, no chart packaging stage.** Tofu writes Kubernetes resources directly via the `kubernetes` and `kubectl` providers (ADR-007).
- **OpenBao read at apply time.** The Tofu `vault` provider reads `kv/colony/*` paths and writes `kubernetes_secret_v1` resources directly. No ESO dependency on host (none installed). Auth is GitLab OIDC JWT against the `jwt-gitlab-colony` mount Aether is adding.
- **Schema staleness check** (`schemas-check`): regenerates `schemas/openapi/*.json` and `schemas/envelopes/*.json` from source and fails if `git diff --exit-code` reports changes. Developers run `npm run schemas:generate` before pushing.
- **Container registry:** Colony's project registry (`$CI_REGISTRY_IMAGE`). Images pruned by GitLab lifecycle policy (e.g., last 50 + last 10 days).
- **Caching:** npm cache via GitLab `cache:` keyed on `package-lock.json`; Buildah layer cache via registry pull-through. The Nix store is not cached today (revisit if first-run install times bite).

## Alternatives Considered

- **`include:` seven30/infra/ci-templates.yml.** Rejected after the deploy-target correction. Those templates assume the seven30 vcluster's KUBE_CONTEXT and OpenBao role; Colony is a peer tenant of the host cluster, not a workload inside seven30.
- **Docker-in-Docker for builds.** Simpler to write but requires privileged runners; the Aether runner profile is rootless Buildah. Rejected for policy alignment.
- **Kaniko / BuildKit.** Both viable. Buildah chosen because Aether's runner is configured for it.
- **GitHub Actions.** Not applicable while GitLab is the source of truth.
- **One multi-stage Dockerfile that builds every app.** Would slow every image rebuild when any package changes. Per-app Dockerfiles let registry layer cache work effectively.
- **Helm chart packaged to OCI registry + Tofu `helm_release` from a different repo.** Adds a packaging artifact and a second apply authority. Rejected (ADR-007 revision).
- **`kubectl apply` from CI without Tofu.** Loses state tracking and drift detection.

## Rationale

- Nix in CI matches Nix locally — one toolchain definition, no drift.
- Buildah aligns with Aether's runner policy and rootless-by-default stance.
- Per-app Dockerfiles match Kubernetes topology (each app is its own Deployment) and keep layer caches small.
- Checked-in + CI-verified schemas catch contract drift without requiring a live service.
- Inlining the Tofu/kube-auth jobs keeps Colony decoupled from seven30's lifecycle. When a second host-tenant appears, promoting to an Aether-owned template is mechanical.
- `apply when: manual` on `main` keeps a human in the loop for each rollout while still letting non-default-branch MRs `plan` to surface drift in review.

## Consequences

- Every app needs a `Dockerfile` at `apps/<name>/Dockerfile`. The Dockerfile uses repo-root context and copies the workspace tree it needs.
- `.gitlab-ci.yml` is the canonical workflow definition; reusable hidden jobs (`.kube-auth-aether`, `.bao-auth`, `.image-build`, `.with-deps`) live there until an Aether-owned shared template appears.
- `docs/ci.md` documents runner assumptions, required CI/CD variables (most are auto-injected via the GitLab Agent + OIDC; `AETHER_AGENT_ID` is the one project-scoped variable), and the Aether handoff (ADR-007).
- Image tagging is SHA-based; all references from Tofu values must be explicit SHAs, never `:latest`.
- `tofu/` lands in COL-1.9. Until then `tofu-validate`, `plan`, and `apply` are gated by `exists: tofu/main.tf` and stay no-ops.
- Developers who change schemas regenerate locally or push and let CI tell them. CI failures on schema drift are expected and cheap.

## Revisit When

- Aether moves off GitLab CI (unlikely) or off the rootless-Buildah runner path → revisit Buildah + runner assumptions.
- Build times exceed ~10 minutes at P50 → evaluate a shared build cache, remote Buildah, or selective image rebuilds via a build graph tool.
- Multiple Aether-host tenants emerge → promote `.kube-auth-aether` / `.bao-auth` to an Aether-owned shared template and `include:` it.
- The Nix store install in CI becomes the long pole → cache `/nix/store` if the runner supports persistent volumes.
- Aether installs ESO cluster-wide → switch the secret pattern from `kubernetes_secret_v1` to `ExternalSecret`.
