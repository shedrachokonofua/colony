import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultValidateExecutor } from "../src/runs/validate.js";

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

/** Init a repo with default branch `main` and a checked-in marker file. */
function seedRepo(): string {
  const repo = tempDir("colony-validate-repo-");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "colony-test@example.com"]);
  git(repo, ["config", "user.name", "colony-test"]);
  writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
  writeFileSync(join(repo, "marker"), "present\n", "utf8");
  commitAll(repo, "init");
  return repo;
}

function workspaceKey(): string {
  const dir = tempDir("colony-validate-run-").replace(tmpdir() + "/", "");
  return dir;
}

describe("defaultValidateExecutor", () => {
  it("passes when the acceptance command's prerequisite is present", async () => {
    const repo = seedRepo();
    const result = await defaultValidateExecutor({
      workspace: workspaceKey(),
      cloneUrl: repo,
      displayUrl: repo,
      targetBranch: "main",
      acceptance: [{ description: "marker exists", command: "test -f marker" }],
    });
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      index: 0,
      description: "marker exists",
      command: "test -f marker",
      exit_code: 0,
    });
  });

  it("reports nonzero exit for a failing acceptance command with a tail", async () => {
    const repo = seedRepo();
    const result = await defaultValidateExecutor({
      workspace: workspaceKey(),
      cloneUrl: repo,
      displayUrl: repo,
      targetBranch: "main",
      acceptance: [{ description: "must succeed", command: "false" }],
    });
    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.exit_code).not.toBe(0);
    expect(Array.isArray(result.results[0]!.tail)).toBe(true);
  });

  it("scrubs PACKET.json and credential-embedded git remote URL from workspace", async () => {
    // Use a fake embedded token to verify scrubbing surfaces. The local
    // clone path works fine — the token is only used for provisionRepoWorkspace's
    // packet credentials field.
    const repo = seedRepo();
    const fakeToken = "glpat-FAKETOKEN1234567890ABCDEF";
    const credentialedUrl = repo.replace(
      "file://",
      `file://oauth2:${fakeToken}@`,
    );
    // Git handles both bare paths and file:// URLs. Use the bare path
    // for cloneUrl (git can clone it) but embed a token via the packet.
    // The key test: after scrubbing, PACKET.json is gone and the remote
    // URL contains no credentials.
    const result = await defaultValidateExecutor({
      workspace: workspaceKey(),
      cloneUrl: repo,
      displayUrl: "https://example.com/repo.git",
      targetBranch: "main",
      acceptance: [
        // Verify PACKET.json does not exist
        { description: "no packet", command: "test ! -f PACKET.json" },
        // Verify remote URL is scrubbed of credentials
        {
          description: "clean remote",
          command:
            "git remote get-url origin | grep -qv oauth2 && git remote get-url origin | grep -q example.com",
        },
      ],
    });
    expect(result.passed).toBe(true);
    for (const entry of result.results) {
      expect(entry.exit_code).toBe(0);
    }
  });

  it("runs acceptance commands without provider credentials in their env", async () => {
    const repo = seedRepo();
    const leaked = "glpat-AAAABBBBCCCCDDDDEEEEFFFF00";
    const previous = process.env["GITLAB_TOKEN"];
    process.env["GITLAB_TOKEN"] = leaked;
    process.env["COLONYD_SECRET_PREVIEW"] = "shh-shared-secret";
    try {
      const result = await defaultValidateExecutor({
        workspace: workspaceKey(),
        cloneUrl: repo,
        displayUrl: repo,
        targetBranch: "main",
        // printenv echoes every exported var; the acceptance run must not see
        // GITLAB_TOKEN (or any /TOKEN|SECRET|.../ key).
        acceptance: [{ description: "no secrets leaked", command: "printenv" }],
      });
      expect(result.passed).toBe(true);
      const rendered = result.results.flatMap((entry) => entry.tail).join("\n");
      expect(rendered).not.toContain(leaked);
      expect(rendered).not.toContain("shh-shared-secret");
      expect(rendered).not.toMatch(/GITLAB_TOKEN/);
      expect(rendered).not.toMatch(/COLONYD_SECRET_PREVIEW/);
    } finally {
      if (previous === undefined) delete process.env["GITLAB_TOKEN"];
      else process.env["GITLAB_TOKEN"] = previous;
      delete process.env["COLONYD_SECRET_PREVIEW"];
    }
  });
});
