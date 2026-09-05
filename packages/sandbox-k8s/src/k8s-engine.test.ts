import { beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KubeConfig } from "@kubernetes/client-node";
import {
  SANDBOX_PART_OF_LABEL,
  SANDBOX_QUOTA_EXHAUSTED,
  SANDBOX_ROLE_LABEL,
  buildSandboxLaunchProfile,
} from "@colony/sandbox";
import {
  DEFAULT_KUBERNETES_NAMESPACE,
  DEFAULT_SANDBOX_IMAGE,
  POD_WORKSPACE_DIR,
  SANDBOX_GROUP,
  SANDBOX_ID_LABEL,
  SandboxQuotaError,
  SandboxRbacError,
  buildSandboxCustomResource,
  resolveSandboxApiVersion,
  type ExecPodStatus,
  type KubernetesSandboxClient,
  type SandboxCustomResource,
} from "./contract.js";
import {
  createKubernetesEngine,
  resetStartupCleanupForTests,
} from "./k8s-engine.js";
import { loadKubernetesConfig } from "./k8s-client.js";

describe("loadKubernetesConfig", () => {
  function fakeKubeConfig(): {
    kubeconfig: KubeConfig;
    loads: string[];
  } {
    const loads: string[] = [];
    return {
      kubeconfig: {
        loadFromCluster: () => loads.push("cluster"),
        loadFromDefault: () => loads.push("default"),
      } as unknown as KubeConfig,
      loads,
    };
  }

  it("uses the mounted service account inside a Kubernetes pod", () => {
    const { kubeconfig, loads } = fakeKubeConfig();
    expect(
      loadKubernetesConfig(kubeconfig, {
        KUBERNETES_SERVICE_HOST: "10.96.0.1",
        KUBERNETES_SERVICE_PORT: "443",
      }),
    ).toBe(kubeconfig);
    expect(loads).toEqual(["cluster"]);
  });

  it("uses the user kubeconfig outside Kubernetes", () => {
    const { kubeconfig, loads } = fakeKubeConfig();
    loadKubernetesConfig(kubeconfig, {
      KUBERNETES_SERVICE_HOST: undefined,
      KUBERNETES_SERVICE_PORT: undefined,
    });
    expect(loads).toEqual(["default"]);
  });
});

describe("buildSandboxCustomResource (developer profile)", () => {
  const profile = buildSandboxLaunchProfile("developer");
  const cr = buildSandboxCustomResource({
    profile,
    name: "colony-sb-dev",
    namespace: DEFAULT_KUBERNETES_NAMESPACE,
    image: DEFAULT_SANDBOX_IMAGE,
    apiVersion: `${SANDBOX_GROUP}/v1beta1`,
  });

  it("pins the apiVersion, kind and namespace", () => {
    expect(cr.apiVersion.startsWith("agents.x-k8s.io/")).toBe(true);
    expect(cr.kind).toBe("Sandbox");
    expect(cr.metadata.namespace).toBe(DEFAULT_KUBERNETES_NAMESPACE);
  });

  it("carries the role, part-of and sandbox-id labels on CR and pod", () => {
    const expected = {
      [SANDBOX_ROLE_LABEL]: "developer",
      [SANDBOX_PART_OF_LABEL]: "colony",
      [SANDBOX_ID_LABEL]: "colony-sb-dev",
    };
    expect(cr.metadata.labels).toMatchObject(expected);
    expect(cr.spec.podTemplate.metadata.labels).toMatchObject(expected);
  });

  it("pins kata runtime and no service account token", () => {
    expect(cr.spec.podTemplate.spec.runtimeClassName).toBe("kata");
    expect(cr.spec.podTemplate.spec.automountServiceAccountToken).toBe(false);
  });

  it("pins the container image, resources, workingDir and securityContext", () => {
    const container = cr.spec.podTemplate.spec.containers[0];
    expect(container.name).toBe("sandbox");
    expect(container.image).toBe(DEFAULT_SANDBOX_IMAGE);
    expect(container.command).toEqual(["sleep", "infinity"]);
    expect(container.workingDir).toBe("/workspace");
    expect(container.resources.limits).toEqual({
      cpu: "2",
      memory: "4Gi",
      "ephemeral-storage": "8Gi",
    });
    expect(container.resources.requests).toEqual({
      cpu: "500m",
      memory: "1536Mi",
    });
    expect(container.securityContext.runAsUser).toBe(1000);
    expect(container.securityContext.runAsNonRoot).toBe(true);
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    // Pinned for the colony-sandboxes PodSecurity 'restricted:latest' posture
    // (the controller propagates these to the backing pod).
    expect(container.securityContext.capabilities.drop).toEqual(["ALL"]);
    expect(container.securityContext.seccompProfile.type).toBe(
      "RuntimeDefault",
    );
  });

  it("keeps the container env empty (no provider credentials or baked env)", () => {
    const container = cr.spec.podTemplate.spec.containers[0];
    expect(Array.isArray(container.env)).toBe(true);
    expect(container.env).toHaveLength(0);
  });

  it("backs /workspace with a 16Gi pod-lifetime PVC mounted for uid 1000", () => {
    const spec = cr.spec.podTemplate.spec;
    expect(spec.securityContext.fsGroup).toBe(1000);
    expect(spec.volumes).toEqual([
      {
        name: "workspace",
        ephemeral: {
          volumeClaimTemplate: {
            spec: {
              accessModes: ["ReadWriteOnce"],
              resources: { requests: { storage: "16Gi" } },
            },
          },
        },
      },
    ]);
    expect(spec.containers[0].volumeMounts).toEqual([
      { name: "workspace", mountPath: "/workspace" },
    ]);
  });

  it("honors a configured image override", () => {
    const overridden = buildSandboxCustomResource({
      profile,
      name: "colony-sb-dev",
      namespace: "ns",
      image: "my-registry/sandbox:custom",
      apiVersion: `${SANDBOX_GROUP}/v1beta1`,
    });
    expect(overridden.spec.podTemplate.spec.containers[0].image).toBe(
      "my-registry/sandbox:custom",
    );
  });
});

