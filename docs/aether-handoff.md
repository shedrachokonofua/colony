# Aether Handoff

The contract between Colony (this repo) and [Aether](../../aether), the Tofu repo that owns the home-lab Talos cluster Colony deploys to. Decisions are in [ADR-007](./adr/007-aether-deployment-boundaries.md); this doc is the working artifact.

Colony deploys directly to the Aether **host** cluster — not into the `seven30` vcluster (which is a co-founder workspace). Colony is a peer tenant of `seven30`, in its own namespaces. Apply authority is Colony's CI.

## What Aether already provides (no change needed)

These exist on the host cluster today and Colony just consumes them:

- **Talos Kubernetes cluster** at the cluster API. Cilium CNI, Istio Ambient mesh.
- **Gateway API** with main Gateway listening on `*.home.shdr.ch` (`tofu/home/kubernetes/gateway.tf`). cert-manager + step-issuer wired in for TLS. Colony writes HTTPRoutes that attach to this Gateway.
- **`aether-k8s` GitLab Agent** (`tofu/home/kubernetes/gitlab_agent.tf`, KAS at `wss://gitlab.home.shdr.ch/-/kubernetes-agent/`). The agent's `ci_access.groups` already authorizes the entire `so` group (`.gitlab/agents/aether-k8s/config.yaml`), so Colony's CI can use the k8s-proxy with no Aether change.
- **`gitlab-runner-k8s` pool** in the `gitlab-runner` namespace, tagged `buildah`, accepts untagged jobs (`tofu/home/kubernetes/gitlab_runner.tf`). Colony's image-build jobs target it with `tags: [buildah]`; everything else picks it up untagged.
- **OpenBao** at `https://bao.home.shdr.ch` (`tofu/home/openbao_*.tf`). Mount `kv` is KV-v2; cluster-wide.
- **Container registry** at `registry.gitlab.home.shdr.ch`. Each project gets its own namespace; Colony pushes to `$CI_REGISTRY_IMAGE/<app>:<sha>`.
- **Crossplane** cluster-wide install (not used by Colony in MVP, but available later for object storage / Cloudflare resources).
- **Reloader** cluster-wide install. Colony Deployments can opt in via `reloader.stakater.com/auto: "true"` to roll on Secret changes.

## Ownership boundary

| Concern                                                                                          | Colony (this repo)                                                       | Aether (`~/projects/aether`)                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| App container images (api, worker, webhook-dispatcher, tool-gateway, web)                        | Builds + pushes to GitLab project registry                               | Provides rootless-Buildah runner pool                                     |
| Tofu module deploying Colony to the cluster                                                      | Authors `tofu/`, runs `validate`/`plan`/`apply` from Colony's CI         | n/a                                                                       |
| Tofu state                                                                                       | GitLab-managed (`backend "http"` against this project's state path)      | n/a                                                                       |
| Kubernetes resources (Deployments, Services, ServiceAccounts, NetworkPolicies, HTTPRoutes, etc.) | Written via `kubernetes_*` / `kubectl_manifest` Tofu providers           | n/a                                                                       |
| Postgres + Temporal                                                                              | Installed inside Colony's namespaces (CNPG `Cluster` CR, Temporal Helm)  | n/a (host doesn't run them as platform services)                          |
| Namespaces (`colony`, `colony-dev`, `colony-sandboxes`)                                          | Created by Colony's Tofu (`kubernetes_namespace_v1`)                     | n/a                                                                       |
| HTTPRoutes for `*.home.shdr.ch`                                                                  | Authors HTTPRoutes (attach to existing main Gateway)                     | Owns the main Gateway + listener + TLS                                    |
| Secret values                                                                                    | Tofu reads OpenBao at apply time, writes `kubernetes_secret_v1` directly | Hosts OpenBao + the `jwt-gitlab-colony` mount + `colony-ci` role + policy |
| GitLab Kubernetes Agent (`aether-k8s` context)                                                   | Consumer (CI extends `.kube-auth-aether`)                                | Owns Agent registration + `ci_access` (already permits `so/*`)            |
| Cluster-scoped CRDs (agent-sandbox controller, ESO if/when added)                                | Documents what's needed                                                  | Owns cluster-wide installs via Aether MR                                  |
| GitLab project itself (`so/colony`)                                                              | Lives in it                                                              | Stands up GitLab cluster-wide                                             |

