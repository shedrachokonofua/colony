import { posix } from "node:path";

/**
 * Dependency diff policy for the merge gate. `--frozen-lockfile` proves a
 * lockfile is consistent, not that what it resolves is sane: an autonomous
 * implementer can add a typosquat, a git dependency, or a package from an
 * attacker-chosen registry, and CI then installs it with deploy credentials
 * in reach. This pass reads the incoming diff (target vs head) and
 * - records every new or changed direct dependency (gate evidence), and
 * - rejects anything that resolves outside the configured registry hosts,
 *   git/URL dependencies, path dependencies that leave the repository, and
 *   new `trustedDependencies` (they re-enable install scripts).
 */

export interface DependencyChange {
  readonly manifest: string;
  readonly section: string;
  readonly name: string;
  readonly spec: string;
  /** Spec on the target branch; absent for a new dependency. */
  readonly previous?: string;
}

export interface DependencyViolation {
  readonly file: string;
  readonly package?: string;
  readonly detail: string;
}

export interface DependencyReview {
  readonly changes: readonly DependencyChange[];
  readonly violations: readonly DependencyViolation[];
}

/** File contents at the gate's two sides; null when the file is absent. */
export type ReadAtRef = (
  side: "target" | "head",
  path: string,
) => Promise<string | null>;

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** Evidence bound: a pathological diff must not bloat the run row. */
const MAX_REPORTED = 50;

const REGISTRY_CONFIG_FILES = new Set([".npmrc", "bunfig.toml", ".yarnrc.yml"]);
const TEXT_LOCKFILES = new Set(["yarn.lock", "pnpm-lock.yaml"]);

export async function reviewDependencyChanges(input: {
  readonly changedFiles: readonly string[];
  readonly readAt: ReadAtRef;
  readonly registryHosts: readonly string[];
}): Promise<DependencyReview> {
  const allowed = new Set(input.registryHosts.map((h) => h.toLowerCase()));
  const changes: DependencyChange[] = [];
  const violations: DependencyViolation[] = [];

  for (const file of input.changedFiles) {
    if (file.split("/").includes("node_modules")) continue;
    const name = posix.basename(file);
    if (name === "package.json") {
      await reviewManifest(file, input.readAt, allowed, changes, violations);
    } else if (name === "bun.lock") {
      await reviewBunLock(file, input.readAt, allowed, violations);
    } else if (name === "package-lock.json") {
      await reviewNpmLock(file, input.readAt, allowed, violations);
    } else if (REGISTRY_CONFIG_FILES.has(name) || TEXT_LOCKFILES.has(name)) {
      await reviewNewHosts(file, input.readAt, allowed, violations);
    }
  }
  return {
    changes: changes.slice(0, MAX_REPORTED),
    violations: violations.slice(0, MAX_REPORTED),
  };
}

async function reviewManifest(
  file: string,
  readAt: ReadAtRef,
  allowed: ReadonlySet<string>,
  changes: DependencyChange[],
  violations: DependencyViolation[],
): Promise<void> {
  const head = parseJsonObject(await readAt("head", file));
  if (!head) return;
  const target = parseJsonObject(await readAt("target", file)) ?? {};
  for (const section of DEPENDENCY_SECTIONS) {
    const now = stringRecord(head[section]);
    const before = stringRecord(target[section]);
    for (const [pkg, spec] of Object.entries(now)) {
      const previous = before[pkg];
      if (previous === spec) continue;
      changes.push({
        manifest: file,
        section,
        name: pkg,
        spec,
        ...(previous === undefined ? {} : { previous }),
      });
      const problem = specProblem(file, spec, allowed);
      if (problem) violations.push({ file, package: pkg, detail: problem });
    }
  }
  const trustedBefore = new Set(stringArray(target.trustedDependencies));
  for (const pkg of stringArray(head.trustedDependencies)) {
    if (trustedBefore.has(pkg)) continue;
    violations.push({
      file,
      package: pkg,
      detail:
        "new trustedDependencies entry re-enables install scripts; only an operator may add one",
    });
  }
}

/**
 * Why a manifest spec does not resolve from an allowed registry, or null.
 * Registry ranges, dist-tags, `npm:` aliases and `workspace:` are fine.
 */
function specProblem(
  manifest: string,
  spec: string,
  allowed: ReadonlySet<string>,
): string | null {
  const value = spec.trim();
  if (value.startsWith("workspace:")) return null;
  if (value.startsWith("npm:")) return null;
  if (/^(?:file|link|portal):/.test(value)) {
    const target = value.replace(/^(?:file|link|portal):/, "");
    return pathLeavesRepository(manifest, target)
      ? `path dependency ${value} points outside the repository`
      : null;
  }
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:|gist:)/.test(value)) {
    return `git dependency ${value}; depend on a published registry version`;
  }
  if (/^https?:\/\//.test(value)) {
    const host = hostOf(value);
    return host && allowed.has(host)
      ? null
      : `tarball dependency from ${host ?? value}, which is not an allowed registry`;
  }
  // `owner/repo` (optionally `#ref`) is npm's GitHub shorthand.
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(value)) {
    return `GitHub shorthand dependency ${value}; depend on a published registry version`;
  }
  return null;
}

