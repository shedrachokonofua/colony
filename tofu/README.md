# Colony Preview Deployment

This module deploys the first Colony preview into Aether's host Kubernetes
cluster, namespace `colony-dev`.

It intentionally avoids Aether repo changes for the first preview:

- Gateway API routes attach to Aether's existing `default/main-gateway`.
- Images are pulled from the Colony GitLab project registry.
- Runtime GitLab provider secrets are read from OpenBao `kv/colony/gitlab`.
- Temporal is reused from the existing Aether Dokku VM deployment at
  `grpc.temporal.home.shdr.ch:443` with Temporal SDK TLS enabled.
- Postgres is a small in-namespace StatefulSet for the preview. It can be
  replaced with CNPG later if the host cluster gets that operator.

CI passes `image_registry=$CI_REGISTRY_IMAGE` and `image_tag=$CI_COMMIT_SHA`.
Local plans can use the defaults, but real preview deploys should use a pinned
commit image tag.

```sh
cd tofu
tofu init
tofu plan -var image_tag=<commit-sha>
```

## Agent sandbox isolation (COL-2.1)

`sandboxes.tf` provisions a separate `colony-sandboxes-dev` namespace plus
NetworkPolicies for Phase 2 Developer/Reviewer runs:

- Default-deny egress and ingress for any pod with the
  `colony.shdr.ch/sandbox-role` label.
- Allowlisted egress to kube-dns (`kube-system/k8s-app=kube-dns`) and to the
  `colony-tool-gateway` Service in `colony-dev`.
- No egress to the Task Graph API (`colony-api`); agents consume packets and
  return envelopes via the Supervisor workflow.

The TypeScript launch profile in `packages/agent-runtime/src/sandbox-profile.ts`
is the source of truth for the role label, allowlists, and capabilities. The
agent runtime adapter (COL-2.3) renders it into pod specs; the NetworkPolicies
here enforce the egress posture at the cluster level regardless of how the pod
is created.

Implemented Phase 2 contracts through COL-2.8:

- Tool Gateway resolves provider bot credentials with capability/namespace
  checks, package registry allowlists, and redacted audit records.
- `@colony/agent-runtime` discovers read-only skill bundles from `SKILL.md`
  sources and records selected skill hashes/mount paths in run extensions.
- Generic CLI tool manifests declare executable, resolver, package reference,
  env allowlist, args policy label, and required capabilities without granting
  those capabilities to the actor.
- Nix-backed and fallback tool materializers produce a prepared `PATH` plus a
  profile manifest containing package refs, tool versions, and profile hash.
- Deployer runtime bindings are the source of actual environment authority:
  env vars, read-only config mounts, credential brokers, service accounts/RBAC,
  and egress are explicit run inputs and are hashed in run metadata.
- Skills and CLI tools are requests/allowlists. They do not imply credentials,
  config mounts, Kubernetes RBAC, or external network access. In the target
  SandboxTemplate/SandboxClaim binding, the resolved profile can be broad while
  the effective run `PATH` is a per-run bin directory containing only declared
  CLI tools.
- Local/dev bindings may use permissive network posture for iteration. Pilot
  and prod bindings are validated as restricted: no service-account token
  automount and no broad network egress posture.
- The agent runtime adapter contract (`startRun`, `getRunStatus`,
  `getRunOutput`, `cancelRun`) lives in `@colony/agent-runtime`, with fake and
  Pi boundary implementations outside deterministic Temporal workflow code.
- Task and review packet builders hash packet freshness, keep untrusted
  provider comments provenance-linked, and never merge provider prose into
  system instructions.

Pending follow-up:

- COL-2.9 — Supervisor starts Developer runs, injects scoped provider
  credentials through the deployer binding/Tool Gateway path, ingests completion
  envelopes, and opens MR/PRs through the Provider Adapter.
