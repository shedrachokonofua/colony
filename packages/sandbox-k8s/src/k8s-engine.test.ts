import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SANDBOX_PART_OF_LABEL,
  SANDBOX_ROLE_LABEL,
  buildSandboxLaunchProfile,
} from "@colony/sandbox";
import {
  DEFAULT_KUBERNETES_NAMESPACE,
  DEFAULT_SANDBOX_IMAGE,
  POD_WORKSPACE_DIR,
  SANDBOX_GROUP,
  SANDBOX_ID_LABEL,
  SandboxRbacError,
  buildSandboxCustomResource,
  resolveSandboxApiVersion,
  type ExecPodStatus,
  type KubernetesSandboxClient,
  type SandboxCustomResource,
} from "./contract.js";
import { createKubernetesEngine } from "./k8s-engine.js";

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
    expect(cr.metadata.labels[SANDBOX_ROLE_LABEL]).toBe("reviewer");
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
  /** If true, never emit a status or end the streams (exec hangs). */
  hang?: boolean;
}

function scenarioKey(command: readonly string[]): string {
  return command.join("\u0000");
}

interface FakeClientConfig {
  scenarios?: Map<string, ExecScenario>;
  /** Response for any non-transfer exec command without an explicit scenario. */
  fallback?: ExecScenario;
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

  const transferCommand = ["tar", "-xf", "-", "-C", POD_WORKSPACE_DIR];

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
    async getSandbox() {
      return { ready: state.ready };
    },
    async deleteSandbox(_namespace: string, name: string): Promise<void> {
      deleted.push(name);
    },
    async listPods() {
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

      if (stdin !== null) {
        stdin.on("data", (d: Buffer | string) => {
          record.stdin = Buffer.concat([record.stdin, Buffer.from(d)]);
        });
      }

      const explicit = scenarios.get(scenarioKey(command));
      const isTransfer = scenarioKey(command) === scenarioKey(transferCommand);
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
          stdout.end();
          stderr.end();
          statusCallback({ status: "Success" });
        } else if (scenario.exit !== undefined) {
          stdout.end();
          stderr.end();
          statusCallback({
            status: "Failure",
            details: { causes: [{ message: `exit code: ${scenario.exit}` }] },
          });
        }
      }

      return {
        close(): void {
          record.wsClosed = true;
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

        // execCalls[0] is the provision-time tar transfer; the second is the
        // /bin/sh -c exec above.
        const execCall = client.execCalls[1]!;
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

      const execCall = client.execCalls[1]!;
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

      // execCalls[0] is the workspace-transfer exec session.
      const transferCall = client.execCalls[0]!;
      expect(transferCall.command).toEqual([
        "tar",
        "-xf",
        "-",
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
});
