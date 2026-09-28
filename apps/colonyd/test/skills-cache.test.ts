import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { gitSkillSourceAccess } from "../src/runs/skills.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A bare repo at <root>/group/meta.git holding one skill; returns its HEAD. */
function seedRepo(root: string): string {
  const work = join(root, "work");
  mkdirSync(join(work, "s30-secrets"), { recursive: true });
  writeFileSync(
    join(work, "s30-secrets", "SKILL.md"),
    "---\nname: s30-secrets\n---\n",
  );
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git(work, "init", "-q");
  git(work, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git(
    work,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "skills",
  );
  mkdirSync(join(root, "group"), { recursive: true });
  git(root, "clone", "-q", "--bare", work, join(root, "group", "meta.git"));
  // Serve by SHA over the file transport, as GitLab does over HTTPS.
  git(
    join(root, "group", "meta.git"),
    "config",
    "uploadpack.allowAnySHA1InWant",
    "true",
  );
  return git(work, "rev-parse", "HEAD");
}

describe("gitSkillSourceAccess checkout", () => {
  it("never replaces a checkout another run is already reading", async () => {
    const root = mkdtempSync(join(tmpdir(), "colony-skills-cache-"));
    dirs.push(root);
    const sha = seedRepo(root);
    const access = gitSkillSourceAccess({
      cacheDir: join(root, "cache"),
      gitlabBaseUrl: `file://${root}`,
      token: "",
      pin: async () => sha,
    });

    // Two architect runs pin the same new meta SHA at once; both miss the
    // cache. The first to finish hands its directory to a run that reads
    // skill files from it while the second checkout is still in flight.
    const first = access.checkout("group/meta", sha);
    const second = access.checkout("group/meta", sha);
    const firstDir = await first;
    const readingIno = statSync(join(firstDir, "s30-secrets", "SKILL.md")).ino;
    const secondDir = await second;

    expect(secondDir).toBe(firstDir);
    // Same file the first run is reading: not deleted and re-created.
    expect(statSync(join(secondDir, "s30-secrets", "SKILL.md")).ino).toBe(
      readingIno,
    );
  });

  it("serves a completed checkout from cache", async () => {
    const root = mkdtempSync(join(tmpdir(), "colony-skills-cache-"));
    dirs.push(root);
    const sha = seedRepo(root);
    const access = gitSkillSourceAccess({
      cacheDir: join(root, "cache"),
      gitlabBaseUrl: `file://${root}`,
      token: "",
      pin: async () => sha,
    });
    const dir = await access.checkout("group/meta", sha);
    rmSync(join(root, "group"), { recursive: true, force: true });
    expect(await access.checkout("group/meta", sha)).toBe(dir);
  });
});
