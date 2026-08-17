import { randomUUID } from "node:crypto";
import type {
  ExecEvent,
  ExecRequest,
  ExecResult,
  SandboxEngine,
  SandboxHandle,
  SandboxLaunchProfile,
} from "@colony/sandbox";
import {
  DEFAULT_KUBERNETES_NAMESPACE,
  DEFAULT_SANDBOX_IMAGE,
  SANDBOX_GROUP,
  SANDBOX_ID_LABEL,
  SANDBOX_PLURAL,
  SandboxRbacError,
  buildSandboxCustomResource,
  resolveSandboxApiVersion,
  type KubernetesSandboxClient,
  type KubernetesSandboxEngineOptions,
  type SandboxCustomResource,
} from "./contract.js";
import { createKubernetesClient } from "./k8s-client.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isForbidden(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === 403
  );
}

function buildRbacMessage(namespace: string): string {
  return (
    `RBAC: denied creating ${SANDBOX_PLURAL} in namespace ${namespace} ` +
    `(api group ${SANDBOX_GROUP}, plural ${SANDBOX_PLURAL}). ` +
    `Grant apiGroups: [agents.x-k8s.io, extensions.agents.x-k8s.io] ` +
    `resources sandboxes, sandboxtemplates/sandboxclaims ` +
    `verbs get, list, create, delete to colonyd's service account in ` +
    `${namespace}, then retry.`
  );
}

/**
 * Live handle into a Kubernetes-backed sandbox. `exec`/`readFile`/`writeFile`
 * are stubs until the dependent exec-channel task lands; `destroy()` deletes
 * the Sandbox CR and the controller reaps the backing pod.
 */
class K8sSandboxHandle implements SandboxHandle {
  private destroyed = false;

  constructor(
    private readonly client: KubernetesSandboxClient,
    private readonly namespace: string,
    private readonly sandboxName: string,
  ) {}

  async exec(
    _request: ExecRequest,
    _onEvent: (event: ExecEvent) => void,
  ): Promise<ExecResult> {
    if (this.destroyed) throw new Error("k8s exec after destroy");
    throw new Error("k8s exec not implemented: see exec-channel task");
  }

  async readFile(_path: string): Promise<Buffer> {
    if (this.destroyed) throw new Error("k8s readFile after destroy");
    throw new Error("k8s exec not implemented: see exec-channel task");
  }

  async writeFile(_path: string, _content: string): Promise<void> {
    if (this.destroyed) throw new Error("k8s writeFile after destroy");
    throw new Error("k8s exec not implemented: see exec-channel task");
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.client.deleteSandbox(this.namespace, this.sandboxName);
  }
}

/**
 * Lazy Kubernetes sandbox engine. Constructing it touches nothing: kubeconfig
 * loading and all cluster I/O happen only inside `provision()`. Pass a
 * `kubeconfig` or rely on `loadFromDefault()` at provision time via the real
 * client adapter, or inject a faked `client` for tests.
 */
export function createKubernetesEngine(
  options: KubernetesSandboxEngineOptions = {},
): SandboxEngine {
  return {
    async provision(
      profile: SandboxLaunchProfile,
      _workspace: string,
    ): Promise<SandboxHandle> {
      const namespace = options.namespace ?? DEFAULT_KUBERNETES_NAMESPACE;
      const image = options.image ?? DEFAULT_SANDBOX_IMAGE;
      const pollIntervalMs = options.pollIntervalMs ?? 1000;
      const provisionTimeoutMs = options.provisionTimeoutMs ?? 300_000;

      // Client construction (kubeconfig load, cluster wiring) is deferred to
      // here, satisfying the lazy factory contract. Tests inject their own.
      const client =
        options.client ?? createKubernetesClient(options.kubeconfig);

      // Discover the served apiVersion from the cluster — never hardcoded.
      let apiVersion: string;
      if (options.apiVersionOverride !== undefined) {
        apiVersion = `${SANDBOX_GROUP}/${options.apiVersionOverride}`;
      } else {
        const groups = await client.discoverGroupVersions();
        apiVersion = resolveSandboxApiVersion(groups);
      }

      const name = `colony-${randomUUID()}`;
      const cr = buildSandboxCustomResource({
        profile,
        name,
        namespace,
        image,
        apiVersion,
      });

      // NOTE (later scope, intentionally NOT implemented here): pre-warmed
      // capacity exists via `sandboxwarmpools.extensions.agents.x-k8s.io`
      // SandboxClaim resources. This engine creates bare Sandbox CRs and does
      // not claim from warm pools.
      try {
        await client.createSandbox(namespace, cr);
      } catch (err) {
        if (isForbidden(err)) {
          throw new SandboxRbacError(buildRbacMessage(namespace));
        }
        // Any other failure surfaces with its status code and message as-is —
        // fail closed, never silently swallow.
        throw err;
      }

      const deadline = Date.now() + provisionTimeoutMs;

      // Wait for the Sandbox CR to report ready.
      for (;;) {
        const state = await client.getSandbox(namespace, name);
        if (state.failed !== undefined) {
          throw new Error(
            `Sandbox CR ${name} in namespace ${namespace} failed: ${state.failed}`,
          );
        }
        if (state.ready) break;
        if (Date.now() >= deadline) {
          throw new Error(
            `timed out after ${provisionTimeoutMs}ms waiting for Sandbox CR ${name} in namespace ${namespace} to become ready`,
          );
        }
        await sleep(pollIntervalMs);
      }

      // Discover the backing pod by label and wait for it to be Running/ready.
      const labelSelector = `${SANDBOX_ID_LABEL}=${name}`;
      let podName: string | undefined;
      for (;;) {
        const pods = await client.listPods(namespace, labelSelector);
        const running = pods.find(
          (pod) => pod.phase === "Running" && pod.containerReady === true,
        );
        if (running !== undefined) {
          podName = running.name;
          break;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `timed out after ${provisionTimeoutMs}ms waiting for backing pod of Sandbox CR ${name} in namespace ${namespace} to be Running and ready`,
          );
        }
        await sleep(pollIntervalMs);
      }

      return new K8sSandboxHandle(client, namespace, name);
    },
  };
}

export { K8sSandboxHandle };

export default createKubernetesEngine;
