import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionRepoWorkspace } from "./pi-runner-common.js";

const IDENTITY_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;
const saved = Object.fromEntries(
  IDENTITY_KEYS.map((key) => [key, process.env[key]]),
);
const dirs: string[] = [];

afterEach(() => {
  for (const key of IDENTITY_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function originRepo(): { url: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "workspace-identity-"));
  dirs.push(root);
  const origin = join(root, "origin");
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  execFileSync(
    "git",
    ["-C", origin, "commit", "-q", "--allow-empty", "-m", "init"],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Someone Else",
        GIT_AUTHOR_EMAIL: "someone@example.com",
        GIT_COMMITTER_NAME: "Someone Else",
        GIT_COMMITTER_EMAIL: "someone@example.com",
      },
    },
  );
  const sha = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  return { url: origin, sha };
}

describe("repo workspace commit identity", () => {
  it("commits in a provisioned workspace under the identity colonyd acts as", () => {
    const { url, sha } = originRepo();
    process.env["GIT_AUTHOR_NAME"] = "Colony";
    process.env["GIT_AUTHOR_EMAIL"] = "colony-bot@shdr.ch";
    const ws = provisionRepoWorkspace(
      `run-identity-${Date.now()}`,
      { repo: { url, branch: "colony/x", base_commit: sha } } as never,
      {},
    );
    dirs.push(ws);
    // An agent's shell does not inherit colonyd's environment (and git
    // exports GIT_AUTHOR_* to hooks, so the test runner's may be set).
    const agentEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !(IDENTITY_KEYS as readonly string[]).includes(key),
      ),
    );
    writeFileSync(join(ws, "change.txt"), "change\n");
    execFileSync("git", ["-C", ws, "add", "change.txt"], { env: agentEnv });
    execFileSync("git", ["-C", ws, "commit", "-q", "-m", "change"], {
      env: agentEnv,
    });
    const identity = execFileSync(
      "git",
      ["-C", ws, "log", "-1", "--format=%an <%ae>|%cn <%ce>"],
      { encoding: "utf8" },
    ).trim();
    expect(identity).toBe(
      "Colony <colony-bot@shdr.ch>|Colony <colony-bot@shdr.ch>",
    );
  });
});
