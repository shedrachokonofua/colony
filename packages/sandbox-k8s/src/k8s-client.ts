import {
  ApisApi,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  type V1APIGroupList,
} from "@kubernetes/client-node";
import {
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
  if (typeof status.ready === "boolean") {
    return { ready: status.ready, failed: asOptionalString(status.failed) };
  }
  const conditions = asConditionArray(status.conditions);
  const readyCondition = conditions.find((c) => c.type === "Ready");
  if (readyCondition !== undefined) {
    if (readyCondition.status === "True") {
      return { ready: true };
    }
    const reason = readyCondition.reason;
    if (reason !== undefined) {
      return { ready: false, failed: String(reason) };
    }
  }
  return { ready: false };
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asConditionArray(value: unknown): {
  type?: string;
  status?: string;
  reason?: string;
}[] {
  if (!Array.isArray(value)) return [];
  return value as { type?: string; status?: string; reason?: string }[];
}

/** Builds a client over `@kubernetes/client-node` for the given KubeConfig. */
export function createKubernetesClient(
  kubeconfig?: KubeConfig,
): KubernetesSandboxClient {
  const kc = kubeconfig ?? new KubeConfig();
  if (kubeconfig === undefined) {
    // Loaded lazily here — inside provision() — never at factory time.
    kc.loadFromDefault();
  }
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
  };
}
