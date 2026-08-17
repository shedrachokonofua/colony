import { describe, expect, it } from "vitest";
import {
  SANDBOX_PART_OF_LABEL,
  SANDBOX_ROLE_LABEL,
  buildSandboxLaunchProfile,
} from "@colony/sandbox";
import {
  DEFAULT_KUBERNETES_NAMESPACE,
  DEFAULT_SANDBOX_IMAGE,
  SANDBOX_GROUP,
  SANDBOX_ID_LABEL,
  SandboxRbacError,
  buildSandboxCustomResource,
  resolveSandboxApiVersion,
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

describe("createKubernetesEngine", () => {
  function fakeClient(state: { ready: boolean }): KubernetesSandboxClient & {
    createdAt: { namespace: string; body: SandboxCustomResource }[];
    deleted: string[];
  } {
    const createdAt: { namespace: string; body: SandboxCustomResource }[] = [];
    const deleted: string[] = [];
    return {
      createdAt,
      deleted,
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
    };
  }

  it("provisions, destroys idempotently, and rejects exec after destroy", async () => {
    const state = { ready: false };
    const client = fakeClient(state);
    const engine = createKubernetesEngine({
      client,
      provisionTimeoutMs: 2000,
      pollIntervalMs: 5,
    });

    const profile = buildSandboxLaunchProfile("developer");
    const handle = await engine.provision(profile, "/workspace");

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
    expect(k8sHandle.workspace).toBe("/workspace");
    expect(k8sHandle.client).toBe(client);

    await handle.destroy();
    expect(client.deleted).toContain(sandboxName);

    // Second destroy is a no-op.
    await expect(handle.destroy()).resolves.toBeUndefined();

    // Exec after destroy rejects.
    await expect(handle.exec({ command: "true" }, () => {})).rejects.toThrow();
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
