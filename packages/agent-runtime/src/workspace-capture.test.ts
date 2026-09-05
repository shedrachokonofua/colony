import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SandboxHandle } from "@colony/sandbox";
import type { RunAuditSink } from "./audit-sink.js";
import { captureWorkspace } from "./workspace-capture.js";

type EventRecord = {
  runId: string;
  event: string;
  detail: Record<string, unknown>;
};

type ArtifactRecord = {
  runId: string;
  kind: string;
  key: string;
  data: Uint8Array;
  contentType: string;
};

/** In-memory audit sink that keeps the stored bytes available for recovery. */
function createRecordingSink(failingKind?: string): {
  sink: RunAuditSink;
  events: EventRecord[];
  artifacts: ArtifactRecord[];
} {
  const events: EventRecord[] = [];
  const artifacts: ArtifactRecord[] = [];

  const sink: RunAuditSink = {
    appendEvent(runId, event, detail) {
      events.push({ runId, event, detail });
    },
    async putArtifact(runId, kind, key, data, contentType) {
      if (kind === failingKind) return undefined;
      const stored = new Uint8Array(data);
      artifacts.push({ runId, kind, key, data: stored, contentType });
      return {
        ref: `blob://${key}`,
        bytes: stored.byteLength,
        sha256: createHash("sha256").update(stored).digest("hex"),
      };
    },
  };

  return { sink, events, artifacts };
}

/** SandboxHandle fixture backed by a real local checkout, including binary reads. */
function createWorkspaceSandboxHandle(workspaceDir: string): SandboxHandle {
  let seq = 0;
  const root = resolve(workspaceDir);

  return {
    sandboxId: "sandbox-ws-test",
    async exec(request, onData) {
      try {
        const stdout = execFileSync("sh", ["-c", request.command], {
          cwd: workspaceDir,
          env: { ...process.env, ...request.env },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: request.timeoutMs ?? 60_000,
        });
        onData?.({ kind: "stdout", seq: ++seq, data: stdout.toString("utf8") });
        return { exitCode: 0, durationMs: 10 };
      } catch (err: unknown) {
        const e = err as {
          stdout?: Buffer | string;
          stderr?: Buffer | string;
          status?: number;
        };
        if (e.stdout) {
          onData?.({
            kind: "stdout",
            seq: ++seq,
            data: Buffer.isBuffer(e.stdout)
              ? e.stdout.toString("utf8")
              : String(e.stdout),
          });
        }
        if (e.stderr) {
          onData?.({
            kind: "stderr",
            seq: ++seq,
            data: Buffer.isBuffer(e.stderr)
              ? e.stderr.toString("utf8")
              : String(e.stderr),
          });
        }
        return {
          exitCode: typeof e.status === "number" ? e.status : 1,
          durationMs: 10,
        };
      }
    },
    async readFile(path) {
      const resolved = resolve(workspaceDir, path);
      if (resolved !== root && !resolved.startsWith(`${root}/`)) {
        throw new Error("path escapes workspace");
      }
      return readFileSync(resolved);
    },
    async writeFile(path, content) {
      const resolved = resolve(workspaceDir, path);
      if (resolved !== root && !resolved.startsWith(`${root}/`)) {
        throw new Error("path escapes workspace");
      }
      mkdirSync(join(resolved, ".."), { recursive: true });
      writeFileSync(resolved, content);
    },
    async destroy() {},
  };
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

function gitIn(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

function createRepository(
  tempRoot: string,
  rejectPushes: boolean,
): {
  seedDir: string;
  workspaceDir: string;
  parentSha: string;
  pushAttemptMarker: string;
} {
  const remoteDir = join(tempRoot, "remote.git");
  const seedDir = join(tempRoot, "seed");
  const workspaceDir = join(tempRoot, "workspace");
  const pushAttemptMarker = join(tempRoot, "push-attempted");

  gitIn(tempRoot, ["init", "--bare", "--initial-branch=main", remoteDir]);
  gitIn(tempRoot, ["init", "--initial-branch=main", seedDir]);
  git(seedDir, ["config", "user.name", "Test Runner"]);
  git(seedDir, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(seedDir, "keep.txt"), "keep from parent\n");
  writeFileSync(join(seedDir, "tracked.txt"), "tracked from parent\n");
  writeFileSync(join(seedDir, "delete.txt"), "delete from parent\n");
  writeFileSync(join(seedDir, "staged.txt"), "staged from parent\n");
  writeFileSync(
    join(seedDir, ".gitignore"),
    "node_modules/\n**/node_modules/\n.bun-cache/\n**/.bun-cache/\ndist/\n**/dist/\n",
  );
  git(seedDir, ["add", "-A"]);
  git(seedDir, ["commit", "-m", "initial"]);
  writeFileSync(join(seedDir, "history.txt"), "parent history\n");
  git(seedDir, ["add", "history.txt"]);
  git(seedDir, ["commit", "-m", "parent"]);
  const parentSha = git(seedDir, ["rev-parse", "HEAD"]);
  git(seedDir, ["remote", "add", "origin", remoteDir]);
  git(seedDir, ["push", "origin", "main"]);

  if (rejectPushes) {
    const hook = join(remoteDir, "hooks", "pre-receive");
    writeFileSync(
      hook,
      `#!/bin/sh\nprintf attempted > ${JSON.stringify(pushAttemptMarker)}\nprintf 'pushes are forbidden in this fixture\\n' >&2\nexit 1\n`,
    );
    chmodSync(hook, 0o755);
  }

  // This clone proves the configured remote remains readable even when pushes are forbidden.
  gitIn(tempRoot, ["clone", remoteDir, workspaceDir]);
  git(workspaceDir, ["config", "user.name", "Agent Dev"]);
  git(workspaceDir, ["config", "user.email", "agent@example.com"]);

  return { seedDir, workspaceDir, parentSha, pushAttemptMarker };
}

function addGeneratedFiles(workspaceDir: string): void {
  const targetDir = join(workspaceDir, "..", "generated-target");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "ignored.txt"), "generated\n");

  mkdirSync(join(workspaceDir, "packages", "app"), { recursive: true });
  symlinkSync(targetDir, join(workspaceDir, "node_modules"));
  symlinkSync(targetDir, join(workspaceDir, "packages", "app", "node_modules"));
  symlinkSync(targetDir, join(workspaceDir, ".bun-cache"));
  symlinkSync(targetDir, join(workspaceDir, "packages", "app", "dist"));
}