A change that crosses the boundary needs an MR in **both** repos. A change strictly inside one column does not.

## What Colony publishes today

Even before COL-1.9 lands the Tofu module, the following artifacts already exist:

- Per-app `Dockerfile` at `apps/<app>/Dockerfile` (built via Buildah on Aether's runner; see [`docs/ci.md`](./ci.md)).
- Container image tags `$CI_REGISTRY_IMAGE/<app>:$CI_COMMIT_SHA` for `api`, `worker`, `webhook-dispatcher`, `tool-gateway`, `web`. `:latest` is also pushed on `main` but **must not** be referenced from Tofu values; pin SHAs.
- ADRs constraining platform expectations (ADR-004 local dev, ADR-006 CI, ADR-007 deployment boundaries).
- The provider bootstrap operation (lands in COL-1.1a) so the first GitLab project, bot users, OAuth Application, and webhook are created idempotently from a single admin PAT.

## Secret shape

Colony's Tofu reads OpenBao paths via `data "vault_kv_secret_v2"` and writes needed values directly into `kubernetes_secret_v1` resources in Colony's namespaces. (No ESO on host; we read at apply time.) The first `colony-dev` preview keeps Aether changes near zero by reusing the existing Dokku Temporal deployment through `grpc.temporal.home.shdr.ch:443` and running a small in-namespace Postgres StatefulSet instead of requiring host-cluster CNPG.

| OpenBao path          | Keys                                                                                                                 | Consumed by                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Tofu-generated        | Preview Postgres username/password and `DATABASE_URL`                                                                | api, worker, webhook-dispatcher                   |
| `kv/colony/gitlab`    | `GITLAB_BASE_URL`, `GITLAB_TOKEN` (engine alias), `GITLAB_BOT_*_TOKEN`, `GITLAB_WEBHOOK_SECRET`, `GITLAB_PROJECT_ID` | api, webhook-dispatcher, worker (provider writes) |
| `kv/colony/oauth`     | `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` (the GitLab Application from COL-1.1a)                                      | web                                               |
| Tofu variables        | `TEMPORAL_ADDRESS=grpc.temporal.home.shdr.ch:443`, `TEMPORAL_TLS=true`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`  | worker, webhook-dispatcher                        |
| (request-scoped only) | `GITLAB_ADMIN_PAT` — never persisted; supplied by an operator at bootstrap                                           | api `/admin/provider/bootstrap`                   |

Anything else Colony adds (LLM provider keys, internal signing keys) follows the same `kv/colony/...` pattern and is appended here.

## Open Aether-side follow-ups

Each is a small Aether MR. Track them here until they merge.

1. **OpenBao GitLab-CI JWT auth for Colony.** Add (modeled on `tofu/home/openbao_seven30.tf`):
   - `vault_jwt_auth_backend "gitlab_colony"` at path `jwt-gitlab-colony`, OIDC discovery against `https://gitlab.home.shdr.ch`.
   - `vault_jwt_auth_backend_role "colony_ci"`: `bound_audiences = ["https://bao.home.shdr.ch"]`, `bound_claims = { project_path = "so/colony" }`, `token_policies = ["colony-ci"]`.
   - `vault_policy "colony_ci"` granting `read` on `kv/data/colony/*` and `list` on `kv/metadata/colony/*`.
   - Optional: a separate read-only `colony-ci-readonly` role for plan-only jobs if we ever split apply credentials.
2. **Initial OpenBao `kv/colony/*` paths** populated with placeholders, so Colony's first apply can read them. Owner: a human, once the GitLab project, bot users, and OAuth Application exist (after COL-1.1a runs).
3. **(Future)** **CloudNativePG on the host cluster**, if Colony outgrows the preview StatefulSet database and wants operator-managed Postgres in `colony-dev`.
4. **(Phase 2)** **agent-sandbox controller install** cluster-wide, with the CRD versions Colony's `SandboxTemplate` resources target. Document the install in Aether's `tofu/home/kubernetes/`. Track when COL-2.1 / COL-2.3 land.
5. **(Optional, future)** **External Secrets Operator** cluster-wide. Switching Colony's secret pattern from Tofu-vault-read to `ExternalSecret` is a one-MR follow-up once Aether installs ESO; the OpenBao paths don't change.

This list is the source of truth until COL-1.9 lands; once the Tofu module exists, each item moves to a closed status here.
