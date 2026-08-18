import {
  ApisApi,
  CoreV1Api,
  CustomObjectsApi,
  Exec,
  KubeConfig,
  type V1APIGroupList,
} from "@kubernetes/client-node";
import {
  SANDBOX_CONTAINER_NAME,
  SANDBOX_GROUP,
  SANDBOX_PLURAL,
  type KubernetesSandboxClient,
  type SandboxCustomResource,
} from "./contract.js";

/**
 * The real Kubernetes client adapter. This is the ONLY module in the package
 * that imports `@kubernetes/client-node` — everything else (pure builders,
 * engine, unit tests) talks through the {@link KubernetesSandboxClient} seam.
 *
 * The @kubernetes/client-node v2 generated classes (`ApisApi`, `CustomObjectsApi`,
 * `CoreV1Api`) expose the "object-param" style: methods take a single request
 * object. They throw `ApiException` (`{ code, body, message }`) on non-2xx.
 */

function extractVersion(apiVersion: string): string {
  const slash = apiVersion.indexOf("/");
  if (slash === -1) {
    throw new Error(`invalid custom resource apiVersion: ${apiVersion}`);
  }
  return apiVersion.slice(slash + 1);
}

/** Maps a V1APIGroupList to the seam's structural shape. */
function mapGroupList(list: V1APIGroupList): {
  name: string;
  versions: { version: string }[];
  preferredVersion?: { version: string };
}[] {
  return (list.groups ?? []).map((group) => ({
    name: group.name,
    versions: (group.versions ?? []).map((v) => ({ version: v.version })),
    ...(group.preferredVersion !== undefined
      ? { preferredVersion: { version: group.preferredVersion.version } }
      : {}),
  }));
}

function isHttpError(err: unknown, code: number): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === code
  );
}

/**
 * Reads the Sandbox CR status into the seam's `{ready, failed}` shape based on
 * the agent-sandbox controller v0.4.x CRD status conditions. Mirrors the
 * documented `status.ready` flag, falling back to conditions when present.
 */
function mapSandboxStatus(body: unknown): { ready: boolean; failed?: string } {
  const status = (body as { status?: Record<string, unknown> })?.status ?? {};

  // An explicit status.failed field is a terminal condition regardless of how
  // ready is reported, either as a boolean or via conditions.
  if (typeof status.failed === "string") {
    return { ready: false, failed: status.failed };
  }

  if (typeof status.ready === "boolean") {
    return { ready: status.ready };
  }

  const conditions = asConditionArray(status.conditions);

  // Only genuinely terminal condition types signal failure: a Failed/Error
  // condition. Ready=False alone is a normal transient state during pod
  // scheduling/startup, so it must be polled through the loop rather than
  // treated as a terminal failure.
  const failedCondition = conditions.find(
    (c) =>
      (c.type === "Failed" || c.type === "Error") &&
      (c.status === "True" || c.reason !== undefined),
  );
  if (failedCondition !== undefined) {
    return {
      ready: false,
      failed:
        failedCondition.reason !== undefined
          ? String(failedCondition.reason)
          : String(failedCondition.type),
    };
  }

  const readyCondition = conditions.find((c) => c.type === "Ready");
  return { ready: readyCondition?.status === "True" };
}

function asConditionArray(value: unknown): {
  type?: string;
  status?: string;
  reason?: string;
}[] {
  if (!Array.isArray(value)) return [];
  return value as { type?: string; status?: string; reason?: string }[];
}
type KubernetesEnvironment = Readonly<
  Partial<Record<"KUBERNETES_SERVICE_HOST" | "KUBERNETES_SERVICE_PORT", string>>
>;

/**
 * Prefer the mounted service-account configuration inside Kubernetes.
 * `loadFromDefault()` otherwise falls back to http://localhost:8080 when a pod
 * has no user kubeconfig, which turns every cluster request into a local call.
 */
