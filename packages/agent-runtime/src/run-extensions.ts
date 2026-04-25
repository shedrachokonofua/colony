import type { Capability } from "@colony/domain";

export type SandboxToolResolver = "nix" | "image" | "platform";

export interface SandboxSkillMount {
  readonly name: string;
  readonly description?: string;
  readonly source?: string;
  readonly hash: string;
  readonly mountPath: string;
  readonly readOnly: true;
}

export interface SandboxCliTool {
  readonly name: string;
  readonly executable: string;
  readonly packageRef?: string;
  readonly resolver: SandboxToolResolver;
  readonly requiredCapabilities: readonly Capability[];
  readonly envAllowlist: readonly string[];
  readonly argsPolicy?: string;
}

export interface SandboxNixPackage {
  readonly name: string;
  readonly ref: string;
}

export interface SandboxNixProfile {
  readonly flakeRef?: string;
  readonly profileHash?: string;
  readonly packages: readonly SandboxNixPackage[];
}

export interface SandboxRunExtensions {
  readonly skillMounts: readonly SandboxSkillMount[];
  readonly cliTools: readonly SandboxCliTool[];
  readonly nixProfile?: SandboxNixProfile;
}

export const EMPTY_SANDBOX_RUN_EXTENSIONS: SandboxRunExtensions = {
  skillMounts: [],
  cliTools: [],
};

export function assertValidRunExtensions(
  extensions: SandboxRunExtensions,
): void {
  assertUnique(
    extensions.skillMounts.map((skill) => skill.name),
    "skill mount",
  );
  assertUnique(
    extensions.skillMounts.map((skill) => skill.mountPath),
    "skill mount path",
  );
  for (const skill of extensions.skillMounts) {
    if (!skill.readOnly) {
      throw new Error(`skill mount must be read-only: ${skill.name}`);
    }
    if (!skill.mountPath.startsWith("/colony/skills/")) {
      throw new Error(
        `skill mount must live under /colony/skills: ${skill.name}`,
      );
    }
  }

  assertUnique(
    extensions.cliTools.map((tool) => tool.name),
    "CLI tool",
  );
  assertUnique(
    extensions.cliTools.map((tool) => tool.executable),
    "CLI executable",
  );
  for (const tool of extensions.cliTools) {
    if (!tool.name.trim()) {
      throw new Error("CLI tool name is required");
    }
    if (!tool.executable.trim()) {
      throw new Error(`CLI tool executable is required: ${tool.name}`);
    }
    if (!tool.requiredCapabilities.includes("tool.cli.execute")) {
      throw new Error(
        `CLI tool must require tool.cli.execute capability: ${tool.name}`,
      );
    }
    if (tool.packageRef && tool.packageRef.trim() !== tool.packageRef) {
      throw new Error(`CLI tool package ref must be normalized: ${tool.name}`);
    }
  }

  if (extensions.nixProfile) {
    if (
      !extensions.nixProfile.profileHash &&
      extensions.nixProfile.packages.length === 0
    ) {
      throw new Error("Nix profile requires packages or a resolved hash");
    }
    assertUnique(
      extensions.nixProfile.packages.map((pkg) => pkg.name),
      "Nix package",
    );
    for (const pkg of extensions.nixProfile.packages) {
      if (!pkg.name.trim() || !pkg.ref.trim()) {
        throw new Error("Nix package name and ref are required");
      }
    }
  }
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}
