# @colony/sandbox-k8s

A `SandboxEngine` implementation that provisions each sandbox as a
[`Sandbox`](/packages/sandbox-k8s/src/contract.ts) custom resource handled by the
**agent-sandbox v0.4.x controller**, which in turn creates a kata-runtime VM-backed
pod for the run. Exec runs over the Kubernetes `pods/exec` WebSocket, file
reads/writes move bytes via exec+base64, and the runner's local workspace is
streamed into the pod (tar over exec stdin) before the handle is returned.

## Operator runbook

### Prerequisites in the cluster

- **agent-sandbox v0.4.x controller** installed, serving the `Sandbox` CRD in
  the `agents.x-k8s.io` api group. The engine discovers the served apiVersion
  dynamically (or honors `apiVersionOverride`).
- **A `kata` RuntimeClass** — the controller creates backing pods under
  `runtimeClassName: "kata"` so each sandbox is a real VM, not a shared-kernel
  container.
- **The `colony-sandboxes` namespace** (the default namespace, overridable via
  `namespace`) and its **NetworkPolicy** keying on the
  `colony.shdr.ch/sandbox-role` pod label so sandbox pods only reach what the
  policy permits.
- **colonyd RBAC** granting the Sandbox CR verbs (`get`, `list`, `create`,
  `delete`) on `sandboxes` in that namespace (and the engine's
  `SandboxRbacError` is thrown if a create is denied with HTTP 403).

### Running the conformance suite

The integration suite (`src/kubernetes-conformance.integration.test.ts`) is
gated behind an env var so CI stays green without a cluster. To run it against a
live cluster:

```sh
export KUBECONFIG=/path/to/cluster/kubeconfig
export COLONY_K8S_ENGINE_TESTS=1
export COLONY_K8S_SANDBOX_NAMESPACE=colony-sandboxes        # optional override
export COLONY_K8S_SANDBOX_IMAGE=registry/sandbox:latest      # optional override
export COLONY_K8S_SANDBOX_API_VERSION=v1beta1               # optional override

npx vitest run packages/sandbox-k8s
```

The suite is skipped (reported green) when `COLONY_K8S_ENGINE_TESTS` is unset,
and CI's `npm run test:unit` excludes `*.integration.test.ts` files entirely.

## Env contract

Exec injects **only** the launch-profile `envAllowlist` data env into the pod
shell, and only for keys present in `process.env` or the request's `env`
overrides. Non-allowlisted keys are silently dropped. `PATH`, `HOME`, and
`TMPDIR` are **never** set by the engine — they are the pod's own substrate, so
behavior is identical to the in-process engine where PATH comes from the host.

## Warm-pool note

Pre-warmed capacity exists via `sandboxwarmpools.extensions.agents.x-k8s.io` and
`SandboxClaim` resources, but this engine **intentionally does not claim from a
warm pool** — it creates a bare `Sandbox` CR per provision. Claiming from a warm
pool is out of scope for this iteration and is future work.