export function loadKubernetesConfig(
  kubeconfig = new KubeConfig(),
  environment: KubernetesEnvironment = process.env,
): KubeConfig {
  if (
    environment.KUBERNETES_SERVICE_HOST &&
    environment.KUBERNETES_SERVICE_PORT
  ) {
    kubeconfig.loadFromCluster();
  } else {
    kubeconfig.loadFromDefault();
  }
  return kubeconfig;
}

/** Builds a client over `@kubernetes/client-node` for the given KubeConfig. */
export function createKubernetesClient(
  kubeconfig?: KubeConfig,
): KubernetesSandboxClient {
  const kc = kubeconfig ?? loadKubernetesConfig();
  const apis = kc.makeApiClient(ApisApi);
  const custom = kc.makeApiClient(CustomObjectsApi);
  const core = kc.makeApiClient(CoreV1Api);

  // The resolved apiVersion is discovered lazily on the first create and
  // reused for subsequent reads/deletes against the same provisioned sandbox.
  let resolvedVersion: string | undefined;

  async function currentVersion(): Promise<string> {
    if (resolvedVersion !== undefined) return resolvedVersion;
    const list = await apis.getAPIVersions();
    const group = mapGroupList(list).find((g) => g.name === SANDBOX_GROUP);
    if (group === undefined || group.versions.length === 0) {
      throw new Error(
        "colonyd cannot find served version for group agents.x-k8s.io — is the agent-sandbox controller installed?",
      );
    }
    resolvedVersion =
      group.preferredVersion?.version ?? group.versions[0]!.version;
    return resolvedVersion;
  }

  return {
    async discoverGroupVersions() {
      return mapGroupList(await apis.getAPIVersions());
    },

    async createSandbox(namespace: string, body: SandboxCustomResource) {
      resolvedVersion = extractVersion(body.apiVersion);
      return custom.createNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: resolvedVersion,
        namespace,
        plural: SANDBOX_PLURAL,
        body,
      });
    },

    async getSandbox(namespace: string, name: string) {
      const body = await custom.getNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: await currentVersion(),
        namespace,
        plural: SANDBOX_PLURAL,
        name,
      });
      return mapSandboxStatus(body);
    },

    async deleteSandbox(namespace: string, name: string) {
      try {
        await custom.deleteNamespacedCustomObject({
          group: SANDBOX_GROUP,
          version: await currentVersion(),
          namespace,
          plural: SANDBOX_PLURAL,
          name,
        });
      } catch (err) {
        // 404 means the CR is already gone (controller reaped it) — resolve so
        // destroy() is idempotent.
        if (isHttpError(err, 404)) return;
        throw err;
      }
    },

    async listPods(namespace: string, labelSelector: string) {
      const podList = await core.listNamespacedPod({
        namespace,
        labelSelector,
      });
      return (podList.items ?? []).map((pod) => {
        const ready =
          pod.status?.containerStatuses?.some((s) => s.ready === true) === true;
        return {
          name: pod.metadata?.name ?? "",
          phase: pod.status?.phase ?? "",
          containerReady: ready,
        };
      });
    },

    async execPod(
      namespace: string,
      podName: string,
      command: readonly string[],
      stdout: import("node:stream").Writable,
      stderr: import("node:stream").Writable,
      stdin: import("node:stream").Readable | null,
      statusCallback: (status: import("./contract.js").ExecPodStatus) => void,
    ) {
      // The WebSocket's remote close is the only reliable completion signal
      // for fast commands: client-node does not consistently end the supplied
      // stdout/stderr streams after kubelet sends terminal status.
      const socket = await new Exec(kc).exec(
        namespace,
        podName,
        SANDBOX_CONTAINER_NAME,
        [...command],
        stdout,
        stderr,
        stdin,
        false /* tty */,
        statusCallback,
      );
      const closed = new Promise<void>((resolve) => {
        if (socket.readyState === 3) {
          resolve();
          return;
        }
        socket.once("close", () => resolve());
      });
      return {
        closed,
        close(code?: number, data?: string): void {
          socket.close(code, data);
        },
      };
    },
  };
}
