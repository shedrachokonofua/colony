import { createHash } from "node:crypto";
import {
  type SandboxCliTool,
  type SandboxNixPackage,
  type SandboxRunExtensions,
  assertValidRunExtensions,
} from "@colony/sandbox";

export interface MaterializedCliTool {
  readonly name: string;
  readonly executable: string;
  readonly resolver: SandboxCliTool["resolver"];
  readonly packageRef?: string;
  readonly pathEntry: string;
  readonly version?: string;
}

export interface SandboxToolProfileManifest {
  readonly resolver: "nix" | "fallback";
  readonly flakeRef?: string;
  readonly profileHash: string;
  readonly packages: readonly SandboxNixPackage[];
  readonly tools: readonly MaterializedCliTool[];
}

export interface PreparedSandboxToolEnvironment {
  readonly pathEntries: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly manifest: SandboxToolProfileManifest;
}

export interface NixProfileResolver {
  readonly kind: "nix";
  resolveProfile(
    input: NixProfileResolveInput,
  ): Promise<ResolvedSandboxToolProfile> | ResolvedSandboxToolProfile;
}

export interface FallbackToolResolver {
  readonly kind: "fallback";
  resolveTools(
    input: FallbackToolResolveInput,
  ): Promise<ResolvedSandboxToolProfile> | ResolvedSandboxToolProfile;
}

export type SandboxToolMaterializer = NixProfileResolver | FallbackToolResolver;

export interface NixProfileResolveInput {
  readonly flakeRef?: string;
  readonly packages: readonly SandboxNixPackage[];
  readonly expectedProfileHash: string;
  readonly tools: readonly SandboxCliTool[];
}

export interface FallbackToolResolveInput {
  readonly tools: readonly SandboxCliTool[];
  readonly expectedProfileHash: string;
}

export interface ResolvedSandboxToolProfile {
  readonly pathEntries: readonly string[];
  readonly profileHash?: string;
  readonly toolVersions?: Readonly<Record<string, string>>;
}

export async function prepareSandboxToolEnvironment(
  extensions: SandboxRunExtensions,
  materializer: SandboxToolMaterializer,
): Promise<PreparedSandboxToolEnvironment> {
  assertValidRunExtensions(extensions);
  const packages = profilePackages(extensions);

  const expectedProfileHash =
    extensions.nixProfile?.profileHash ??
    hashProfile(extensions.nixProfile?.flakeRef, packages, extensions.cliTools);

  const resolved =
    materializer.kind === "nix"
      ? await materializer.resolveProfile({
          flakeRef: extensions.nixProfile?.flakeRef,
          packages,
          expectedProfileHash,
          tools: extensions.cliTools,
        })
      : await materializer.resolveTools({
          tools: extensions.cliTools,
          expectedProfileHash,
        });

  if (resolved.pathEntries.length === 0 && extensions.cliTools.length > 0) {
    throw new Error("sandbox tool materializer returned no PATH entries");
  }

  const manifest: SandboxToolProfileManifest = {
    resolver: materializer.kind === "nix" ? "nix" : "fallback",
    flakeRef: extensions.nixProfile?.flakeRef,
    profileHash: resolved.profileHash ?? expectedProfileHash,
    packages,
    tools: extensions.cliTools.map((tool) => ({
      name: tool.name,
      executable: tool.executable,
      resolver: tool.resolver,
      packageRef: tool.packageRef,
      pathEntry: resolved.pathEntries[0] ?? "",
      version: resolved.toolVersions?.[tool.name],
    })),
  };

  return {
    pathEntries: resolved.pathEntries,
    env: {
      PATH: `${resolved.pathEntries.join(":")}:$PATH`,
    },
    manifest,
  };
}

export function hashProfile(
  flakeRef: string | undefined,
  packages: readonly SandboxNixPackage[],
  cliTools: readonly SandboxCliTool[],
): string {
  const payload = JSON.stringify({
    flakeRef,
    packages: [...packages].sort((a, b) => a.name.localeCompare(b.name)),
    cliTools: [...cliTools]
      .map((tool) => ({
        name: tool.name,
        executable: tool.executable,
        packageRef: tool.packageRef,
        resolver: tool.resolver,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function profilePackages(
  extensions: SandboxRunExtensions,
): readonly SandboxNixPackage[] {
  if (extensions.nixProfile && extensions.nixProfile.packages.length > 0) {
    return extensions.nixProfile.packages;
  }
  return packagesFromCliTools(extensions.cliTools);
}

function packagesFromCliTools(
  cliTools: readonly SandboxCliTool[],
): readonly SandboxNixPackage[] {
  return cliTools
    .filter((tool) => tool.resolver === "nix" && tool.packageRef)
    .map((tool) => ({
      name: tool.name,
      ref: tool.packageRef ?? tool.name,
    }));
}
