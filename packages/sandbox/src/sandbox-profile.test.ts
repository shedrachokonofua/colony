import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_REFS,
  SANDBOX_ROLE_LABEL,
  buildSandboxLaunchProfile,
} from "./sandbox-profile.js";

describe("buildSandboxLaunchProfile", () => {
  it("returns a developer profile with the developer role label", () => {
    const profile = buildSandboxLaunchProfile("developer");
    expect(profile.role).toBe("developer");
    expect(profile.actorRole).toBe("developer");
    expect(profile.podLabels[SANDBOX_ROLE_LABEL]).toBe("developer");
    expect(profile.runtimeClass).toBe("gvisor");
  });

  it("returns a reviewer profile with the reviewer role label and read-only rootfs", () => {
    const profile = buildSandboxLaunchProfile("reviewer");
    expect(profile.role).toBe("reviewer");
    expect(profile.actorRole).toBe("reviewer");
    expect(profile.podLabels[SANDBOX_ROLE_LABEL]).toBe("reviewer");
    expect(profile.readOnlyRootFilesystem).toBe(true);
  });

  it("returns a validate profile that is credential- and daemon-config-free by construction", () => {
    const profile = buildSandboxLaunchProfile("validate");
    expect(profile.role).toBe("validate");
    expect(profile.podLabels[SANDBOX_ROLE_LABEL]).toBe("validate");

    expect(profile.envAllowlist).toEqual(["CI", "NO_COLOR", "FORCE_COLOR"]);
    expect(profile.envAllowlist.some((name) => /^COLONY/.test(name))).toBe(
      false,
    );
    expect(profile.envAllowlist).not.toContain("NODE_ENV");

    expect(profile.capabilities).toEqual(["sandbox.exec"]);
    expect(profile.readOnlyRootFilesystem).toBe(true);

    expect(profile.resourceLimits).toEqual({
      cpu: "1",
      memory: "2Gi",
      ephemeralStorage: "4Gi",
    });

    const services = profile.egressAllowlist.flatMap((target) =>
      target.kind === "service" ? [target] : [],
    );
    const toolGateway = services.find(
      (svc) => svc.name === DEFAULT_SANDBOX_REFS.toolGatewayServiceName,
    );
    expect(toolGateway).toBeDefined();
    expect(profile.egressAllowlist.some((t) => t.kind === "kube-dns")).toBe(
      true,
    );

    const taskGraphDeny = profile.egressDenylist.find(
      (deny) => deny.name === DEFAULT_SANDBOX_REFS.taskGraphApiServiceName,
    );
    expect(taskGraphDeny).toBeDefined();
  });

  it("egress allowlist permits Tool Gateway and DNS", () => {
    const profile = buildSandboxLaunchProfile("developer");

    const services = profile.egressAllowlist.flatMap((target) =>
      target.kind === "service" ? [target] : [],
    );
    const toolGateway = services.find(
      (svc) => svc.name === DEFAULT_SANDBOX_REFS.toolGatewayServiceName,
    );
    expect(toolGateway).toBeDefined();
    expect(toolGateway?.namespace).toBe(
      DEFAULT_SANDBOX_REFS.controlPlaneNamespace,
    );
    expect(toolGateway?.ports).toEqual([DEFAULT_SANDBOX_REFS.toolGatewayPort]);

    const hasDns = profile.egressAllowlist.some(
      (target) => target.kind === "kube-dns",
    );
    expect(hasDns).toBe(true);
  });

  it("egress allowlist does not include the Task Graph API service", () => {
    const profile = buildSandboxLaunchProfile("developer");
    const services = profile.egressAllowlist.flatMap((target) =>
      target.kind === "service" ? [target] : [],
    );
    const apiNames = services.map((svc) => svc.name);
    expect(apiNames).not.toContain(
      DEFAULT_SANDBOX_REFS.taskGraphApiServiceName,
    );
  });

  it("egress denylist explicitly forbids the Task Graph API service", () => {
    const profile = buildSandboxLaunchProfile("reviewer");
    const taskGraphDeny = profile.egressDenylist.find(
      (deny) => deny.name === DEFAULT_SANDBOX_REFS.taskGraphApiServiceName,
    );
    expect(taskGraphDeny).toBeDefined();
    expect(taskGraphDeny?.reason).toMatch(/Task Graph API/i);
  });

  it("does not grant graph.write capability to any sandbox role", () => {
    for (const role of ["developer", "reviewer"] as const) {
      const profile = buildSandboxLaunchProfile(role);
      expect(profile.capabilities).not.toContain("graph.write");
    }
  });

  it("starts without ambient skills, CLI tools, or Nix profile", () => {
    const profile = buildSandboxLaunchProfile("developer");
    expect(profile.runExtensions.skillMounts).toEqual([]);
    expect(profile.runExtensions.cliTools).toEqual([]);
    expect(profile.runExtensions.nixProfile).toBeUndefined();
  });

  it("accepts explicit read-only skills, generic CLI tools, and a Nix profile", () => {
    const profile = buildSandboxLaunchProfile("developer", {
      runExtensions: {
        skillMounts: [
          {
            name: "s30-kubectl",
            description: "Kubernetes guidance.",
            source: "shared/meta",
            hash: "sha256:test-skill",
            mountPath: "/colony/skills/k8s-readonly",
            readOnly: true,
          },
        ],
        cliTools: [
          {
            name: "kubectl",
            executable: "kubectl",
            packageRef: "nixpkgs#kubectl",
            resolver: "nix",
            requiredCapabilities: ["tool.cli.execute"],
            envAllowlist: ["KUBECONFIG"],
            argsPolicy: "k8s-readonly",
          },
        ],
        nixProfile: {
          flakeRef: "github:NixOS/nixpkgs/nixos-unstable",
          profileHash: "sha256:test-profile",
          packages: [{ name: "kubectl", ref: "nixpkgs#kubectl" }],
        },
      },
    });

    expect(profile.runExtensions.skillMounts).toHaveLength(1);
    expect(profile.runExtensions.skillMounts[0]?.readOnly).toBe(true);
    expect(profile.runExtensions.cliTools[0]?.name).toBe("kubectl");
    expect(profile.runExtensions.cliTools[0]?.resolver).toBe("nix");
    expect(profile.runExtensions.nixProfile?.packages).toEqual([
      { name: "kubectl", ref: "nixpkgs#kubectl" },
    ]);
  });

  it("does not grant CLI tool capabilities just because a tool is present", () => {
    const profile = buildSandboxLaunchProfile("reviewer", {
      runExtensions: {
        skillMounts: [],
        cliTools: [
          {
            name: "gcx",
            executable: "gcx",
            packageRef: "nixpkgs#gcx",
            resolver: "nix",
            requiredCapabilities: ["tool.cli.execute"],
            envAllowlist: ["GRAFANA_URL"],
          },
        ],
      },
    });

    expect(profile.runExtensions.cliTools[0]?.requiredCapabilities).toContain(
      "tool.cli.execute",
    );
    expect(profile.capabilities).not.toContain("tool.cli.execute");
  });

  it("rejects skill mounts outside the Colony skills directory", () => {
    expect(() =>
      buildSandboxLaunchProfile("developer", {
        runExtensions: {
          skillMounts: [
            {
              name: "bad-skill",
              hash: "sha256:test",
              mountPath: "/home/agent/.ssh",
              readOnly: true,
            },
          ],
          cliTools: [],
        },
      }),
    ).toThrow(/\/colony\/skills/);
  });

  it("env allowlist does not include raw provider tokens", () => {
    const profile = buildSandboxLaunchProfile("developer");
    const lower = profile.envAllowlist.map((name) => name.toLowerCase());
    expect(lower.some((n) => n.includes("gitlab_token"))).toBe(false);
    expect(lower.some((n) => n.includes("admin"))).toBe(false);
    expect(lower.some((n) => n.includes("api_key"))).toBe(false);
  });

  it("accepts custom namespace refs and uses them in egress targets", () => {
    const profile = buildSandboxLaunchProfile("developer", {
      refs: {
        controlPlaneNamespace: "colony-prod",
        toolGatewayServiceName: "colony-tool-gateway",
        toolGatewayPort: 4200,
        taskGraphApiServiceName: "colony-api",
      },
    });
    const services = profile.egressAllowlist.flatMap((target) =>
      target.kind === "service" ? [target] : [],
    );
    expect(services.every((svc) => svc.namespace === "colony-prod")).toBe(true);
  });
});
