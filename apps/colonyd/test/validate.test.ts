import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type {
  ExecEvent,
  ExecRequest,
  SandboxEngine,
  SandboxHandle,
  SandboxLaunchProfile,
} from "@colony/sandbox";
import { createInProcessEngine } from "@colony/sandbox-in-process";
import {
  defaultValidateExecutor,
  scrubWorkspaceCredentials,
} from "../src/runs/validate.js";

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
      engine: createInProcessEngine(),
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
      engine: createInProcessEngine(),
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

  it("surfaces failure-marker lines from the full output, not just the tail", async () => {
    const repo = seedRepo();
    // A bun-style run: two (fail) lines early, then more than MAX_TAIL_LINES
    // of (pass) noise so the tail alone would carry no failing name.
    const script = [
      'echo "(fail) store > adoption wins once [3.8ms]"',
      'echo "error: expect(received).toBe(expected)"',
      'for i in $(seq 1 60); do echo "(pass) noise $i"; done',
      'echo " 2 fail"',
      "exit 1",
    ].join("; ");
    const result = await defaultValidateExecutor({
      engine: createInProcessEngine(),
      workspace: workspaceKey(),
      cloneUrl: repo,
      displayUrl: repo,
      targetBranch: "main",
      acceptance: [{ description: "suite", command: script }],
    });
    const entry = result.results[0]!;
    expect(entry.exit_code).toBe(1);
    expect(entry.tail.some((line) => line.includes("(fail)"))).toBe(false);
    expect(entry.failures).toEqual([
      "(fail) store > adoption wins once [3.8ms]",
      "error: expect(received).toBe(expected)",
    ]);
  });

  it("scrubs PACKET.json and the credential-embedded git remote from a workspace", () => {
    // Direct unit test against a staged workspace: a clone whose origin
    // embeds a token and a PACKET.json carrying the same token — exactly
    // what provisionRepoWorkspace leaves behind for credentialed repos.
    // The token is joined at runtime so the merge gate's secret scanner
    // (which flags token-shaped literals on added diff lines) never
    // matches test fixtures.
    const token = ["glpat", "FAKETOKEN1234567890ABCDEF"].join("-");
    const displayUrl = "https://example.com/repo.git";
    const credentialedUrl = `https://oauth2:${token}@example.com/repo.git`;
    const workspace = tempDir("colony-scrub-");
    git(workspace, ["init", "--quiet"]);
    git(workspace, ["remote", "add", "origin", credentialedUrl]);
    writeFileSync(
      join(workspace, "PACKET.json"),
      JSON.stringify({
        repo: { url: credentialedUrl, credentials: { token } },
      }),
    );

    scrubWorkspaceCredentials(workspace, displayUrl);

    expect(existsSync(join(workspace, "PACKET.json"))).toBe(false);
    expect(git(workspace, ["remote", "get-url", "origin"]).trim()).toBe(
      displayUrl,
    );
    // The raw git config must contain neither the token nor its
    // URL-encoded form — assertions exactly as strong as the invariant.
    const rawConfig = readFileSync(join(workspace, ".git", "config"), "utf8");
    expect(rawConfig).not.toContain(token);
    expect(rawConfig).not.toContain(encodeURIComponent(token));
  });

  it("leaves acceptance commands no credential surfaces end to end", async () => {
    const repo = seedRepo();
    const result = await defaultValidateExecutor({
      engine: createInProcessEngine(),
      workspace: workspaceKey(),
      cloneUrl: repo,
      displayUrl: "https://example.com/repo.git",
      targetBranch: "main",
      acceptance: [
        { description: "no packet", command: "test ! -f PACKET.json" },
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
    // Runtime-joined for the same secret-scanner reason as above.
    const leaked = ["glpat", "AAAABBBBCCCCDDDDEEEEFFFF00"].join("-");
    const previous = process.env["GITLAB_TOKEN"];
    process.env["GITLAB_TOKEN"] = leaked;
    process.env["COLONYD_SECRET_PREVIEW"] = "shh-shared-secret";
    try {
      const result = await defaultValidateExecutor({
        engine: createInProcessEngine(),
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

  it("does not leak the daemon's NODE_ENV into acceptance commands", async () => {
    const repo = seedRepo();
    const previous = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const result = await defaultValidateExecutor({
        engine: createInProcessEngine(),
        workspace: workspaceKey(),
        cloneUrl: repo,
        displayUrl: repo,
        targetBranch: "main",
        // NODE_ENV=production would make `npm ci` omit devDependencies in a
        // fresh checkout, breaking every test-running criterion. CI is set
        // so commands behave as they would in a pipeline.
        acceptance: [
          { description: "no NODE_ENV", command: 'test -z "$NODE_ENV"' },
          { description: "CI set", command: 'test "$CI" = true' },
        ],
      });
      expect(result.passed).toBe(true);
    } finally {
      if (previous === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = previous;
    }
  });

  it("executes acceptance commands through a SandboxHandle (engine seam observable)", async () => {
    const repo = seedRepo();
    const innerEngine = createInProcessEngine();
    const provisionCalls: {
      profile: SandboxLaunchProfile;
      workspace: string;
    }[] = [];
    const execRequests: ExecRequest[] = [];
    let destroyed = false;

    const provisioned = new Map<string, SandboxHandle>();
    const recordingEngine: SandboxEngine = {
      async provision(profile, workspace) {
        expect(profile.role).toBe("validate");
        provisionCalls.push({ profile, workspace });
        const inner = await innerEngine.provision(profile, workspace);
        const handle = {
          sandboxId: inner.sandboxId,
          exec(request, onEvent) {
            execRequests.push(request);
            return inner.exec(request, onEvent);
          },
          readFile: (path) => inner.readFile(path),
          writeFile: (path, content) => inner.writeFile(path, content),
          async destroy() {
            destroyed = true;
            await inner.destroy();
          },
        } satisfies SandboxHandle;
        provisioned.set(handle.sandboxId, handle);
        return handle;
      },
      connect(sandboxId) {
        const handle = provisioned.get(sandboxId);
        if (handle === undefined) {
          return Promise.reject(new Error(`sandbox not found: ${sandboxId}`));
        }
        return Promise.resolve(handle);
      },
    };

    const result = await defaultValidateExecutor({
      engine: recordingEngine,
      workspace: workspaceKey(),
      cloneUrl: repo,
      displayUrl: repo,
      targetBranch: "main",
      acceptance: [{ description: "seam", command: "test -f marker" }],
    });

    expect(result.passed).toBe(true);
    expect(provisionCalls).toHaveLength(1);
    expect(provisionCalls[0]!.profile.role).toBe("validate");
    expect(execRequests).toHaveLength(1);
    expect(execRequests[0]!.command).toBe("test -f marker");
    expect(execRequests[0]!.env?.["CI"]).toBe("true");
    expect(destroyed).toBe(true);
  });
});
