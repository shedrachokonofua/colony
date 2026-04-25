# ADR-007: Aether deployment ownership boundaries

**Status:** Accepted
**Date:** 2026-04-24
**Revisions:**

- 2026-04-24 — flipped apply authority from "separate infra repo" to "Colony's CI" after seeing the static-site / foundry / relay pattern.
- 2026-04-24 — clarified that Colony deploys to the Aether **host** cluster (Talos), not into the seven30 vcluster. Seven30 is a co-founder workspace; Colony is its own tenant. Stripped all `seven30/infra` references from the deploy path. Aether's existing `aether-k8s` GitLab Agent already authorizes the `so` group, so Colony's CI can `kubectl`/Tofu against the host with no change to Aether's agent config.

## Context

Colony deploys to the same physical home-lab cluster `~/projects/aether` provisions — the Talos cluster reachable through the GitLab Kubernetes Agent registered as `aether-k8s`. Aether's host cluster runs the platform: Talos, Cilium, Istio Ambient, Gateway API + cert-manager + step-issuer, Crossplane, the GitLab Kubernetes runner pool (tagged `buildah`), and the `aether-k8s` Agent. It does **not** run cluster-wide CNPG, Temporal, or External Secrets Operator — those live inside per-tenant vclusters (e.g. `seven30`).

Colony is a peer tenant of `seven30`, not a workload inside it. It needs:

- Its own namespaces on the host cluster (`colony`, `colony-dev`, `colony-sandboxes`).
- Its own Postgres and Temporal, installed inside those namespaces (not platform services).
- A path to read secrets from Aether's OpenBao at `bao.home.shdr.ch`.
- A short MR-to-deploy loop without an Aether MR per change.

Without a clear ownership split, two failure modes appear:

- **Reinstalling platform services.** A Colony chart that bundled cert-manager or its own Cilium/Gateway plumbing would conflict with Aether.
- **Block-on-infra MRs.** Routine Colony changes shouldn't require an Aether MR — the deploy authority for Colony's surface lives in Colony's pipeline.

## Decision

### Apply authority

- **Colony's CI applies its own Tofu** against the Aether host cluster, using Aether's existing `aether-k8s` GitLab Agent (`ci_access` already authorizes the `so` group, which `so/colony` is part of). Stages: `validate → build → plan → apply`. Apply is `when: manual` on the default branch.
- **Tofu lives in this repo** at `tofu/` (lands in COL-1.9). State is GitLab-managed (`backend "http"` against `gitlab.home.shdr.ch/api/v4/projects/<colony-id>/terraform/state/colony`).
- **No shared CI template include.** The seven30 `ci-templates.yml` is wired to the seven30 vcluster (its OpenBao role, its KUBE_CONTEXT) and doesn't apply to a peer tenant. Equivalent jobs (`.kube-auth-aether`, `.bao-auth`, `.image-build`, plus inline Tofu validate/plan/apply) live in Colony's `.gitlab-ci.yml`. If multiple Aether-host tenants emerge, consolidating into a shared template lives in Aether — not seven30.
- **No Helm chart.** Like every other tenant, Colony's Tofu writes Kubernetes resources directly via `kubernetes_*` and `kubectl_manifest` providers. A chart adds a packaging artifact for no benefit at this scale.

### What Colony owns (in this repo)