function recoverBundle(
  seedDir: string,
  tempRoot: string,
  bundle: Uint8Array,
  ref: string,
): string {
  const recoveryDir = join(tempRoot, "recovery");
  const bundlePath = join(tempRoot, "workspace.bundle");
  writeFileSync(bundlePath, bundle);
  gitIn(tempRoot, ["clone", seedDir, recoveryDir]);
  git(recoveryDir, ["fetch", bundlePath, `${ref}:refs/heads/recovered`]);
  git(recoveryDir, ["checkout", "--detach", "refs/heads/recovered"]);
  return recoveryDir;
}

function hasRef(repoDir: string, ref: string): boolean {
  try {
    git(repoDir, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

describe("captureWorkspace", () => {
  it("stores a recoverable delta bundle while preserving the reviewer checkout", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "colony-ws-bundle-test-"));
    try {
      const repo = createRepository(tempRoot, true);
      addGeneratedFiles(repo.workspaceDir);
      writeFileSync(
        join(repo.workspaceDir, "tracked.txt"),
        "updated tracked\n",
      );
      unlinkSync(join(repo.workspaceDir, "delete.txt"));
      writeFileSync(join(repo.workspaceDir, "staged.txt"), "updated staged\n");
      git(repo.workspaceDir, ["add", "staged.txt"]);
      writeFileSync(join(repo.workspaceDir, "new.txt"), "new content\n");

      const headBefore = git(repo.workspaceDir, ["rev-parse", "HEAD"]);
      const indexBefore = git(repo.workspaceDir, ["rev-parse", ":staged.txt"]);
      const statusBefore = git(repo.workspaceDir, ["status", "--porcelain"]);
      const stagedDiffBefore = git(repo.workspaceDir, [
        "diff",
        "--cached",
        "--binary",
      ]);
      const worktreeDiffBefore = git(repo.workspaceDir, ["diff", "--binary"]);

      const handle = createWorkspaceSandboxHandle(repo.workspaceDir);
      const { sink, events, artifacts } = createRecordingSink();
      const runId = "run-bundle-123";
      const localGitRef = `refs/colony/runs/${runId}`;

      const result = await captureWorkspace({
        runId,
        handle,
        parentSha: repo.parentSha,
        secrets: [],
        sink,
      });

      expect(result).toBeDefined();
      expect(result!.ref).toBe(`blob://runs/${runId}/workspace.bundle`);
      expect(result!.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(hasRef(repo.workspaceDir, localGitRef)).toBe(false);
      expect(existsSync(repo.pushAttemptMarker)).toBe(false);

      const bundleArtifact = artifacts.find(
        (a) => a.kind === "workspace_bundle",
      );
      expect(bundleArtifact).toBeDefined();
      expect(bundleArtifact!.key).toBe(`runs/${runId}/workspace.bundle`);
      expect(bundleArtifact!.contentType).toBe("application/x-git-bundle");

      const recoveryDir = recoverBundle(
        repo.seedDir,
        tempRoot,
        bundleArtifact!.data,
        localGitRef,
      );
      expect(
        gitIn(recoveryDir, [
          "bundle",
          "verify",
          join(tempRoot, "workspace.bundle"),
        ]),
      ).toContain(repo.parentSha);
      expect(git(recoveryDir, ["rev-parse", "HEAD"])).toBe(result!.sha);
      expect(readFileSync(join(recoveryDir, "tracked.txt"), "utf8")).toBe(
        "updated tracked\n",
      );
      expect(readFileSync(join(recoveryDir, "staged.txt"), "utf8")).toBe(
        "updated staged\n",
      );
      expect(readFileSync(join(recoveryDir, "new.txt"), "utf8")).toBe(
        "new content\n",
      );
      expect(existsSync(join(recoveryDir, "delete.txt"))).toBe(false);
      const recoveredPaths = git(recoveryDir, [
        "ls-tree",
        "-r",
        "--name-only",
        "HEAD",
      ]).split("\n");
      expect(
        recoveredPaths.some((path) =>
          path
            .split("/")
            .some((part) =>
              ["node_modules", ".bun-cache", "dist"].includes(part),
            ),
        ),
      ).toBe(false);

      const manifestArtifact = artifacts.find(
        (a) => a.kind === "workspace_manifest",
      );
      expect(manifestArtifact).toBeDefined();
      expect(manifestArtifact!.contentType).toBe("application/json");
      expect(manifestArtifact!.key).toBe(
        `runs/${runId}/workspace-manifest.json`,
      );
      const manifest = JSON.parse(
        Buffer.from(manifestArtifact!.data).toString("utf8"),
      ) as {
        files: { path: string; sha256: string }[];
        deleted: string[];
        generated_at: string;
        parent_sha: string;
        sha: string;
        git_ref: string;
      };
      expect(manifest.parent_sha).toBe(repo.parentSha);
      expect(manifest.sha).toBe(result!.sha);
      expect(manifest.git_ref).toBe(localGitRef);
      expect(manifest.deleted).toEqual(["delete.txt"]);
      expect(manifest.files.map((file) => file.path).sort()).toEqual([
        "new.txt",
        "staged.txt",
        "tracked.txt",
      ]);
      expect(manifest.generated_at).toEqual(expect.any(String));

      expect(
        events.find((event) => event.event === "workspace_snapshot")?.detail,
      ).toEqual({
        ref: result!.ref,
        sha: result!.sha,
        parent_sha: repo.parentSha,
        git_ref: localGitRef,
      });
      expect(events.some((event) => event.event === "workspace_ref")).toBe(
        false,
      );

      expect(git(repo.workspaceDir, ["rev-parse", "HEAD"])).toBe(headBefore);
      expect(git(repo.workspaceDir, ["rev-parse", ":staged.txt"])).toBe(
        indexBefore,
      );
      expect(git(repo.workspaceDir, ["status", "--porcelain"])).toBe(
        statusBefore,
      );
      expect(git(repo.workspaceDir, ["diff", "--cached", "--binary"])).toBe(
        stagedDiffBefore,
      );
      expect(git(repo.workspaceDir, ["diff", "--binary"])).toBe(
        worktreeDiffBefore,
      );
      expect(readFileSync(join(repo.workspaceDir, "new.txt"), "utf8")).toBe(
        "new content\n",
      );
      expect(existsSync(join(repo.workspaceDir, "delete.txt"))).toBe(false);
      expect(
        existsSync(join(repo.workspaceDir, "node_modules", "ignored.txt")),
      ).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("captures a clean reviewer workspace after an interrupted capture without remote writes", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "colony-ws-reviewer-test-"));
    try {
      const repo = createRepository(tempRoot, true);
      const statusBefore = git(repo.workspaceDir, ["status", "--porcelain"]);
      const { sink, events } = createRecordingSink();
      const runId = "run-reviewer-123";
      git(repo.workspaceDir, [
        "update-ref",
        `refs/colony/runs/${runId}`,
        repo.parentSha,
      ]);

      const result = await captureWorkspace({
        runId,
        handle: createWorkspaceSandboxHandle(repo.workspaceDir),
        parentSha: repo.parentSha,
        secrets: [],
        sink,
      });

      expect(result).toBeDefined();
      expect(existsSync(repo.pushAttemptMarker)).toBe(false);
      expect(
        git(repo.workspaceDir, ["rev-parse", `refs/colony/runs/${runId}`]),
      ).toBe(repo.parentSha);
      expect(git(repo.workspaceDir, ["status", "--porcelain"])).toBe(
        statusBefore,
      );
      expect(events.some((event) => event.event === "workspace_snapshot")).toBe(
        true,
      );
      expect(
        events.some((event) => event.event === "workspace_capture_failed"),
      ).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not emit a success marker when artifact storage fails", async () => {
    const tempRoot = mkdtempSync(
      join(tmpdir(), "colony-ws-artifact-fail-test-"),
    );
    try {
      const repo = createRepository(tempRoot, true);
      writeFileSync(join(repo.workspaceDir, "new.txt"), "new content\n");
      const { sink, events } = createRecordingSink("workspace_manifest");

      const result = await captureWorkspace({
        runId: "run-artifact-fail-123",
        handle: createWorkspaceSandboxHandle(repo.workspaceDir),
        parentSha: repo.parentSha,
        secrets: [],
        sink,
      });

      expect(result).toBeUndefined();
      expect(events.some((event) => event.event === "workspace_snapshot")).toBe(
        false,
      );
      expect(
        events.some((event) => event.event === "workspace_capture_failed"),
      ).toBe(true);
      expect(existsSync(repo.pushAttemptMarker)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