function pathLeavesRepository(manifest: string, target: string): boolean {
  if (posix.isAbsolute(target) || target.startsWith("~")) return true;
  const resolved = posix.normalize(posix.join(posix.dirname(manifest), target));
  return resolved === ".." || resolved.startsWith("../");
}

async function reviewBunLock(
  file: string,
  readAt: ReadAtRef,
  allowed: ReadonlySet<string>,
  violations: DependencyViolation[],
): Promise<void> {
  const head = parseJsonObject(await readAt("head", file), true);
  if (!head) {
    violations.push({ file, detail: "bun.lock is not parseable" });
    return;
  }
  const target = parseJsonObject(await readAt("target", file), true) ?? {};
  const before = objectRecord(target.packages);
  for (const [key, entry] of Object.entries(objectRecord(head.packages))) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    if (JSON.stringify(before[key]) === JSON.stringify(entry)) continue;
    const resolution = entry[0];
    const spec = resolution.slice(resolution.lastIndexOf("@") + 1);
    const problem = lockResolutionProblem(spec, allowed);
    if (problem) {
      violations.push({ file, package: key, detail: problem });
      continue;
    }
    const source = typeof entry[1] === "string" ? entry[1] : "";
    if (/^https?:\/\//.test(source)) {
      const host = hostOf(source);
      if (!host || !allowed.has(host)) {
        violations.push({
          file,
          package: key,
          detail: `resolves from ${host ?? source}, which is not an allowed registry`,
        });
      }
    }
  }
}

/** Lockfile resolutions that never come from a registry. */
function lockResolutionProblem(
  spec: string,
  allowed: ReadonlySet<string>,
): string | null {
  if (spec.startsWith("workspace:")) return null;
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:)/.test(spec)) {
    return `git resolution ${spec}`;
  }
  if (/^https?:\/\//.test(spec)) {
    const host = hostOf(spec);
    return host && allowed.has(host)
      ? null
      : `tarball resolution from ${host ?? spec}, which is not an allowed registry`;
  }
  return null;
}

async function reviewNpmLock(
  file: string,
  readAt: ReadAtRef,
  allowed: ReadonlySet<string>,
  violations: DependencyViolation[],
): Promise<void> {
  const head = parseJsonObject(await readAt("head", file));
  if (!head) {
    violations.push({ file, detail: "package-lock.json is not parseable" });
    return;
  }
  const target = parseJsonObject(await readAt("target", file)) ?? {};
  const before = objectRecord(target.packages);
  for (const [key, entry] of Object.entries(objectRecord(head.packages))) {
    if (!entry || typeof entry !== "object") continue;
    if (JSON.stringify(before[key]) === JSON.stringify(entry)) continue;
    const resolved = (entry as { resolved?: unknown }).resolved;
    if (typeof resolved !== "string") continue;
    if ((entry as { link?: unknown }).link === true) continue;
    if (/^https?:\/\//.test(resolved)) {
      const host = hostOf(resolved);
      if (!host || !allowed.has(host)) {
        violations.push({
          file,
          package: key,
          detail: `resolves from ${host ?? resolved}, which is not an allowed registry`,
        });
      }
    } else if (!resolved.startsWith("file:")) {
      violations.push({
        file,
        package: key,
        detail: `non-registry resolution ${resolved}`,
      });
    }
  }
}

/** Registry configuration and text lockfiles: any newly named host. */
async function reviewNewHosts(
  file: string,
  readAt: ReadAtRef,
  allowed: ReadonlySet<string>,
  violations: DependencyViolation[],
): Promise<void> {
  const head = await readAt("head", file);
  if (head === null) return;
  const before = new Set(hostsIn((await readAt("target", file)) ?? ""));
  for (const host of new Set(hostsIn(head))) {
    if (before.has(host) || allowed.has(host)) continue;
    violations.push({
      file,
      detail: `names registry host ${host}, which is not an allowed registry`,
    });
  }
}

function hostsIn(text: string): string[] {
  return [...text.matchAll(/(?:https?:)?\/\/([a-z0-9][a-z0-9.-]*[a-z0-9])/gi)]
    .map((m) => m[1]!.toLowerCase())
    .filter((host) => host.includes("."));
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function parseJsonObject(
  text: string | null,
  trailingCommas = false,
): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(
      trailingCommas ? stripTrailingCommas(text) : text,
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * bun.lock is JSON with trailing commas. Drop a comma when the next
 * non-whitespace character closes an object or array, outside strings.
 */
export function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}
