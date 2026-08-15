import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultGateExecutor } from "../src/runs/merge-gate.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "colony-test",
      GIT_AUTHOR_EMAIL: "colony-test@example.com",
      GIT_COMMITTER_NAME: "colony-test",
      GIT_COMMITTER_EMAIL: "colony-test@example.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", message]);
}

function seedRepo(): { repo: string; leakSha: string; cleanSha: string } {
  const repo = tempDir("colony-gate-repo-");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "colony-test@example.com"]);
  git(repo, ["config", "user.name", "colony-test"]);
  writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
  commitAll(repo, "init");

  git(repo, ["checkout", "-b", "leak"]);
  writeFileSync(
    join(repo, "credentials.txt"),
    "glpat-AAAABBBBCCCCDDDDEEEEFFFF\n",
    "utf8",
  );
  commitAll(repo, "add leaked token");
  const leakSha = git(repo, ["rev-parse", "HEAD"]).trim();

  git(repo, ["checkout", "main"]);
  git(repo, ["checkout", "-b", "clean"]);
  writeFileSync(join(repo, "note.txt"), "harmless\n", "utf8");
  commitAll(repo, "add harmless file");
  const cleanSha = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["checkout", "main"]);
  return { repo, leakSha, cleanSha };
}

describe("defaultGateExecutor secret scan", () => {
  it("rejects an incoming glpat token before merge", async () => {
    const { repo, leakSha } = seedRepo();
    const workspace = tempDir("colony-gate-ws-");
    mkdirSync(workspace, { recursive: true });
    rmSync(workspace, { recursive: true, force: true });
    const result = await defaultGateExecutor({
      workspace,
      cloneUrl: repo,
      displayUrl: repo,
      targetBranch: "main",
      taskBranch: "leak",
      headSha: leakSha,
    });
    expect(result?.reason).toBe("secret_scan");
  });

  it("allows a branch with no secret patterns", async () => {
    const { repo, cleanSha } = seedRepo();
    const workspace = tempDir("colony-gate-ws-");
    mkdirSync(workspace, { recursive: true });
    rmSync(workspace, { recursive: true, force: true });
    const result = await defaultGateExecutor({
      workspace,
      cloneUrl: repo,
      displayUrl: repo,
      targetBranch: "main",
      taskBranch: "clean",
      headSha: cleanSha,
    });
    expect(result).toBeNull();
  });
});
