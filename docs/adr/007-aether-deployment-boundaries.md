# ADR-007: Aether deployment ownership boundaries

**Status:** Accepted
**Date:** 2026-04-24

## Context

Colony deploys to `~/projects/aether`, the private-cloud infrastructure repo. Aether is Tofu-driven and owns a Talos Kubernetes cluster, Cilium, Istio Ambient, Gateway API, cert-manager + step-ca, GitLab, OpenBao/SOPS, Postgres (CNPG), Grafana/Loki/Tempo/Prometheus, and the kubernetes-sigs agent-sandbox controller (ADR-007 builds on `design.md` §19 and `tasks.md` COL-0.3b, COL-1.9).

Without clear ownership, it's easy to:
- Install the same thing twice (e.g. cert-manager inside the Colony chart and in Aether).
- Block on Aether for routine Colony changes that should not require an Aether MR.
- Leak ops state (Talos quirks, Cilium policies) into Colony and vice versa.

## Decision

### What Colony owns (in this repo)

- **Helm chart** at `charts/colony/` covering Colony's own services: Webhook Dispatcher, Supervisor Workers, Task Graph API / Web UI API, Tool Gateway, Memory Consolidator, and the SvelteKit web app.
- **Per-role `SandboxTemplate` custom resources** (architect, developer, reviewer, integrator) that the agent-sandbox controller consumes.
- **ServiceAccounts, Roles/RoleBindings, and NetworkPolicies** scoped to Colony's namespaces.
- **HTTPRoute resources** for Colony's hostnames (`colony.apps.home.shdr.ch`, `colony-dev.apps.home.shdr.ch`, etc.), referencing the Aether-owned main Gateway.
- **Application-level configuration:** feature flags, policy defaults, packet/envelope schema versions, bot-account mapping, Tool Gateway allowlists.
- **Container images** for each app, pushed to the GitLab container registry by Colony CI.
- **Chart versioning** via semver; chart published to the GitLab OCI registry.
- **Secret shape** (keys and purposes), consumed via ExternalSecret resources that reference OpenBao.

### What Aether owns (in `~/projects/aether`)

- **The cluster itself** — Talos nodes, control plane, upgrades.
- **Platform services:** Cilium, Istio Ambient, Gateway API main Gateway, cert-manager + step-issuer + istio-csr, CNPG operator, Grafana stack, ExternalSecrets Operator, OpenBao.
- **The kubernetes-sigs agent-sandbox controller** and its CRDs (`SandboxTemplate`, `SandboxClaim`, `SandboxWarmPool` definitions). Colony supplies the CRs; Aether owns the controller that reconciles them.
- **Temporal cluster.** Deployed via the Temporal Helm chart (or equivalent) as an Aether-level service. Colony connects to its gRPC endpoint; Colony does not install Temporal.
- **Postgres.** Aether runs CNPG; Colony uses dedicated databases + roles (`temporal`, `temporal_visibility`, `colony`) provisioned via Aether-side Tofu.
- **The Tofu `helm_release.colony`** in `~/projects/aether/tofu/home/kubernetes/colony.tf`. Aether renders values with `yamlencode({ ... })`, pulls secrets via `var.secrets["..."]`, and applies.
- **DNS, TLS, ingress exposure.** Gateway listeners and certificates are created in Aether; Colony only writes HTTPRoutes that attach to the existing Gateway.
- **Observability wiring.** OTel collector endpoints, log shipping, metric scraping rules — Aether-owned. Colony apps emit per Aether's conventions.
- **Namespaces:** `colony-system`, `colony-sandboxes`, `colony-dev` created by Aether Tofu (not by the chart).
- **RBAC at the cluster level** (cluster-scoped Roles/ClusterRoleBindings that the chart needs) — Aether applies them via Tofu so chart installs do not require cluster-admin.

### Handoff contract

- Colony publishes: chart version, image SHAs, required secret keys, required namespace-level RBAC, `SandboxTemplate` CR shapes, Tool Gateway allowlist seeds.
- Aether consumes: chart version in `colony.tf`, wires secrets from OpenBao, attaches HTTPRoutes to the main Gateway, and runs the Tofu apply.
- A change that touches the contract (new secret key, new cluster-scoped permission, new upstream dependency) requires an Aether MR in addition to the Colony MR. A change strictly within Colony's surface does not.

## Alternatives Considered

- **Colony chart installs its own Temporal, Postgres, cert-manager, etc.** Rejected — duplicates Aether's platform services and creates upgrade conflicts.
- **Aether owns everything, Colony ships only images.** Gives Aether too much Colony-specific knowledge and slows every Colony change to an Aether MR.
- **Umbrella chart with subcharts for platform services.** Blurs the boundary; we'd either pin platform versions that conflict with Aether, or disable subcharts everywhere and pay the template cost for nothing.
- **Direct `kubectl apply` from Colony CI.** Gives Colony CI cluster-write credentials, which defeats the GitOps-ish property of Tofu as the apply authority.

## Rationale

- Platform services are slow-changing, cross-cutting, and already run on Aether. Colony should not reinstall them.
- Colony's services are fast-iterating and need a short MR-to-deploy path. Keeping them chart-side lets any Colony MR ship via chart bump.
- Tofu-driven applies keep credentials and audit in one place.
- A clear handoff contract reduces "who owns this" churn across repos.

## Consequences

- Colony's chart README documents its platform prerequisites explicitly (Temporal, Postgres, cert-manager with a StepIssuer, Gateway API with a main Gateway, agent-sandbox controller, ExternalSecrets Operator, OpenBao).
- Tofu wiring in `aether/tofu/home/kubernetes/colony.tf` follows the existing per-app pattern (`headlamp.tf`, `cert_manager.tf`): `helm_release` + `kubernetes_manifest` for HTTPRoutes + ExternalSecret refs.
- `colony-dev` namespace (ADR-007 first target, then prod in `colony-system` + `colony-sandboxes`) is created by Aether Tofu, not by the chart.
- The chart does not install any cluster-scoped CRDs or ClusterRoles it does not strictly own. Anything cluster-scoped is in Aether.
- A `docs/aether-handoff.md` in this repo (or the Aether repo) lists the current contract: secret keys, required RBAC, HTTPRoute hostnames, chart version pin.

## Revisit When

- Colony needs a platform service Aether does not yet provide (e.g. a vector DB for memory search in Phase 4).
- Aether adopts Argo CD / Flux and Tofu stops being the apply authority.
- The chart outgrows what a single chart can express cleanly — split into per-app charts under an umbrella, or adopt Helmfile/Helmsman.