describe("buildSandboxCustomResource (reviewer profile)", () => {
  const profile = buildSandboxLaunchProfile("reviewer");
  const cr = buildSandboxCustomResource({
    profile,
    name: "colony-sb-rev",
    namespace: DEFAULT_KUBERNETES_NAMESPACE,
    image: DEFAULT_SANDBOX_IMAGE,
    apiVersion: `${SANDBOX_GROUP}/v1beta1`,
  });

  it("pins reviewer limits and role label", () => {
    const container = cr.spec.podTemplate.spec.containers[0];
    expect(container.resources.limits).toEqual({
      cpu: "1",
      memory: "2Gi",
      "ephemeral-storage": "4Gi",
    });
    expect(container.resources.requests).toEqual({
      cpu: "250m",
      memory: "1Gi",
    });
    expect(cr.metadata.labels[SANDBOX_ROLE_LABEL]).toBe("reviewer");
  });

  it("requests an 8Gi workspace volume", () => {
    expect(
      cr.spec.podTemplate.spec.volumes[0].ephemeral.volumeClaimTemplate.spec
        .resources.requests.storage,
    ).toBe("8Gi");
  });
});

describe("resolveSandboxApiVersion", () => {
  const groups = [
    {
      name: "other.example.com",
      versions: [{ version: "v1" }],
    },
    {
      name: SANDBOX_GROUP,
      versions: [{ version: "v1alpha1" }, { version: "v1beta1" }],
    },
  ];

  it("prefers the advertised preferredVersion", () => {
    const result = resolveSandboxApiVersion([
      {
        name: SANDBOX_GROUP,
        versions: [
          { version: "v1alpha1" },
          { version: "v1beta1" },
          { version: "v1beta2" },
        ],
        preferredVersion: { version: "v1beta2" },
      },
    ]);
    expect(result).toBe(`${SANDBOX_GROUP}/v1beta2`);
  });

  it("chooses v1beta over v1alpha without a preferred version", () => {
    expect(resolveSandboxApiVersion(groups)).toBe(`${SANDBOX_GROUP}/v1beta1`);
  });

  it("chooses v1 first when served", () => {
    expect(
      resolveSandboxApiVersion([
        {
          name: SANDBOX_GROUP,
          versions: [{ version: "v1" }, { version: "v1beta1" }],
        },
      ]),
    ).toBe(`${SANDBOX_GROUP}/v1`);
  });

  it("lets an override bypass discovery", () => {
    expect(resolveSandboxApiVersion([], "v1alpha1")).toBe(
      `${SANDBOX_GROUP}/v1alpha1`,
    );
  });

  it("throws when the group is absent", () => {
    expect(() => resolveSandboxApiVersion([])).toThrow(
      /agent-sandbox controller installed/,
    );
  });
});

interface FakeExecCall {
  command: string[];
  stdin: Buffer;
  wsClosed: boolean;
}

/** A scripted pods/exec response used by the faked client. */
interface ExecScenario {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  /** If set, emit the terminal status (0 => Success, n => Failure exit code). */
  exit?: number;
  /** If true, emit terminal status without ending stdout/stderr. */
  leaveStreamsOpen?: boolean;
  /** If true, never emit a status or end the streams (exec hangs). */
  hang?: boolean;
  /** If true, close the remote WebSocket without ending either stream. */
  remoteClose?: boolean;
}

function scenarioKey(command: readonly string[]): string {
  return command.join("\u0000");
}

interface FakeClientConfig {
  scenarios?: Map<string, ExecScenario>;
  /** Response for any non-transfer exec command without an explicit scenario. */
  fallback?: ExecScenario;
  startupSandboxes?: readonly string[];
  /** Pods present at startup. If undefined, falls back to the ready-state pod. */
  startupPods?: readonly {
    name: string;
    phase: string;
    containerReady: boolean;
    labels?: Record<string, string>;
  }[];
}

