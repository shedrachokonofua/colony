/**
 * Project skills (docs/designs/001-project-skills.md): resolve a project's
 * declared skill sources to pinned commits, read the matching SKILL.md
 * directories, and attach them to a run packet. The runner materializes
 * them into `.colony/skills/project/<name>/` and every role sees the
 * listing in the packet body.
 *
 * Declared skills are operator intent: any resolution failure throws, and the
 * caller fails the run rather than dispatching agents with a partial set.
 */
import { execFile } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { discoverSkillRegistry } from "@colony/agent-runtime";
import type { ProjectSkillSource, Store } from "@colony/core";

const execFileAsync = promisify(execFile);

export const MAX_SKILL_SOURCES = 8;
export const MAX_SKILL_PATHS = 32;
export const MAX_SKILLS = 32;
export const MAX_SKILL_FILE_BYTES = 262_144;
export const MAX_SKILLS_TOTAL_BYTES = 2_097_152;
export const MAX_FILES_PER_SKILL = 16;
/** Built-in playbook stems share the `.colony/skills/` namespace. */
const RESERVED_SKILL_NAMES: Record<string, true> = {
  debugging: true,
  design: true,
  "code-review": true,
  "task-specs": true,
  "clean-code": true,
  project: true,
};

export interface PacketProjectSkillFile {
  path: string;
  byte_size: number;
}

export interface PacketProjectSkill {
  name: string;
  description: string;
  hash: string;
  source: string;
  path: string;
  files: readonly PacketProjectSkillFile[];
}

export interface ResolvedSkillSource {
  repo_path: string;
  ref: string;
  resolved_sha: string;
  skills: readonly { name: string; hash: string; bytes: number }[];
}

export interface ResolvedProjectSkills {
  sources: readonly ResolvedSkillSource[];
  skills: readonly PacketProjectSkill[];
}

export interface SkillSourceAccess {
  /** ref -> full commit SHA (provider `commits.get`). */
  pin(repoPath: string, ref: string): Promise<string>;
  /** Local directory holding the repository tree at `sha` (read-only use). */
  checkout(repoPath: string, sha: string): Promise<string>;
}

/** Validates a declaration; returns the first problem or null. */
export function validateSkillSources(value: unknown): string | null {
  if (!Array.isArray(value)) return "skill_sources must be an array";
  if (value.length > MAX_SKILL_SOURCES)
    return `at most ${MAX_SKILL_SOURCES} skill sources`;
  let pathCount = 0;
  for (const [i, source] of value.entries()) {
    if (!source || typeof source !== "object" || Array.isArray(source))
      return `skill_sources[${i}] must be an object`;
    const keys = Object.keys(source);
    const extra = keys.filter(
      (k) => !["repo_path", "ref", "paths"].includes(k),
    );
    if (extra.length)
      return `skill_sources[${i}] has unknown keys: ${extra.join(", ")}`;
    const { repo_path, ref, paths } = source as Record<string, unknown>;
    if (
      typeof repo_path !== "string" ||
      !/^[\w.-]+(\/[\w.-]+)+$/.test(repo_path)
    )
      return `skill_sources[${i}].repo_path must be a GitLab project path like group/repo`;
    if (typeof ref !== "string" || !ref.trim() || /\s|\.\./.test(ref))
      return `skill_sources[${i}].ref must be a branch, tag or commit SHA`;
    if (!Array.isArray(paths) || paths.length === 0)
      return `skill_sources[${i}].paths must be a non-empty array of globs`;
    for (const p of paths) {
      if (
        typeof p !== "string" ||
        !p.trim() ||
        p.startsWith("/") ||
        p.includes("..")
      )
        return `skill_sources[${i}].paths entries must be relative globs`;
    }
    pathCount += paths.length;
  }
  if (pathCount > MAX_SKILL_PATHS)
    return `at most ${MAX_SKILL_PATHS} paths in total`;
  return null;
}

