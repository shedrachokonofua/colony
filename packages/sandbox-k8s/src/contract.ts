import type { SandboxLaunchProfile } from "@colony/sandbox";
import type { Readable, Writable } from "node:stream";

/**
 * Types, constants, pure builders and the client seam for the Kubernetes
 * sandbox engine. This module must stay dependency-free of the Kubernetes
 * client library so it can be imported from unit tests and pure builders
 * without a cluster or the `@kubernetes/client-node` package installed.
 */

export const DEFAULT_KUBERNETES_NAMESPACE = "colony-sandboxes";

export const DEFAULT_SANDBOX_IMAGE =
  "registry.gitlab.home.shdr.ch/so/colony/sandbox:latest";

export const SANDBOX_GROUP = "agents.x-k8s.io";
export const SANDBOX_PLURAL = "sandboxes";
export const SANDBOX_CONTAINER_NAME = "sandbox";
export const POD_WORKSPACE_DIR = "/workspace";
export const SANDBOX_ID_LABEL = "colony.shdr.ch/sandbox-id";

/**
 * Agent-sandbox controller v0.4.x CRD field path.
 *
 * The controller's `Sandbox` custom resource nests a full Pod spec under
 * `spec.podTemplate` (verified against the published v0.4 schema). This is the
 * exact object path the engine builds and that the controller unwraps to
 * create the backing pod. If the controller ships a `spec.podTemplate` shape
 * this differs from, adjust here and in the invariants test together.
 */
export const SANDBOX_SPEC_POD_TEMPLATE_PATH = "spec.podTemplate";

export interface SandboxContainerSecurityContext {
  readonly runAsUser: number;
  readonly runAsNonRoot: boolean;
  readonly allowPrivilegeEscalation: boolean;
  /** PodSecurity 'restricted' policies demand dropping all capabilities. */
  readonly capabilities: { readonly drop: readonly ["ALL"] };
  /** PodSecurity 'restricted' policies demand a seccomp profile. */
  readonly seccompProfile: { readonly type: "RuntimeDefault" };
}

export interface SandboxCustomResourceContainer {
  readonly name: typeof SANDBOX_CONTAINER_NAME;
  readonly image: string;
  readonly command: readonly ["sleep", "infinity"];
  readonly workingDir: typeof POD_WORKSPACE_DIR;
  readonly securityContext: SandboxContainerSecurityContext;
  readonly resources: {
    readonly requests: {
      readonly cpu: string;
      readonly memory: string;
    };
    readonly limits: {
      readonly cpu: string;
      readonly memory: string;
      readonly "ephemeral-storage": string;
    };
  };
  /** Intentionally empty: no baked data/env. Data env is injected per-exec. */
  readonly env: [] | undefined;
}

/** Structural shape mirrored from the agent-sandbox v0.4.x Sandbox CRD. */
export interface SandboxCustomResource {
  readonly apiVersion: string;
  readonly kind: "Sandbox";
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels: Record<string, string>;
  };
  readonly spec: {
    readonly podTemplate: {
      readonly metadata: {
        readonly labels: Record<string, string>;
      };
      readonly spec: {
        readonly runtimeClassName: "kata";
        readonly automountServiceAccountToken: false;
        readonly containers: readonly [SandboxCustomResourceContainer];
      };
    };
  };
}

/**
 * Fail-closed RBAC error raised when the cluster rejects creating a Sandbox CR
 * with HTTP 403. `statusCode` carries the HTTP status so callers can branch on
 * it without importing the Kubernetes client library.
 */
export class SandboxRbacError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 403) {
    super(message);
    this.name = "SandboxRbacError";
    this.statusCode = statusCode;
  }
}

/**
 * Internal adapter seam implemented by both the real Kubernetes client and the
 * faked client used in unit tests. This is intentionally transport-agnostic so
 * the engine never touches `@kubernetes/client-node` directly.
 */
export interface KubernetesSandboxClient {
  discoverGroupVersions(): Promise<
    readonly {
      name: string;
      versions: readonly { version: string }[];
      preferredVersion?: { version: string };
    }[]
  >;
  createSandbox(
    namespace: string,
    body: SandboxCustomResource,
  ): Promise<unknown>;
  listSandboxes(
    namespace: string,
    labelSelector: string,
  ): Promise<readonly string[]>;
  getSandbox(
    namespace: string,
    name: string,
  ): Promise<{ ready: boolean; failed?: string }>;
  /** Resolves on 404; the controller reaps the backing pod on CR deletion. */
  deleteSandbox(namespace: string, name: string): Promise<void>;
  listPods(
    namespace: string,
    labelSelector: string,
  ): Promise<
    readonly { name: string; phase: string; containerReady: boolean }[]
  >;
  /**
   * Runs a command inside the sandbox container over the pods/exec WebSocket.
   * stdout/stderr of the pod process are streamed into the given writables;
   * `stdin` (when provided) is piped into the pod process's stdin. The
   * `statusCallback` receives the exec session's terminal status (exit code).
   * The returned connection exposes both cancellation and remote closure.
   */
  execPod(
    namespace: string,
    podName: string,
    command: readonly string[],
    stdout: Writable,
    stderr: Writable,
    stdin: Readable | null,
    statusCallback: (status: ExecPodStatus) => void,
  ): Promise<ExecPodConnection>;
}

/**
 * Minimal structural shape of the pods/exec terminal status (a `V1Status`
 * subset) so the seam stays free of `@kubernetes/client-node` types.
 *
 * Real kubelet sends:
 * ```json
 * {
 *   "status": "Failure",
 *   "message": "command terminated with exit code 1",
 *   "reason": "NonZeroExitCode",
 *   "details": { "causes": [{ "reason": "ExitCode", "message": "1" }] }
 * }
 * ```
 */