- **Tofu module** at `tofu/`: namespaces, Deployments, Services, ServiceAccounts, NetworkPolicies, HTTPRoutes (attached to Aether's main Gateway), `SandboxTemplate` CRs once the controller exists, plus the in-namespace **Postgres** (CNPG `Cluster` CR or a simpler operator) and **Temporal** stack Colony needs at runtime.
- **Container images** for each app, published to Colony's GitLab project registry under `$CI_REGISTRY_IMAGE/<app>:<sha>`.
- **Secret consumption**: Tofu reads Aether's OpenBao via the `vault` provider at apply time and writes `kubernetes_secret_v1` resources directly (no ESO dependency on host). If a future Aether MR adds ESO cluster-wide, Colony can switch to `ExternalSecret` resources without changing the secret paths.
- **Application-level configuration**: feature flags, policy defaults, packet/envelope schema versions, bot-account mapping, Tool Gateway allowlists.

### What Aether owns (in `~/projects/aether`)

- **The cluster** — Talos nodes, control plane, upgrades, Cilium, Istio Ambient, Gateway API main Gateway listening on `*.apps.home.shdr.ch`, cert-manager + step-issuer, Crossplane.
- **The `aether-k8s` GitLab Agent.** Already authorizes the `so` group (see `.gitlab/agents/aether-k8s/config.yaml`). Colony reads this — no Aether change required for deploy access.
- **The GitLab Kubernetes runner pool (`gitlab-runner-k8s`)** tagged `buildah`. Colony's image-build jobs target it.
- **OpenBao** at `bao.home.shdr.ch` (host-level deploy at `~/projects/aether/tofu/home/openbao_*.tf`). Colony depends on Aether adding a `vault_jwt_auth_backend` for Colony's CI OIDC tokens (modeled on `openbao_seven30.tf`) and a `kv/colony/*` mount path policy.
- **DNS, TLS, ingress** — host Gateway listeners + cert-manager-issued certificates. Colony writes HTTPRoutes that attach to the existing Gateway.
- **Cluster-scoped CRDs** Colony needs in later phases (agent-sandbox controller, possibly ESO). Cluster-wide installs land via Aether MRs because they affect every tenant.

### Handoff contract

- **Colony publishes**: Tofu module (in-repo), image SHAs, the `kv/colony/*` paths it expects to read, the namespaces it creates, the `SandboxTemplate` CR shapes, the Tool Gateway egress allowlist seeds.
- **Aether consumes**: a one-time MR adding Colony's OpenBao GitLab-CI auth (`jwt-gitlab-colony` mount + `colony-ci` role + policy granting `kv/data/colony/*` read).
- **A change that crosses the contract** (new OpenBao path, cluster-wide CRD, dependency on a platform service Aether doesn't yet provide) needs an MR in **both** repos. A change strictly within Colony's surface does not.

## Alternatives Considered

- **Deploy into the `seven30` vcluster.** Rejected. Seven30 is a co-founder workspace, not a multi-tenant platform; Colony is its own tenant. Sharing would couple Colony's lifecycle (CRDs, RBAC, networking) to seven30's.
- **Spin up a `colony` vcluster on Aether.** Adds a vcluster to manage and a second control plane to bootstrap (Postgres/Temporal/ESO inside). For one tenant the vcluster overhead isn't worth the isolation given Aether already gives Colony its own namespaces and the `so`-group RBAC.
- **Helm chart packaged to OCI registry, applied via a separate Tofu in `~/projects/aether`.** Rejected. Adds a packaging artifact and a separate apply authority; the per-tenant pattern is "tenant repo holds its own Tofu."
- **Aether owns a `helm_release.colony`.** Same problem; slows every Colony change to an Aether MR.
- **Colony installs Cilium/Gateway/cert-manager itself.** Rejected — those are host-level. Colony only installs what's namespace-scoped.
- **`kubectl apply` from CI without Tofu.** Loses state tracking and drift detection.
- **GitLab CI variables for secrets** instead of OpenBao read-at-apply-time. Works for MVP but becomes painful as the secret count grows; OpenBao gives rotation and centralized audit. Worth the small Aether MR.

## Rationale

- Aether's host cluster already exposes everything Colony needs at the platform layer (Agent + runner + Gateway + cert-manager + GitLab + OpenBao). Reusing them is faster than reproducing them in a vcluster.
- App services iterate fast and need a short MR-to-deploy path. In-repo Tofu plus inline CI jobs gives every Colony MR a one-pipeline-to-prod shape.
- Reading OpenBao at Tofu apply time keeps secrets out of CI variables and out of the repo, while staying simple (no ESO dependency until Aether adds it cluster-wide).
- A clear handoff contract reduces "who owns this" churn across repos.
- `apply when: manual` on `main` keeps a human in the loop for each rollout while still letting non-default-branch MRs `plan` to surface drift in review.

## Consequences

- **No `charts/colony/`.** Colony's K8s shape lives in `tofu/` (lands in COL-1.9) using `kubernetes`, `kubectl`, and `vault` Tofu providers.
- **`tofu/main.tf`** declares the GitLab-managed `backend "http"`, the providers above, reads OpenBao via `data "vault_kv_secret_v2"`, and writes Kubernetes resources directly. Postgres + Temporal land in-namespace (CNPG `Cluster` CR or a simpler operator; Temporal Helm chart via Tofu `helm_release` is fine since that's namespace-scoped).
- **`.gitlab-ci.yml`** stages: `validate → build → plan → apply`. `validate` runs Nix-driven workspace checks plus `tofu validate`. `build` runs Buildah image builds tagged `buildah` so they pick the Aether k8s runner. `plan`/`apply` use inline `.kube-auth-aether` (kubeconfig pointed at `https://gitlab.home.shdr.ch/-/kubernetes-agent/k8s-proxy/`) and `.bao-auth` (OIDC JWT exchange against OpenBao).
- **One-time Aether MR** before the first apply: `vault_jwt_auth_backend "gitlab_colony"` at path `jwt-gitlab-colony`, role `colony-ci`, policy `kv/data/colony/*` read. Tracked in `docs/aether-handoff.md`.
- **Colony's chart README is moot** (no chart). Replaced by `docs/aether-handoff.md` + the Tofu module's own README.
- **Apply authority is Colony's CI**, not Aether. The `apply` job is `when: manual` on `main` so a human still confirms each rollout.

## Revisit When

- Multiple Aether-host tenants emerge and the inline `.kube-auth-aether` / `.bao-auth` jobs duplicate across repos — promote them to a shared `aether/ci-templates.yml` and `include:` it. (The seven30 templates live in seven30 because seven30 is a vcluster; the host equivalent lives in Aether.)
- Colony grows enough cluster-scoped surface (multiple CRDs, cluster RBAC, dedicated etcd) that a `colony` vcluster pays back its overhead.
- Aether installs ESO cluster-wide — switch from `kubernetes_secret_v1` written from Tofu vault reads to `ExternalSecret` resources for the same paths.
- The Tofu state grows past what one module can express cleanly — split into per-environment modules (`tofu/dev/`, `tofu/prod/`).
