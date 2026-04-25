# GitLab CI

Colony's CI is a single `.gitlab-ci.yml` at the repo root. It builds per-app images via Buildah on Aether's `gitlab-runner-k8s` pool, plans and applies Colony's own Tofu module against the Aether host cluster (not the seven30 vcluster) via the existing `aether-k8s` GitLab Agent. Decisions are in [ADR-006](./adr/006-gitlab-ci-structure.md) and [ADR-007](./adr/007-aether-deployment-boundaries.md); this doc is the operational walkthrough.

## Pipeline shape

Stages: `validate → unit → integration → build → plan → apply`.

| Stage       | Jobs (today)                                                                                          | Jobs (deferred)                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| validate    | `flake-check`, `format-check`, `lint`, `typecheck`, `schemas-check`, `openapi-check`, `tofu-validate` | —                                                                                                    |
| unit        | `unit-tests`                                                                                          | —                                                                                                    |
| integration | `integration:db`, `integration:api`, `integration:provider-gitlab-contract`                           | app-specific real dependency tests for webhook dispatcher, worker, tool gateway; live provider / E2E |
| build       | `build:api`, `build:worker`, `build:webhook-dispatcher`, `build:tool-gateway`, `build:web`            | image scan / signing (COL-X.1a)                                                                      |
| plan        | `plan` (inline, kube-auth-aether + bao-auth)                                                          | —                                                                                                    |
| apply       | `apply` (`when: manual` on `main`)                                                                    | post-apply migrate / smoke (COL-X.1a)                                                                |

`tofu-validate`, `plan`, and `apply` are gated by `exists: tofu/main.tf` so they stay no-ops until the Tofu module lands in COL-1.9. The pipeline shape is stable from day one; only the existence of `tofu/main.tf` flips the deploy jobs on.

The integration stage uses CI-local dependencies by default. Postgres-backed jobs run a `postgres:16-alpine` service and set `COLONY_TEST_DATABASE_URL`; provider contract tests use mocked GitLab API responses. Existing unit-level HTTP boundary tests are not duplicated in the integration stage. Live home-lab GitLab and deployed-environment tests belong in post-apply smoke jobs or explicit manual jobs, not default MR validation.

## Pipeline triggers

`workflow.rules` runs the pipeline on:

- `merge_request_event` — every push to an MR branch.
- `$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH` — pushes to `main`.
- `$CI_COMMIT_TAG` — release tags.

Plan runs on MRs and `main`. Apply runs only on `main`, and only when a human clicks "play" on the manual job.

## Reusable hidden jobs

Defined inline in `.gitlab-ci.yml` (no cross-repo include — Colony is a peer tenant of the Aether host, not a workload in seven30):

- `.with-deps` — enters `nix develop --command npm ci ...` for the workspace jobs.
- `.kube-auth-aether` — builds a kubeconfig pointed at `https://gitlab.home.shdr.ch/-/kubernetes-agent/k8s-proxy/` with credential `ci:${AETHER_AGENT_ID}:${CI_JOB_TOKEN}`. Same pattern the static-site template uses (`gitlab.home.shdr.ch/so/templates/static-site`).
- `.bao-auth` — id_token with `aud: https://bao.home.shdr.ch`, exchanged for a `VAULT_TOKEN` against `https://bao.home.shdr.ch/v1/auth/jwt-gitlab-colony/login` (role `colony-ci`). Used by plan/apply for `data "vault_kv_secret_v2"` reads in `tofu/`.
- `.image-build` — Buildah base: `quay.io/buildah/stable:latest`, `tags: [buildah]` so it goes to Aether's k8s runner, `before_script` does `buildah login` against `$CI_REGISTRY`.

When an Aether-owned shared template appears (multiple host-tenants), these get promoted there and `included` instead.

## Runner assumptions

Aether's `gitlab-runner-k8s` pool runs in the `gitlab-runner` namespace on the host cluster (`~/projects/aether/tofu/home/kubernetes/gitlab_runner.tf`). Two image classes appear in `.gitlab-ci.yml`:

- **Nix-driven jobs** use `nixos/nix:<pin>` and enter `nix develop --command <cmd>`. The flake (`flake.nix`) supplies Node 24, npm, Temporal CLI, Postgres client, kubectl/Helm/k9s, GitLab CLI, Prettier, Buildah/Podman, actionlint, and `docker-compose`. CI matches local — same flake, same versions.
- **Image builds and Tofu** use their own images (`quay.io/buildah/stable:latest`, `ghcr.io/opentofu/opentofu:1.11`).

Runner expectations (managed in Aether, listed here for visibility):