export interface ExecPodStatus {
  readonly status?: string;
  readonly message?: string;
  readonly details?: {
    readonly causes?: readonly {
      readonly reason?: string;
      readonly message?: string;
    }[];
  };
}

/**
 * Minimal structural shape of a pods/exec WebSocket. `closed` settles for
 * both local and remote closure so completed commands cannot strand callers
 * when the Kubernetes client leaves stdout/stderr streams open.
 */
export interface ExecPodConnection {
  readonly closed: Promise<void>;
  close(code?: number, data?: string): void;
}

export interface KubernetesSandboxEngineOptions {
  readonly namespace?: string;
  readonly image?: string;
  readonly apiVersionOverride?: string;
  readonly kubeconfig?: import("@kubernetes/client-node").KubeConfig;
  readonly client?: KubernetesSandboxClient;
  readonly provisionTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface BuildSandboxCustomResourceInput {
  readonly profile: SandboxLaunchProfile;
  readonly name: string;
  readonly namespace: string;
  readonly image: string;
  readonly apiVersion: string;
}

/**
 * Builds a `Sandbox` custom resource for the agent-sandbox controller. Pure
 * and deterministic so the invariants can be asserted by a unit test.
 *
 * When roles were "in-process", sandboxes ran under a gVisor runtimeClass. On
 * Kubernetes the sandbox is a real VM-backed pod under the kata container
 * runtime, so the runtimeClass is ALWAYS `"kata"` — deliberately NOT
 * `profile.runtimeClass` (which stays `"gvisor"` for the in-process posture).
 */
export function buildSandboxCustomResource({
  profile,
  name,
  namespace,
  image,
  apiVersion,
}: BuildSandboxCustomResourceInput): SandboxCustomResource {
  const labels = {
    ...profile.podLabels,
    [SANDBOX_ID_LABEL]: name,
  };

  const container: SandboxCustomResourceContainer = {
    name: SANDBOX_CONTAINER_NAME,
    image,
    command: ["sleep", "infinity"],
    workingDir: POD_WORKSPACE_DIR,
    securityContext: {
      runAsUser: 1000,
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      // The colony-sandboxes namespace enforces PodSecurity 'restricted:latest';
      // the controller propagates these to the backing pod so its creation is
      // not rejected for missing capability drops or a seccomp profile.
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    },
    resources: {
      // Requests deliberately below limits: quota is priced on requests, and
      // sandboxes idle near zero while their agent waits on the model.
      requests: {
        cpu: profile.resourceRequests.cpu,
        memory: profile.resourceRequests.memory,
      },
      limits: {
        cpu: profile.resourceLimits.cpu,
        memory: profile.resourceLimits.memory,
        "ephemeral-storage": profile.resourceLimits.ephemeralStorage,
      },
    },
    // No provider credentials and no baked data env here. Data env is injected
    // per-exec by the exec-channel task; keeping this empty is the invariants
    // test's key assertion.
    env: [],
  };

  return {
    apiVersion,
    kind: "Sandbox",
    metadata: {
      name,
      namespace,
      labels,
    },
    spec: {
      podTemplate: {
        // Mirror the CR labels (including SANDBOX_ID_LABEL) onto the pod
        // template so the controller propagates them to the backing pod.
        metadata: { labels },
        spec: {
          runtimeClassName: "kata",
          automountServiceAccountToken: false,
          containers: [container],
        },
      },
    },
  };
}

/**
 * Picks the served API version for {@link SANDBOX_GROUP}. Returns the group's
 * `preferredVersion` when advertised; otherwise ranks `v1` first, then
 * `v1beta<N>` descending by N, then `v1alpha<N>` descending. Throws if the
 * group is not served (controller not installed). An `override` bypasses
 * discovery entirely.
 */
export function resolveSandboxApiVersion(
  groups: readonly {
    name: string;
    versions: readonly { version: string }[];
    preferredVersion?: { version: string };
  }[],
  override?: string,
): string {
  if (override !== undefined) {
    return `${SANDBOX_GROUP}/${override}`;
  }

  const group = groups.find((g) => g.name === SANDBOX_GROUP);
  if (group === undefined) {
    throw new Error(
      "colonyd cannot find served version for group agents.x-k8s.io — is the agent-sandbox controller installed?",
    );
  }

  const preferred = group.preferredVersion?.version;
  if (preferred !== undefined) {
    return `${SANDBOX_GROUP}/${preferred}`;
  }

  const versions = group.versions.map((v) => v.version);
  if (versions.length === 0) {
    throw new Error(
      "colonyd cannot find served version for group agents.x-k8s.io — is the agent-sandbox controller installed?",
    );
  }

  const sorted = [...versions].sort((a, b) => {
    const [ra, rb] = [versionRank(a), versionRank(b)];
    if (ra[0] !== rb[0]) return ra[0] - rb[0];
    return ra[1] - rb[1];
  });

  return `${SANDBOX_GROUP}/${sorted[0]}`;
}

type VersionRank = [tier: number, betaOrAlpha: number];

function versionRank(version: string): VersionRank {
  if (version === "v1") return [0, 0];
  const beta = /^v1beta(\d+)$/.exec(version);
  if (beta !== null) return [1, -Number(beta[1])];
  const alpha = /^v1alpha(\d+)$/.exec(version);
  if (alpha !== null) return [2, -Number(alpha[1])];
  return [3, 0];
}