function createFakeClient(
  state: { ready: boolean },
  config: FakeClientConfig = {},
): KubernetesSandboxClient & {
  createdAt: { namespace: string; body: SandboxCustomResource }[];
  deleted: string[];
  execCalls: FakeExecCall[];
} {
  const createdAt: { namespace: string; body: SandboxCustomResource }[] = [];
  const deleted: string[] = [];
  const execCalls: FakeExecCall[] = [];
  const scenarios = config.scenarios ?? new Map<string, ExecScenario>();
  const startupSandboxes = new Set(config.startupSandboxes ?? []);

  const transferCommand = [
    "tar",
    "-xf",
    "-",
    "--no-overwrite-dir",
    "-C",
    POD_WORKSPACE_DIR,
  ];
  const cleanupCommand = ["rm", "-rf", `${POD_WORKSPACE_DIR}/lost+found`];

  return {
    createdAt,
    deleted,
    execCalls,
    async discoverGroupVersions() {
      return [{ name: SANDBOX_GROUP, versions: [{ version: "v1beta1" }] }];
    },
    async createSandbox(
      namespace: string,
      body: SandboxCustomResource,
    ): Promise<unknown> {
      createdAt.push({ namespace, body });
      state.ready = true;
      return undefined;
    },
    async listSandboxes() {
      return [...startupSandboxes];
    },
    async getSandbox() {
      return { ready: state.ready };
    },
    async deleteSandbox(_namespace: string, name: string): Promise<void> {
      deleted.push(name);
      startupSandboxes.delete(name);
    },
    async listPods() {
      if (config.startupPods !== undefined) {
        return config.startupPods;
      }
      return state.ready
        ? [{ name: "sandbox-pod", phase: "Running", containerReady: true }]
        : [];
    },
    async execPod(
      _namespace: string,
      _podName: string,
      command: readonly string[],
      _stdout: import("node:stream").Writable,
      _stderr: import("node:stream").Writable,
      stdin: import("node:stream").Readable | null,
      statusCallback: (status: ExecPodStatus) => void,
    ) {
      const record: FakeExecCall = {
        command: [...command],
        stdin: Buffer.alloc(0),
        wsClosed: false,
      };
      execCalls.push(record);
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });

      if (stdin !== null) {
        stdin.on("data", (d: Buffer | string) => {
          record.stdin = Buffer.concat([record.stdin, Buffer.from(d)]);
        });
      }

      const explicit = scenarios.get(scenarioKey(command));
      const isTransfer =
        scenarioKey(command) === scenarioKey(transferCommand) ||
        scenarioKey(command) === scenarioKey(cleanupCommand);
      const scenario: ExecScenario =
        explicit ??
        (isTransfer ? { exit: 0 } : (config.fallback ?? { hang: true }));

      if (scenario.hang !== true) {
        const stdout = _stdout as import("node:stream").Writable;
        const stderr = _stderr as import("node:stream").Writable;
        for (const chunk of scenario.stdoutChunks ?? []) {
          stdout.write(Buffer.from(chunk, "utf8"));
        }
        for (const chunk of scenario.stderrChunks ?? []) {
          stderr.write(Buffer.from(chunk, "utf8"));
        }
        if (scenario.exit === 0) {
          if (scenario.leaveStreamsOpen !== true) {
            stdout.end();
            stderr.end();
          }
          statusCallback({ status: "Success" });
        } else if (scenario.exit !== undefined) {
          if (scenario.leaveStreamsOpen !== true) {
            stdout.end();
            stderr.end();
          }
          // Script the real kubelet wire shape (not a fictitious one).
          statusCallback({
            status: "Failure",
            message: `command terminated with exit code ${scenario.exit}`,
            details: {
              causes: [{ reason: "ExitCode", message: String(scenario.exit) }],
            },
          });
        }
      }
      if (scenario.remoteClose === true) {
        queueMicrotask(resolveClosed);
      }

      return {
        closed,
        close(): void {
          record.wsClosed = true;
          resolveClosed();
        },
      };
    },
  };
}

