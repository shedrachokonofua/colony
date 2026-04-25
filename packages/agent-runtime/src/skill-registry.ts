import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { SandboxSkillMount } from "./run-extensions.js";

export interface SkillRegistryEntry {
  readonly name: string;
  readonly description?: string;
  readonly source: string;
  readonly hash: string;
  readonly mountPath: string;
  readonly contentPath: string;
}

export interface DiscoverSkillRegistryOptions {
  readonly sourcePaths: readonly string[];
  readonly mountRoot?: string;
}

export async function discoverSkillRegistry(
  options: DiscoverSkillRegistryOptions,
): Promise<ReadonlyArray<SkillRegistryEntry>> {
  const mountRoot = options.mountRoot ?? "/colony/skills";
  const entries: SkillRegistryEntry[] = [];

  for (const sourcePath of options.sourcePaths) {
    const root = resolve(sourcePath);
    for (const skillDir of await findSkillDirs(root)) {
      const contentPath = join(skillDir, "SKILL.md");
      const content = await readFile(contentPath, "utf8");
      const metadata = parseSkillMetadata(content, basename(skillDir));
      entries.push({
        name: metadata.name,
        description: metadata.description,
        source: root,
        hash: sha256(content),
        mountPath: `${mountRoot}/${metadata.name}`,
        contentPath,
      });
    }
  }

  assertUnique(
    entries.map((entry) => entry.name),
    "skill name",
  );
  assertUnique(
    entries.map((entry) => entry.mountPath),
    "skill mount path",
  );
  return entries;
}

export function selectSkillMounts(
  registry: readonly SkillRegistryEntry[],
  names: readonly string[],
): readonly SandboxSkillMount[] {
  const byName = new Map(registry.map((entry) => [entry.name, entry]));
  return names.map((name) => {
    const entry = byName.get(name);
    if (!entry) {
      throw new Error(`unknown skill: ${name}`);
    }
    return {
      name: entry.name,
      description: entry.description,
      source: entry.source,
      hash: entry.hash,
      mountPath: entry.mountPath,
      readOnly: true,
    };
  });
}

async function findSkillDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (!dir) continue;
    let children: Dirent[];
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (children.some((child) => child.isFile() && child.name === "SKILL.md")) {
      found.push(dir);
      continue;
    }
    for (const child of children) {
      if (child.isDirectory() && !child.name.startsWith(".")) {
        queue.push(join(dir, child.name));
      }
    }
  }
  return found.sort();
}

function parseSkillMetadata(
  content: string,
  fallbackName: string,
): { readonly name: string; readonly description?: string } {
  const name =
    matchFrontmatter(content, "name") ??
    matchHeadingName(content) ??
    fallbackName;
  const description =
    matchFrontmatter(content, "description") ?? matchFirstParagraph(content);
  return { name: slugName(name), description };
}

function matchFrontmatter(content: string, key: string): string | undefined {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter?.[1]) return undefined;
  const line = frontmatter[1]
    .split("\n")
    .find((candidate) => candidate.startsWith(`${key}:`));
  return line
    ?.slice(key.length + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
}

function matchHeadingName(content: string): string | undefined {
  const heading = content.match(/^#\s+(.+)$/m);
  return heading?.[1]?.trim();
}

function matchFirstParagraph(content: string): string | undefined {
  const body = content.replace(/^---\n[\s\S]*?\n---/, "").trim();
  const paragraph = body
    .split(/\n\s*\n/)
    .find((block) => !block.trim().startsWith("#"));
  return paragraph?.replace(/\s+/g, " ").trim();
}

function slugName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error("skill name cannot be empty");
  }
  return slug;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
