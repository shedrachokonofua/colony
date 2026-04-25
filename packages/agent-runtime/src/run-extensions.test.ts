import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  discoverSkillRegistry,
  hashProfile,
  prepareSandboxToolEnvironment,
  selectSkillMounts,
} from "./index.js";
import { assertValidRunExtensions } from "./run-extensions.js";

describe("skill registry", () => {
  it("discovers SKILL.md entries and selects read-only mounts by name", async () => {
    const root = join(tmpdir(), `colony-skills-${Date.now()}`);
    await mkdir(join(root, "k8s"), { recursive: true });
    await writeFile(
      join(root, "k8s", "SKILL.md"),
      [
        "---",
        "name: k8s-readonly",
        "description: Kubernetes read-only workflow.",
        "---",
        "# Ignored Heading",
        "",
        "Read-only operational guidance.",
      ].join("\n"),
    );

    const registry = await discoverSkillRegistry({ sourcePaths: [root] });
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({
      name: "k8s-readonly",
      source: root,
      mountPath: "/colony/skills/k8s-readonly",
    });
    expect(registry[0]?.hash).toMatch(/^sha256:/);

    const mounts = selectSkillMounts(registry, ["k8s-readonly"]);
    expect(mounts).toEqual([
      {
        name: "k8s-readonly",
        description: "Kubernetes read-only workflow.",
        source: root,
        hash: registry[0]?.hash,
        mountPath: "/colony/skills/k8s-readonly",
        readOnly: true,
      },
    ]);
  });
});

describe("run extension validation", () => {
  it("requires generic CLI tools to declare tool.cli.execute", () => {
    expect(() =>
      assertValidRunExtensions({
        skillMounts: [],
        cliTools: [
          {
            name: "git",
            executable: "git",
            resolver: "image",
            requiredCapabilities: ["provider.branches.push"],
            envAllowlist: [],
          },
        ],
      }),
    ).toThrow(/tool\.cli\.execute/);
  });
});

describe("sandbox tool materialization", () => {
  it("records a pinned Nix profile manifest and PATH entries", async () => {
    const extensions = {
      skillMounts: [],
      cliTools: [
        {
          name: "git",
          executable: "git",
          packageRef: "nixpkgs#git",
          resolver: "nix" as const,
          requiredCapabilities: ["tool.cli.execute" as const],
          envAllowlist: [],
        },
      ],
      nixProfile: {
        flakeRef: "github:NixOS/nixpkgs/nixos-25.11",
        packages: [{ name: "git", ref: "nixpkgs#git" }],
      },
    };

    const expectedProfileHash = hashProfile(
      extensions.nixProfile.flakeRef,
      extensions.nixProfile.packages,
      extensions.cliTools,
    );

    const prepared = await prepareSandboxToolEnvironment(extensions, {
      kind: "nix",
      resolveProfile: (input) => {
        expect(input.expectedProfileHash).toBe(expectedProfileHash);
        return {
          pathEntries: ["/nix/store/git-profile/bin"],
          profileHash: input.expectedProfileHash,
          toolVersions: { git: "2.51.0" },
        };
      },
    });

    expect(prepared.env).toEqual({
      PATH: "/nix/store/git-profile/bin:$PATH",
    });
    expect(prepared.manifest).toMatchObject({
      resolver: "nix",
      flakeRef: "github:NixOS/nixpkgs/nixos-25.11",
      profileHash: expectedProfileHash,
      packages: [{ name: "git", ref: "nixpkgs#git" }],
      tools: [
        {
          name: "git",
          executable: "git",
          packageRef: "nixpkgs#git",
          pathEntry: "/nix/store/git-profile/bin",
          version: "2.51.0",
        },
      ],
    });
  });

  it("supports image or platform fallback materializers without credentials", async () => {
    const prepared = await prepareSandboxToolEnvironment(
      {
        skillMounts: [],
        cliTools: [
          {
            name: "glab",
            executable: "glab",
            resolver: "image",
            requiredCapabilities: ["tool.cli.execute"],
            envAllowlist: ["GITLAB_HOST"],
          },
        ],
      },
      {
        kind: "fallback",
        resolveTools: () => ({
          pathEntries: ["/opt/colony/tools/bin"],
          profileHash: "sha256:image-tools",
          toolVersions: { glab: "1.74.0" },
        }),
      },
    );

    expect(prepared.manifest.resolver).toBe("fallback");
    expect(JSON.stringify(prepared)).not.toMatch(/token|secret|credential/i);
  });
});