/** Provisions a handle through the fake client, given a temp workspace. */
async function provisionWith(
  workspace: string,
  config: FakeClientConfig = {},
  state: { ready: boolean } = { ready: false },
): Promise<{
  client: ReturnType<typeof createFakeClient>;
  handle: import("@colony/sandbox").SandboxHandle;
}> {
  const client = createFakeClient(state, config);
  const engine = createKubernetesEngine({
    client,
    provisionTimeoutMs: 2000,
    pollIntervalMs: 5,
  });
  const profile = buildSandboxLaunchProfile("developer");
  const handle = await engine.provision(profile, workspace);
  return { client, handle };
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

describe("createKubernetesEngine", () => {
  // Startup cleanup is process-scoped; each case starts from a fresh boot.
  beforeEach(() => resetStartupCleanupForTests());
  function fakeClient(state: {
    ready: boolean;
  }): ReturnType<typeof createFakeClient> {
    return createFakeClient(state);
  }

  it("provisions, destroys idempotently, and rejects exec after destroy", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "k8s-prov-"));
    const workspace = join(parentDir, "workspace");
    await mkdir(workspace, { recursive: true });
    try {
      const state = { ready: false };
      const client = fakeClient(state);
      const engine = createKubernetesEngine({
        client,
        provisionTimeoutMs: 2000,
        pollIntervalMs: 5,
      });

      const profile = buildSandboxLaunchProfile("developer");
      const handle = await engine.provision(profile, workspace);

      expect(client.createdAt.length).toBe(1);
      const created = client.createdAt[0]!.body;
      expect(created.kind).toBe("Sandbox");
      expect(created.metadata.name.startsWith("colony-")).toBe(true);
      expect(created.metadata.namespace).toBe(DEFAULT_KUBERNETES_NAMESPACE);
      expect(created.spec.podTemplate.spec.containers[0].image).toBe(
        DEFAULT_SANDBOX_IMAGE,
      );

      const sandboxName = created.metadata.name;

      // The handle exposes the pinned lifecycle fields the exec-channel task
      // depends on: podName, name, profile, workspace, and the underlying client.
      const k8sHandle = handle as unknown as {
        podName: string;
        name: string;
        namespace: string;
        profile: unknown;
        workspace: string;
        kubeconfig: unknown;
        client: KubernetesSandboxClient;
      };
      expect(k8sHandle.podName).toBe("sandbox-pod");
      expect(k8sHandle.name).toBe(sandboxName);
      expect(k8sHandle.namespace).toBe(DEFAULT_KUBERNETES_NAMESPACE);
      expect(k8sHandle.profile).toBe(profile);
      expect(k8sHandle.workspace).toBe(workspace);
      expect(k8sHandle.client).toBe(client);

      await handle.destroy();
      expect(client.deleted).toContain(sandboxName);

      // Second destroy is a no-op.
      await expect(handle.destroy()).resolves.toBeUndefined();

      // Exec after destroy rejects.
      await expect(
        handle.exec({ command: "true" }, () => {}),
      ).rejects.toThrow();
      await expect(handle.readFile("hello.txt")).rejects.toThrow();
      await expect(handle.writeFile("hello.txt", "x")).rejects.toThrow();
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it("reaps restart-orphaned sandboxes once before admitting new work", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "k8s-reap-"));
    const workspace = join(parentDir, "workspace");
    await mkdir(workspace, { recursive: true });
    try {
      const state = { ready: false };
      const client = createFakeClient(state, {
        startupSandboxes: ["orphan-a", "orphan-b"],
      });
      const engine = createKubernetesEngine({
        client,
        provisionTimeoutMs: 2000,
        pollIntervalMs: 5,
      });
      const profile = buildSandboxLaunchProfile("developer");

      const first = await engine.provision(profile, workspace);
      const second = await engine.provision(profile, workspace);

      expect(client.deleted).toEqual(["orphan-a", "orphan-b"]);
      expect(client.createdAt).toHaveLength(2);

      await Promise.all([first.destroy(), second.destroy()]);
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it("startup reap does not wait on a pod that is already Terminating", async () => {
    // The CR is gone and the kubelet owns the pod's teardown; on an
    // unreachable node that never completes (5 h on talos-trinity,
    // 2026-09-03), and waiting on it failed every provision for the process.
    const parentDir = await mkdtemp(join(tmpdir(), "k8s-reap-terminating-"));
    const workspace = join(parentDir, "workspace");
    await mkdir(workspace, { recursive: true });
    try {
      const state = { ready: false };
      const client = createFakeClient(state, {});
      const realListPods = client.listPods.bind(client);
      client.listPods = async (namespace, selector) =>
        state.ready
          ? realListPods(namespace, selector)
          : [
              {
                name: "orphan-on-dead-node",
                phase: "Running",
                containerReady: false,
                terminating: true,
              },
            ];
      const engine = createKubernetesEngine({
        client,
        provisionTimeoutMs: 200,
        pollIntervalMs: 5,
      });
      const handle = await engine.provision(
        buildSandboxLaunchProfile("developer"),
        workspace,
      );
      expect(client.createdAt).toHaveLength(1);
      await handle.destroy();
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it("a failed startup reap is retried on the next provision, not cached for the process", async () => {
    // One pod stuck Terminating on a sick node made the reap time out, and
    // the rejected promise then failed every provision for the life of the
    // daemon in 3 s each (2026-09-03).
    const parentDir = await mkdtemp(join(tmpdir(), "k8s-reap-retry-"));
    const workspace = join(parentDir, "workspace");
    await mkdir(workspace, { recursive: true });
    try {
      const state = { ready: false };
      const client = createFakeClient(state, {
        startupSandboxes: ["orphan-stuck"],
      });
      // The orphan's pod lingers Terminating until the operator clears it.
      let stuck = true;
      const realListPods = client.listPods.bind(client);
      client.listPods = async (namespace, selector) =>
        stuck && !state.ready
          ? [
              {
                name: "orphan-stuck-pod",
                phase: "Running",
                containerReady: false,
              },
            ]
          : realListPods(namespace, selector);
      const engine = createKubernetesEngine({
        client,
        provisionTimeoutMs: 50,
        pollIntervalMs: 5,
      });
      const profile = buildSandboxLaunchProfile("developer");

      await expect(engine.provision(profile, workspace)).rejects.toThrow(
        /reaping 1 startup-orphaned/,
      );
      stuck = false; // operator force-deleted the pod
      const handle = await engine.provision(profile, workspace);
      expect(client.createdAt).toHaveLength(1);
      await handle.destroy();
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it("a second engine instance in the same process never reaps the first one's live sandboxes", async () => {
    // colonyd runs two engine instances (agent runners + validation). The
    // validator's first provision after a boot used to reap every live agent
    // sandbox as a restart orphan (2026-09-01).
    const parentDir = await mkdtemp(join(tmpdir(), "k8s-two-engines-"));
    const workspace = join(parentDir, "workspace");
    await mkdir(workspace, { recursive: true });
    try {
      const state = { ready: false };
      const client = createFakeClient(state, {
        startupSandboxes: ["orphan-from-last-boot"],
      });
      const runners = createKubernetesEngine({
        client,
        provisionTimeoutMs: 2000,
        pollIntervalMs: 5,
      });
      const validator = createKubernetesEngine({
        client,
        provisionTimeoutMs: 2000,
        pollIntervalMs: 5,
      });
      const profile = buildSandboxLaunchProfile("developer");

      const live = await runners.provision(profile, workspace);
      expect(client.deleted).toEqual(["orphan-from-last-boot"]);
      const liveName = client.createdAt[0]!.body.metadata.name;

      const validate = await validator.provision(profile, workspace);
      // Still exactly the one boot orphan: the live sandbox survived.
      expect(client.deleted).toEqual(["orphan-from-last-boot"]);
      expect(client.deleted).not.toContain(liveName);

      await Promise.all([live.destroy(), validate.destroy()]);
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it("an exclusionless engine that provisions first cannot reap a later engine's adopted CRs", async () => {
    // The cleanup memo is per namespace, but the exclusions decide what the
    // pass may delete. Keying the memo on the namespace alone froze the first
    // engine's exclusion set for the whole process: a boot-time probe engine
    // built with no exclusions reaped the CRs the runtime engine was about to
    // adopt (and vice versa).
    const parentDir = await mkdtemp(join(tmpdir(), "k8s-exclusion-memo-"));
    const workspace = join(parentDir, "workspace");
    await mkdir(workspace, { recursive: true });
    try {
      const state = { ready: false };
      const client = createFakeClient(state, {
        startupSandboxes: ["adopted-1", "orphan-1"],
        startupPods: [
          {
            name: "adopted-pod",
            phase: "Running",
            containerReady: true,
            labels: { [SANDBOX_ID_LABEL]: "adopted-1" },
          },
        ],
      });
      const probe = createKubernetesEngine({
        client,
        provisionTimeoutMs: 2000,
        pollIntervalMs: 5,
      });
      const runtime = createKubernetesEngine({
        client,
        adoptedSandboxIds: new Set(["adopted-1"]),
        provisionTimeoutMs: 2000,
        pollIntervalMs: 5,
      });
      const profile = buildSandboxLaunchProfile("developer");

      // The exclusionless engine runs the only pass there will be, and it
      // still must not touch adopted-1: exclusions are process-wide, not
      // properties of the engine that happens to provision first.
      const probeHandle = await probe.provision(profile, workspace);
      expect(client.deleted).toEqual(["orphan-1"]);

      const adoptedHandle = await runtime.provision(profile, workspace);
      expect(client.deleted).toEqual(["orphan-1"]);

      await Promise.all([probeHandle.destroy(), adoptedHandle.destroy()]);
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it("CRs in adoptedSandboxIds survive provision() while non-excluded CRs are deleted", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "k8s-adopted-"));
    const workspace = join(parentDir, "workspace");
    await mkdir(workspace, { recursive: true });
    try {
      const state = { ready: false };
      const client = createFakeClient(state, {
        startupSandboxes: ["adopted-1", "orphan-1"],
        startupPods: [
          {
            name: "pod-custom-name",
            phase: "Running",
            containerReady: true,
            labels: { [SANDBOX_ID_LABEL]: "adopted-1" },
          },
        ],
      });
      const engine = createKubernetesEngine({
        client,
        adoptedSandboxIds: new Set(["adopted-1"]),
        provisionTimeoutMs: 2000,
        pollIntervalMs: 5,
      });
      const profile = buildSandboxLaunchProfile("developer");
      const handle = await engine.provision(profile, workspace);

      expect(client.deleted).toEqual(["orphan-1"]);
      const remainingSandboxes = await client.listSandboxes(
        "colony-sandboxes",
        "",
      );
      expect(remainingSandboxes).toContain("adopted-1");

      await handle.destroy();
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it("connect resolves a handle for a listed CR and rejects when CR or pod is missing", async () => {
    const state = { ready: true };
    const client = createFakeClient(state, {
      startupSandboxes: ["sb-live"],
    });
    const engine = createKubernetesEngine({
      client,
    });

    const handle = await engine.connect("sb-live");
    expect(handle.sandboxId).toBe("sb-live");

    // Missing CR
    await expect(engine.connect("sb-missing")).rejects.toThrow(
      /sandbox sb-missing gone: no Sandbox CR/,
    );

    // Missing/not ready pod
    state.ready = false;
    await expect(engine.connect("sb-live")).rejects.toThrow(
      /sandbox sb-live gone: no Running and ready backing pod/,
    );
  });

  it("connect alone (no provision) performs no deletes and does not trigger startup orphan cleanup", async () => {
    const state = { ready: true };
    const client = createFakeClient(state, {
      startupSandboxes: ["sb-1", "orphan-x"],
    });
    const engine = createKubernetesEngine({
      client,
    });

    const handle = await engine.connect("sb-1");
    expect(handle.sandboxId).toBe("sb-1");
    expect(client.deleted).toHaveLength(0);
  });

  it("fails closed into a SandboxRbacError on a 403", async () => {
    const client: KubernetesSandboxClient = {
      async discoverGroupVersions() {
        return [{ name: SANDBOX_GROUP, versions: [{ version: "v1beta1" }] }];
      },
      async createSandbox(): Promise<unknown> {
        const err = new Error("forbidden") as unknown as {
          code: number;
          statusCode: number;
        };
        err.code = 403;
        err.statusCode = 403;
        throw err;
      },
      async listSandboxes() {
        return [];
      },
      async getSandbox() {
        return { ready: true };
      },
      async deleteSandbox(): Promise<void> {},
      async listPods() {
        return [];
      },
      async execPod(): Promise<never> {
        throw new Error("no pod (RBAC denied before provision)");
      },
    };

    const engine = createKubernetesEngine({
      client,
      namespace: "colony-sandboxes",
      pollIntervalMs: 5,
      provisionTimeoutMs: 2000,
    });
    const profile = buildSandboxLaunchProfile("developer");

    let error: unknown;
    try {
      await engine.provision(profile, "/workspace");
      throw new Error("expected provision to reject");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SandboxRbacError);
    const rbac = error as SandboxRbacError;
    expect(rbac.statusCode).toBe(403);
    expect(rbac.message).toContain("agents.x-k8s.io");
    expect(rbac.message).toContain("colony-sandboxes");
    expect(rbac.message).toMatch(/RBAC/);
    expect(rbac.message).toContain("sandboxtemplates/sandboxclaims");
  });

  it("fails fast with a quota marker when the namespace ResourceQuota refuses the CR", async () => {
    const client: KubernetesSandboxClient = {
      async discoverGroupVersions() {
        return [{ name: SANDBOX_GROUP, versions: [{ version: "v1beta1" }] }];
      },
      async createSandbox(): Promise<unknown> {
        const err = new Error(
          "admission webhook denied the request: exceeded quota",
        ) as unknown as {
          code: number;
          statusCode: number;
          body: unknown;
        };
        err.code = 403;
        err.statusCode = 403;
        err.body = {
          message:
            'sandboxes.agents.x-k8s.io "colony-x" is forbidden: ' +
            "exceeded quota: colony-sandboxes, requested: pods=1, used: pods=20, limited: pods=20",
        };
        throw err;
      },
      async listSandboxes() {
        return [];
      },
      async getSandbox() {
        return { ready: true };
      },
      async deleteSandbox(): Promise<void> {},
      async listPods() {
        return [];
      },
      async execPod(): Promise<never> {
        throw new Error("no pod (quota refused before provision)");
      },
    };

    const engine = createKubernetesEngine({
      client,
      namespace: "colony-sandboxes",
      pollIntervalMs: 5,
      provisionTimeoutMs: 2000,
    });
    const profile = buildSandboxLaunchProfile("developer");

    let error: unknown;
    try {
      await engine.provision(profile, "/workspace");
      throw new Error("expected provision to reject");
    } catch (err) {
      error = err;
    }
    // A saturated namespace is not an RBAC misconfiguration: the error must
    // be distinguishable from the forbidden case that never admits.
    expect(error).not.toBeInstanceOf(SandboxRbacError);
    expect(error).toBeInstanceOf(SandboxQuotaError);
    // The marker is the whole contract with the orchestrator: a class that
    // is right but a message that lost the prefix defers nothing.
    expect((error as Error).message).toContain(SANDBOX_QUOTA_EXHAUSTED);
    expect((error as Error).message).toContain("exceeded quota");
    expect((error as Error).message).toContain("colony-sandboxes");
  });

  it("deletes the just-created Sandbox CR when the readiness wait fails", async () => {
    const createdAt: { namespace: string; body: SandboxCustomResource }[] = [];
    const deleted: string[] = [];
    const client: KubernetesSandboxClient = {
      async discoverGroupVersions() {
        return [{ name: SANDBOX_GROUP, versions: [{ version: "v1beta1" }] }];
      },
      async createSandbox(namespace, body) {
        createdAt.push({ namespace, body });
        return undefined;
      },
      async listSandboxes() {
        return [];
      },
      // Never becomes ready: forces the ready-wait deadline to throw.
      async getSandbox() {
        return { ready: false };
      },
      async deleteSandbox(_namespace, name) {
        deleted.push(name);
      },
      async listPods() {
        return [];
      },
      async execPod(): Promise<never> {
        throw new Error("no pod (provision failed before backing pod)");
      },
    };

    const engine = createKubernetesEngine({
      client,
      namespace: "colony-sandboxes",
      pollIntervalMs: 1,
      provisionTimeoutMs: 30,
    });
    const profile = buildSandboxLaunchProfile("developer");

    await expect(engine.provision(profile, "/workspace")).rejects.toThrow();
    expect(createdAt.length).toBe(1);
    const sandboxName = createdAt[0]!.body.metadata.name;
    // A failed provision deletes the CR so nothing is orphaned.
    expect(deleted).toContain(sandboxName);
  });

  it("constructs lazily without a kubeconfig or touching KUBECONFIG/fs", () => {
    const original = process.env.KUBECONFIG;
    delete process.env.KUBECONFIG;
    try {
      const engine = createKubernetesEngine();
      expect(typeof engine.provision).toBe("function");
    } finally {
      if (original !== undefined) process.env.KUBECONFIG = original;
    }
  });
});

describe("K8sSandboxHandle exec channel", () => {
  it("surfaces ordered stdout/stderr with strictly increasing seq and exit 0", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "k8s-exec-"));
    try {
      const { handle } = await provisionWith(workspace, {
        fallback: {
          stdoutChunks: ["a1", "a2"],
          stderrChunks: ["b1", "b2"],
          exit: 0,
        },
      });

      const events: import("@colony/sandbox").ExecEvent[] = [];
      const result = await handle.exec(
        { command: "printf a1; printf b1 1>&2; printf a2; printf b2 1>&2" },
        (event) => events.push(event),
      );

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      for (let i = 1; i < events.length; i++) {
        expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
      }
      const stdoutData = events
        .filter((e) => e.kind === "stdout")
        .map((e) => e.data)
        .join("");
      const stderrData = events
        .filter((e) => e.kind === "stderr")
        .map((e) => e.data)
        .join("");
      expect(stdoutData).toBe("a1a2");
      expect(stderrData).toBe("b1b2");
      const finalEvent = events[events.length - 1]!;
      expect(finalEvent.kind).toBe("exit");
      expect(finalEvent.kind === "exit" && finalEvent.exitCode).toBe(0);
      expect(finalEvent.kind === "exit" && finalEvent.exitCode).toBe(
        result.exitCode,
      );

      await handle.destroy();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("injects only allowlisted env and never PATH/HOME/TMPDIR", async () => {
    const previousCanary = process.env.COLONY_SANDBOX_TEST_CANARY;
    const previousRun = process.env.COLONY_RUN_ID;
    // A value with a single quote exercises the POSIX single-quote escaping.
    process.env.COLONY_RUN_ID = "it's";
    process.env.COLONY_SANDBOX_TEST_CANARY = "top-secret";
    try {
      const workspace = await mkdtemp(join(tmpdir(), "k8s-env-"));
      try {
        const { client, handle } = await provisionWith(workspace, {
          fallback: { exit: 0 },
        });
        await handle.exec({ command: "true" }, () => undefined);

        // The workspace is empty, so provision skips the transfer entirely;
        // the exec under test is the first pod call.
        const execCall = client.execCalls[0]!;
        const script = execCall.command[2]!;
        expect(execCall.command[0]).toBe("/bin/sh");
        expect(execCall.command[1]).toBe("-c");

        expect(script).toContain("export COLONY_RUN_ID='it'\\''s'");
        expect(script).not.toContain("COLONY_SANDBOX_TEST_CANARY");
        expect(script).not.toContain("top-secret");
        expect(script).not.toMatch(/(^|\n)export PATH=/);
        expect(script).not.toMatch(/(^|\n)export HOME=/);
        expect(script).not.toMatch(/(^|\n)export TMPDIR=/);
        // Default cwd is the pod workspace dir.
        expect(script).toContain("cd '/workspace'");
        // The user command is appended verbatim so shell semantics survive.
        expect(script.endsWith("\ntrue")).toBe(true);

        await handle.destroy();
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    } finally {
      restoreEnv("COLONY_RUN_ID", previousRun);
      restoreEnv("COLONY_SANDBOX_TEST_CANARY", previousCanary);
    }
  });

  it("times out by closing the WebSocket and returning timedOut", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "k8s-timeout-"));
    try {
      const { client, handle } = await provisionWith(workspace, {
        fallback: { hang: true },
      });
      const events: import("@colony/sandbox").ExecEvent[] = [];
      const result = await handle.exec(
        { command: "sleep 1000", timeoutMs: 30 },
        (event) => events.push(event),
      );

      expect(result.exitCode).toBeNull();
      expect(result.timedOut).toBe(true);
      const finalEvent = events[events.length - 1]!;
      expect(finalEvent.kind).toBe("exit");
      expect(finalEvent.kind === "exit" && finalEvent.exitCode).toBeNull();

      const execCall = client.execCalls[0]!;
      expect(execCall.wsClosed).toBe(true);

      await handle.destroy();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("readFile/writeFile round-trip binary over base64 and reject escaping paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "k8s-rw-"));
    try {
      const content = "a\u0000\u00ffb";
      const readB64 = Buffer.from(content, "utf8").toString("base64");

      // Raw bytes including NUL and 0xFF that readFile must preserve exactly.
      const rawBytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00]);
      const rawB64 = rawBytes.toString("base64");

      const writeCommand = [
        "/bin/sh",
        "-c",
        'base64 -d > "$1"',
        "sh",
        `${POD_WORKSPACE_DIR}/data.bin`,
      ];
      const readCommand = ["base64", `${POD_WORKSPACE_DIR}/data.bin`];
      const rawReadCommand = ["base64", `${POD_WORKSPACE_DIR}/raw.bin`];

      const { client, handle } = await provisionWith(workspace, {
        scenarios: new Map<string, ExecScenario>([
          [scenarioKey(writeCommand), { exit: 0 }],
          [scenarioKey(readCommand), { stdoutChunks: [readB64], exit: 0 }],
          [scenarioKey(rawReadCommand), { stdoutChunks: [rawB64], exit: 0 }],
        ]),
      });

      // writeFile: base64 content is piped as stdin and the exec succeeds.
      await handle.writeFile("data.bin", content);
      const writeCall = client.execCalls.find(
        (c) => c.command.join("\u0000") === scenarioKey(writeCommand),
      );
      expect(writeCall).toBeDefined();
      expect(writeCall!.stdin.toString("utf8")).toBe(readB64);

      // readFile: concatenated stdout base64 decodes back to the content.
      const buf = await handle.readFile("data.bin");
      expect(Buffer.from(content, "utf8").equals(buf)).toBe(true);

      // readFile preserves raw NUL/0xFF bytes (binary-safe).
      const raw = await handle.readFile("raw.bin");
      expect(raw.equals(rawBytes)).toBe(true);

      // Path escapes and absolute paths are rejected by both readFile/writeFile.
      await expect(handle.readFile("../x")).rejects.toThrow();
      await expect(handle.readFile("/etc/passwd")).rejects.toThrow();
      await expect(handle.readFile("C:\\x")).rejects.toThrow();
      await expect(handle.readFile("C:/x")).rejects.toThrow();
      await expect(handle.writeFile("../x", "a")).rejects.toThrow();
      await expect(handle.writeFile("/etc/passwd", "a")).rejects.toThrow();
      await expect(handle.writeFile("C:\\x", "a")).rejects.toThrow();
      await expect(handle.writeFile("C:/x", "a")).rejects.toThrow();

      await handle.destroy();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("provision() streams a validating tar into the pod workspace", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "k8s-ws-"));
    const workspace = join(parentDir, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "hello.txt"), "hi");
    try {
      const { client, handle } = await provisionWith(workspace);

      // execCalls[0] clears lost+found; [1] is the workspace-transfer session.
      expect(client.execCalls[0]!.command).toEqual([
        "rm",
        "-rf",
        `${POD_WORKSPACE_DIR}/lost+found`,
      ]);
      const transferCall = client.execCalls[1]!;
      expect(transferCall.command).toEqual([
        "tar",
        "-xf",
        "-",
        "--no-overwrite-dir",
        "-C",
        POD_WORKSPACE_DIR,
      ]);
      expect(transferCall.stdin.length).toBeGreaterThan(0);
      // Every POSIX/GNU tar archive embeds the "ustar" magic at offset 257.
      expect(transferCall.stdin.subarray(257, 262).toString("utf8")).toBe(
        "ustar",
      );

      await handle.destroy();
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it("parses non-zero exit codes from the real kubelet wire shape", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "k8s-exitcode-"));
    try {
      const { handle } = await provisionWith(workspace, {
        fallback: {
          stdoutChunks: [],
          stderrChunks: [],
          exit: 42,
        },
      });

      const events: import("@colony/sandbox").ExecEvent[] = [];
      const result = await handle.exec({ command: "exit 42" }, (event) =>
        events.push(event),
      );

      // The fake client scripts exit:42 which now uses the real kubelet shape:
      // { status: "Failure", message: "command terminated with exit code 42",
      //   reason: "NonZeroExitCode",
      //   details: { causes: [{ reason: "ExitCode", message: "42" }] } }
      // parseExecExitCode must extract 42 from cause.reason === "ExitCode".
      expect(result.exitCode).toBe(42);
      expect(result.timedOut).toBe(false);
      const finalEvent = events[events.length - 1]!;
      expect(finalEvent.kind).toBe("exit");
      expect(finalEvent.kind === "exit" && finalEvent.exitCode).toBe(42);

      await handle.destroy();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("settles exec on terminal status when streams and socket stay open", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "k8s-status-only-"));
    try {
      const { handle } = await provisionWith(workspace, {
        fallback: { exit: 0, leaveStreamsOpen: true },
      });

      const result = await handle.exec({ command: "true" }, () => {});

      expect(result).toMatchObject({ exitCode: 0, timedOut: false });
      await handle.destroy();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("settles exec when the remote WebSocket closes first", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "k8s-remote-close-"));
    try {
      const { handle } = await provisionWith(workspace, {
        fallback: { hang: true, remoteClose: true },
      });

      const result = await handle.exec({ command: "true" }, () => {});

      expect(result).toMatchObject({ exitCode: null, timedOut: false });
      await handle.destroy();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("settles exec when destroy() closes the socket (no Status message)", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "k8s-sockclose-"));
    try {
      const { handle } = await provisionWith(workspace, {
        fallback: { hang: true },
      });

      let settled = false;
      const execPromise = handle
        .exec({ command: "sleep 9999" }, () => {})
        .then((r) => {
          settled = true;
          return r;
        });

      // Give the exec a moment to connect.
      await new Promise((r) => setTimeout(r, 20));

      // destroy() closes all in-flight sockets. The exec must settle
      // rather than hanging forever.
      await handle.destroy();
      const result = await execPromise;
      expect(settled).toBe(true);
      // No Status was received so exitCode is null.
      expect(result.exitCode).toBeNull();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