/** Glob over a repo-relative directory path: `*` one segment, `**` any depth. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  const g = glob.replace(/\/+$/, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*" && g[i + 1] === "*") {
      out += ".*";
      i++;
      if (g[i + 1] === "/") i++;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export async function resolveProjectSkills(
  sources: readonly ProjectSkillSource[],
  access: SkillSourceAccess,
): Promise<ResolvedProjectSkills> {
  const resolvedSources: ResolvedSkillSource[] = [];
  const skills: PacketProjectSkill[] = [];
  const contents = new Map<string, string>();
  const seen = new Map<string, string>();
  let totalBytes = 0;

  for (const source of sources) {
    const label = `${source.repo_path}@${source.ref}`;
    let sha: string;
    try {
      sha = /^[0-9a-f]{40}$/.test(source.ref)
        ? source.ref
        : await access.pin(source.repo_path, source.ref);
    } catch (err) {
      throw new Error(
        `project skills: cannot resolve ${label}: ${message(err)}`,
      );
    }
    const root = await access.checkout(source.repo_path, sha);
    const registry = await discoverSkillRegistry({ sourcePaths: [root] });
    const matchers = source.paths.map(globToRegExp);
    const picked = registry.filter((entry) => {
      const rel = relative(root, join(entry.contentPath, ".."));
      return matchers.some((m) => m.test(rel));
    });
    for (const [i, glob] of source.paths.entries()) {
      if (
        !registry.some((e) =>
          matchers[i]!.test(relative(root, join(e.contentPath, ".."))),
        )
      )
        throw new Error(
          `project skills: ${label} path "${glob}" matched no SKILL.md directory`,
        );
    }

    const sourceSkills: { name: string; hash: string; bytes: number }[] = [];
    for (const entry of picked) {
      if (RESERVED_SKILL_NAMES[entry.name])
        throw new Error(
          `project skills: skill "${entry.name}" collides with a built-in playbook`,
        );
      const prior = seen.get(entry.name);
      if (prior)
        throw new Error(
          `project skills: skill "${entry.name}" defined by both ${prior} and ${label}`,
        );
      seen.set(entry.name, label);

      const skillDir = join(entry.contentPath, "..");
      const files = await listFiles(skillDir);
      if (files.length > MAX_FILES_PER_SKILL)
        throw new Error(
          `project skills: "${entry.name}" has ${files.length} files (max ${MAX_FILES_PER_SKILL})`,
        );
      const packetFiles: PacketProjectSkillFile[] = [];
      let bytes = 0;
      for (const rel of files) {
        const content = await readFile(join(skillDir, rel), "utf8");
        const size = Buffer.byteLength(content);
        if (size > MAX_SKILL_FILE_BYTES)
          throw new Error(
            `project skills: "${entry.name}/${rel}" is ${size} bytes (max ${MAX_SKILL_FILE_BYTES})`,
          );
        bytes += size;
        const file: PacketProjectSkillFile & { content?: string } = {
          path: rel,
          byte_size: size,
        };
        // Content reaches the workspace but never PACKET.json (same rule as
        // project reference files): non-enumerable.
        Object.defineProperty(file, "content", {
          value: content,
          enumerable: false,
          writable: true,
          configurable: true,
        });
        contents.set(`${entry.name}/${rel}`, content);
        packetFiles.push(file);
      }
      totalBytes += bytes;
      if (totalBytes > MAX_SKILLS_TOTAL_BYTES)
        throw new Error(
          `project skills exceed ${MAX_SKILLS_TOTAL_BYTES} bytes in total`,
        );
      skills.push({
        name: entry.name,
        description: (entry.description ?? "").slice(0, 300),
        hash: entry.hash,
        source: `${source.repo_path}@${sha.slice(0, 12)}`,
        path: `.colony/skills/project/${entry.name}`,
        files: packetFiles,
      });
      sourceSkills.push({ name: entry.name, hash: entry.hash, bytes });
    }
    resolvedSources.push({
      repo_path: source.repo_path,
      ref: source.ref,
      resolved_sha: sha,
      skills: sourceSkills,
    });
  }
  if (skills.length > MAX_SKILLS)
    throw new Error(
      `project skills: ${skills.length} skills (max ${MAX_SKILLS})`,
    );
  return { sources: resolvedSources, skills };
}

/**
 * Resolve the project's declared skills for one run, record the pinned
 * evidence as a `skills_resolved` run event, and attach them to the packet.
 * No declaration = no-op. Throws on any resolution failure so the caller
 * fails the run (declared skills are operator intent).
 */