- Pod can pull from Docker Hub (`nixos/nix`, `node:24-alpine`), `quay.io/buildah/stable`, and `ghcr.io/opentofu/opentofu`.
- Buildah jobs need `/var/lib/containers` writable (the runner profile already grants this).
- The `aether-k8s` GitLab Agent's `ci_access` already authorizes the `so` group (`~/projects/aether/.gitlab/agents/aether-k8s/config.yaml`), so Colony's CI can use the k8s-proxy with no Aether change.
- `GITLAB_OIDC_TOKEN`-style id_tokens are issued by GitLab; `.bao-auth` consumes one with `aud: https://bao.home.shdr.ch`.

## Caching

`default.cache` keys on `package-lock.json` and persists `node_modules/`, per-workspace `node_modules/`, and `.npm-cache/`. Image build and Tofu jobs opt out (`cache: []`).

The Nix store (`/nix/store`) is not cached today — first runs pay the toolchain download. Acceptable for now.

## Schema staleness

`schemas-check` runs `npm run schemas:check`, which calls `scripts/schemas-generate.mjs` then `git diff --exit-code -- schemas`. Today the generator is a no-op (real generators land in COL-0.5 / COL-0.9, see `schemas/README.md`); the gate exists from day one so the first generator can't ship without the staleness check.

Developer flow when the gate fires red: run `npm run schemas:generate` locally, commit the diff under `schemas/`, push.

## Container registry and image tags

Images go to `$CI_REGISTRY_IMAGE/<app>:<tag>`:

- Every push: `:$CI_COMMIT_SHA`.
- Pushes to `main`: also `:latest` (convenience tag — Tofu values must reference SHAs, never `:latest`, per ADR-006).
- Tag pipelines: future work will add `:<semver>` and signed manifests (COL-X.1a).

Lifecycle: GitLab project → Settings → CI/CD → Container Registry → keep the last 50 images and last 10 days.

## Tofu state

GitLab-managed Tofu state via `backend "http"`:

```
address = "https://gitlab.home.shdr.ch/api/v4/projects/<colony-project-id>/terraform/state/colony"
```

Auth in CI is automatic (`TF_HTTP_USERNAME=gitlab-ci-token`, `TF_HTTP_PASSWORD=$CI_JOB_TOKEN`). Locally, `tofu init` from inside the Nix dev shell — set `TF_HTTP_USERNAME=<your-gitlab-user>` and `TF_HTTP_PASSWORD=<your-PAT-with-api-scope>` first.

## Required CI/CD variables

Built-in (provided by GitLab):

- `CI_REGISTRY`, `CI_REGISTRY_USER`, `CI_REGISTRY_PASSWORD`, `CI_REGISTRY_IMAGE`
- `CI_COMMIT_SHA`, `CI_COMMIT_BRANCH`, `CI_COMMIT_TAG`, `CI_DEFAULT_BRANCH`
- `CI_PROJECT_DIR`, `CI_PIPELINE_SOURCE`, `CI_JOB_TOKEN`

Project-scoped CI variable Colony sets (one):

| Variable          | Purpose                                                                                  | Where                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `AETHER_AGENT_ID` | Numeric ID of the `aether-k8s` GitLab Agent registration. Used in the `ci:<id>:<token>`. | GitLab project → Settings → CI/CD → Variables. Default `1` is fine for a single agent. |

No secret CI variables are required for the deploy. Every secret reaches Colony at runtime by Tofu reading OpenBao at apply time and writing `kubernetes_secret_v1` resources. If a future stage needs project-scoped credentials (e.g., signing keys for image scanning, COL-X.1a), they go in Variables, marked **protected, masked**, and documented here.

## Protected branches and tags

`main` is protected. Tags `v*` are protected. Apply runs only on `$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH` and is `when: manual`. Don't add deploy jobs without protected refs.

## Local parity

Run the same checks locally before pushing:

```sh
nix develop
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run schemas:check
npm run test:unit
# Requires COLONY_TEST_DATABASE_URL for DB/API integration tests.
npm run test:integration
# Once tofu/ exists (COL-1.9):
cd tofu && tofu fmt -check && tofu validate
```

`actionlint` is in the dev shell. For GitLab-specific lint use `glab ci lint` (also in the dev shell) before pushing CI changes.

## Handoff

CI's responsibility ends at "Tofu apply succeeded against the Aether host cluster." There is no handoff to a separate apply authority. See [`docs/aether-handoff.md`](./aether-handoff.md) for the platform contract: what Aether already provides and the one OpenBao MR Colony needs from Aether before the first apply.
