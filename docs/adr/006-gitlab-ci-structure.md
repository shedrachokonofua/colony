# ADR-006: GitLab CI job structure and image build strategy

**Status:** Accepted
**Date:** 2026-04-24

## Context

Colony's CI is GitLab CI (`design.md` §19, COL-0.3a). The CI must:

- Run Nix flake checks, install, typecheck, unit tests, schema generation diff (ADR-003), lint/format.
- Build per-app container images for all five apps and push them to the GitLab container registry with SHA-tagged references.
- Use Aether's existing GitLab Kubernetes runner path, which expects Buildah (rootless OCI builds) rather than Docker-in-Docker.
- Gate deploys to Aether (`colony-dev` first, later prod) behind protected refs so arbitrary branches cannot deploy.
- Produce artifacts that Tofu's `helm_release` in Aether can consume (packaged Helm chart pushed to the GitLab OCI registry).

## Decision

- **Single `.gitlab-ci.yml` at repo root**, with stages: `check`, `test`, `build`, `package`, `deploy`.
- **Nix as the shared runtime for non-build jobs.** Jobs that run `npm`, `tsc`, `vitest`, lint, format, or schema generation start by entering `nix develop -c <command>` to pin toolchain versions to the flake.
- **Buildah for image builds.** A per-app `Dockerfile` at `apps/<name>/Dockerfile` is built with `buildah bud` and pushed to `$CI_REGISTRY_IMAGE/<app>:$CI_COMMIT_SHA`. A `latest` tag is applied on `main`.
- **Helm chart packaging** (`charts/colony/`, once COL-1.9 lands) is pushed to the GitLab OCI registry with `helm push` tagged by the git SHA and by semver on tags.
- **Deploy jobs** run only on protected refs. `colony-dev` deploys trigger on every push to `main`; prod deploys require a tag and manual approval (`when: manual`).
- **Schema staleness check:** a CI job regenerates `schemas/openapi/*.json` and `schemas/envelopes/*.json` from source and fails if `git diff --exit-code` reports changes. Developers run `npm run schemas:generate` before pushing.
- **Container registry:** GitLab's project registry (`$CI_REGISTRY_IMAGE`). Images are pruned by GitLab lifecycle policy (e.g., keep last 50 + last 10 days).
- **Caching:** npm cache via GitLab `cache:` keyed on `package-lock.json`; Nix store cache if self-hosted builder supports it. Buildah layer cache via registry pull-through.

## Alternatives Considered

- **Docker-in-Docker for builds.** Simpler to write but requires privileged runners; Aether's runner path is rootless Buildah. Rejected for policy alignment.
- **Kaniko / BuildKit.** Both viable. Buildah chosen because the Aether docs explicitly support it on their runner and the team has existing familiarity.
- **GitHub Actions.** Not applicable while GitLab is the source of truth.
- **One multi-stage Dockerfile that builds every app.** Would slow every image rebuild when any package changes. Per-app Dockerfiles let us use registry layer cache effectively.
- **Separate chart repo.** Adds ops overhead for zero gain — GitLab's OCI registry hosts the chart alongside the images.
- **Triggering Tofu apply from CI directly.** Convenient but couples CI credentials to cluster write. Instead, CI publishes the chart artifact; the Tofu apply runs from `~/projects/aether` with its own credentials.

## Rationale

- Nix in CI matches Nix locally — one toolchain definition, no drift.
- Buildah aligns with Aether's runner policy and rootless-by-default stance.
- Per-app Dockerfiles match Kubernetes topology (each app is its own Deployment) and keep layer caches small.
- Checked-in + CI-verified schemas catch contract drift without requiring a live service.
- Separating "CI builds artifacts" from "Aether applies them" keeps credentials narrow and auditable.

## Consequences

- Every app needs a `Dockerfile` at `apps/<name>/Dockerfile`. The Dockerfile runs `npm ci --workspaces --include-workspace-root=false -w <app>` (or equivalent) to prune to the app's dependency graph.
- `.gitlab-ci.yml` is the canonical workflow definition; any CI logic shared across jobs goes in `.gitlab/ci/` as includes, not in shell snippets duplicated per job.
- A `docs/ci.md` (or section in the CI ADR) documents runner assumptions, required CI/CD variables (`GITLAB_PROJECT_TOKEN`, `HELM_REGISTRY_USER`, etc.), and the Aether handoff.
- Image tagging is SHA-based; all references from Helm values are explicit SHAs, not `latest`. Prod rollouts pin a SHA.
- Developers who change schemas must either regenerate locally or push and let CI tell them. CI failures on schema drift are expected and cheap.

## Revisit When

- Aether moves off GitLab (unlikely) or off the Kubernetes runner path → revisit Buildah + runner assumptions.
- Build times exceed ~10 minutes at P50 → evaluate a shared build cache, remote Buildah, or selective image rebuilds via a build graph tool.
- We need PR previews that spin up per-branch environments on Aether → extend the pipeline with a `preview` stage and ephemeral namespaces.