export async function attachSkillsForRun<
  P extends { body?: unknown; project?: unknown },
>(
  ctx: { readonly store: Store; readonly skillAccess?: SkillSourceAccess },
  runId: string,
  projectName: string | null,
  packet: P,
): Promise<P> {
  if (!projectName) return packet;
  const sources = ctx.store.getProjectSkillSources(projectName);
  if (sources.length === 0) return packet;
  if (!ctx.skillAccess)
    throw new Error(
      "project skills declared but colonyd has no skill source access configured",
    );
  const resolved = await resolveProjectSkills(sources, ctx.skillAccess);
  ctx.store.appendRunEvent(runId, "skills_resolved", {
    sources: resolved.sources,
  });
  return attachProjectSkills(packet, resolved, projectName);
}

/** Prompt section listing project skills, read on demand. */
export function projectSkillsSection(
  skills: readonly PacketProjectSkill[],
): string {
  if (skills.length === 0) return "";
  const rows = skills.map(
    (s) =>
      `- \`${s.path}/SKILL.md\` (${s.name}) — ${s.description || "read before related work"}`,
  );
  return [
    "## Project skills (read the matching SKILL.md before the work it describes)",
    "These are this project's authoritative conventions. Each skill's sibling files are in the same directory.",
    ...rows,
    "",
  ].join("\n");
}

/**
 * Attach resolved skills to a built packet: manifest on `packet.project.skills`
 * and the listing appended to `packet.body`. Mutates and returns the packet.
 */
export function attachProjectSkills<
  P extends { body?: unknown; project?: unknown },
>(packet: P, resolved: ResolvedProjectSkills, projectName: string): P {
  if (resolved.skills.length === 0) return packet;
  const record = packet as Record<string, unknown>;
  const project =
    record["project"] && typeof record["project"] === "object"
      ? (record["project"] as Record<string, unknown>)
      : { name: projectName, context_doc: "", files: [] };
  project["skills"] = resolved.skills;
  record["project"] = project;
  const body = typeof record["body"] === "string" ? record["body"] : "";
  record["body"] = [body, projectSkillsSection(resolved.skills)]
    .filter(Boolean)
    .join("\n");
  return packet;
}

/**
 * Git-backed access: pins through the provider, checks out into a SHA-keyed
 * cache (immutable per SHA, so a hit needs no network). The token is used
 * only in the child process URL and never stored or logged.
 */
export function gitSkillSourceAccess(opts: {
  readonly cacheDir: string;
  readonly gitlabBaseUrl: string;
  readonly token: string;
  readonly pin: (repoPath: string, ref: string) => Promise<string>;
}): SkillSourceAccess {
  return {
    pin: opts.pin,
    async checkout(repoPath, sha) {
      const dir = join(opts.cacheDir, repoPath.replace(/\//g, "__"), sha);
      const done = await stat(join(dir, ".done")).catch(() => null);
      if (done) return dir;
      const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      const url = new URL(
        `${opts.gitlabBaseUrl.replace(/\/+$/, "")}/${repoPath}.git`,
      );
      if (opts.token) {
        url.username = "oauth2";
        url.password = opts.token;
      }
      const git = (...args: string[]) =>
        execFileAsync("git", args, { cwd: tmp, timeout: 120_000 });
      try {
        await git("init", "-q");
        await git("fetch", "-q", "--depth", "1", url.toString(), sha);
        await git("checkout", "-q", "FETCH_HEAD");
      } catch (err) {
        await rm(tmp, { recursive: true, force: true });
        const redacted = message(err)
          .split(opts.token || "\u0000")
          .join("***");
        throw new Error(
          `cannot fetch ${repoPath}@${sha.slice(0, 12)}: ${redacted}`,
        );
      }
      await rm(join(tmp, ".git"), { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
      await rename(tmp, dir);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, ".done"), sha);
      return dir;
    },
  };
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const child of await readdir(join(dir, prefix), {
    withFileTypes: true,
  })) {
    if (child.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (child.isFile()) out.push(rel);
  }
  return out.sort();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
