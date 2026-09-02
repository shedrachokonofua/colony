import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunAuditSink } from "./audit-sink.js";
import { captureWorkspace } from "./workspace-capture.js";
import type { SandboxHandle } from "@colony/sandbox";

/** In-memory audit sink for assertions */
function createRecordingSink(): {
  sink: RunAuditSink;
  events: { runId: string; event: string; detail: Record<string, unknown> }[];
  artifacts: {
    runId: string;
    kind: string;
    key: string;
    data: Uint8Array;
    contentType: string;
  }[];
  artifactRefs: {
    runId: string;
    kind: string;
    key: string;
    ref: string;
    sha256?: string;
    bytes?: number;
    contentType?: string;
  }[];
} {
  const events: {
    runId: string;
    event: string;
    detail: Record<string, unknown>;
  }[] = [];
  const artifacts: {
    runId: string;
    kind: string;
    key: string;
    data: Uint8Array;
    contentType: string;
  }[] = [];
  const artifactRefs: {
    runId: string;
    kind: string;
    key: string;
    ref: string;
    sha256?: string;
    bytes?: number;
    contentType?: string;
  }[] = [];

  const sink: RunAuditSink = {
    appendEvent(runId, event, detail) {
      events.push({ runId, event, detail });
    },
    async putArtifact(runId, kind, key, data, contentType) {
      artifacts.push({ runId, kind, key, data, contentType });
      const sha256 = createHash("sha256").update(data).digest("hex");
      return {
        ref: `blob://${key}`,
        bytes: data.byteLength,
        sha256,
      };
    },
    recordArtifactRef(runId, kind, key, ref, sha256, bytes, contentType) {
      artifactRefs.push({ runId, kind, key, ref, sha256, bytes, contentType });
    },
  };

  return { sink, events, artifacts, artifactRefs };
}

/** Stub SandboxHandle that runs commands directly on local workspace directory */
function createWorkspaceSandboxHandle(workspaceDir: string): SandboxHandle {
  let seq = 0;
  return {
    async exec(request, onData) {
      try {
        const stdout = execSync(request.command, {
          cwd: workspaceDir,
          env: { ...process.env, ...request.env },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: request.timeoutMs ?? 60_000,
        });
        onData?.({ kind: "stdout", seq: ++seq, data: stdout.toString("utf8") });
        return { exitCode: 0, durationMs: 10 };
      } catch (err: unknown) {
        if (err && typeof err === "object") {
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
        return { exitCode: 1, durationMs: 10 };
      }
    },
    async readFile() {
      throw new Error("not implemented in stub");
    },
    async writeFile() {
      throw new Error("not implemented in stub");
    },
    async destroy() {},
  };
}

describe("captureWorkspace", () => {
  it("captures shadow commit, pushes ref, writes manifest, and leaves workspace clean", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "colony-ws-test-"));
    const bareDir = join(tempRoot, "remote.git");
    const wsDir = join(tempRoot, "workspace");

    try {
      // 1. Setup bare git repo with initial branch main
      execSync(`git init --bare --initial-branch=main "${bareDir}"`);

      // 2. Setup initial commit in a temp repo and push to bare
      const initDir = join(tempRoot, "init");
      execSync(`git init --initial-branch=main "${initDir}"`);
      execSync(`git -C "${initDir}" config user.name "Test Runner"`);
      execSync(`git -C "${initDir}" config user.email "test@example.com"`);
      writeFileSync(join(initDir, "initial.txt"), "hello initial\n");
      execSync(`git -C "${initDir}" add initial.txt`);
      execSync(`git -C "${initDir}" commit -m "initial commit"`);
      const baseSha = execSync(`git -C "${initDir}" rev-parse HEAD`, {
        encoding: "utf8",
      }).trim();
      execSync(`git -C "${initDir}" remote add origin "${bareDir}"`);
      execSync(`git -C "${initDir}" push origin main`);

      // 3. Clone workspace from bare repo
      execSync(`git clone "${bareDir}" "${wsDir}"`);
      execSync(`git -C "${wsDir}" config user.name "Agent Dev"`);
      execSync(`git -C "${wsDir}" config user.email "agent@example.com"`);

      // 4. Modify workspace: add untracked file, modify tracked, create excluded directories/files
      writeFileSync(
        join(wsDir, "touched.txt"),
        "touched content with secret-token-xyz\n",
      );
      writeFileSync(join(wsDir, "initial.txt"), "modified initial\n");
      // Add excluded directories
      execSync(
        `mkdir -p "${join(wsDir, "node_modules")}" "${join(wsDir, ".bun-cache")}" "${join(wsDir, "dist")}"`,
      );
      writeFileSync(join(wsDir, "node_modules", "pkg.json"), "{}");
      writeFileSync(join(wsDir, ".bun-cache", "cache.bin"), "000");
      writeFileSync(join(wsDir, "dist", "bundle.js"), "console.log(1)");

      const headBefore = execSync(`git -C "${wsDir}" rev-parse HEAD`, {
        encoding: "utf8",
      }).trim();
      const statusBefore = execSync(`git -C "${wsDir}" status --porcelain`, {
        encoding: "utf8",
      }).trim();

      const handle = createWorkspaceSandboxHandle(wsDir);
      const { sink, events, artifacts, artifactRefs } = createRecordingSink();
      const runId = "run-test-123";

      const res = await captureWorkspace({
        runId,
        handle,
        repo: {
          url: bareDir,
          branch: "main",
          base_commit: baseSha,
        },
        parentSha: baseSha,
        secrets: ["secret-token-xyz"],
        sink,
      });

      expect(res).toBeDefined();
      expect(res!.ref).toBe(`refs/colony/runs/${runId}`);

      // Check bare repo ref
      const pushedSha = execSync(
        `git --git-dir="${bareDir}" rev-parse refs/colony/runs/${runId}`,
        {
          encoding: "utf8",
        },
      ).trim();
      expect(pushedSha).toBe(res!.sha);

      // Check shadow commit parent and message
      const commitParent = execSync(
        `git --git-dir="${bareDir}" rev-parse ${pushedSha}^`,
        {
          encoding: "utf8",
        },
      ).trim();
      expect(commitParent).toBe(baseSha);
      const commitMsg = execSync(
        `git --git-dir="${bareDir}" log -1 --format=%B ${pushedSha}`,
        {
          encoding: "utf8",
        },
      ).trim();
      expect(commitMsg).toBe(`colony audit: run ${runId}`);

      // Check shadow commit does NOT contain excluded directories
      const lsTreeOutput = execSync(
        `git --git-dir="${bareDir}" ls-tree --name-only -r ${pushedSha}`,
        {
          encoding: "utf8",
        },
      ).toString();
      expect(lsTreeOutput).toContain("touched.txt");
      expect(lsTreeOutput).toContain("initial.txt");
      expect(lsTreeOutput).not.toContain("node_modules");
      expect(lsTreeOutput).not.toContain(".bun-cache");
      expect(lsTreeOutput).not.toContain("dist");

      // Check workspace index, branch and HEAD are unchanged
      const headAfter = execSync(`git -C "${wsDir}" rev-parse HEAD`, {
        encoding: "utf8",
      }).trim();
      const statusAfter = execSync(`git -C "${wsDir}" status --porcelain`, {
        encoding: "utf8",
      }).trim();
      expect(headAfter).toBe(headBefore);
      expect(statusAfter).toBe(statusBefore);

      // Check events and artifact records
      const wsRefEvent = events.find((e) => e.event === "workspace_ref");
      expect(wsRefEvent).toBeDefined();
      expect(wsRefEvent?.detail).toEqual({
        ref: `refs/colony/runs/${runId}`,
        sha: res!.sha,
      });

      const wsRefRow = artifactRefs.find((r) => r.kind === "workspace_ref");
      expect(wsRefRow).toBeDefined();
      expect(wsRefRow?.key).toBe(`runs/${runId}/workspace_ref`);
      expect(wsRefRow?.ref).toBe(`refs/colony/runs/${runId}@${res!.sha}`);

      const wsManifestRow = artifacts.find(
        (r) => r.kind === "workspace_manifest",
      );
      expect(wsManifestRow).toBeDefined();
      expect(wsManifestRow?.key).toBe(`runs/${runId}/workspace-manifest.json`);

      const manifestContent = JSON.parse(
        Buffer.from(wsManifestRow!.data).toString("utf8"),
      );
      expect(manifestContent.files).toBeDefined();
      expect(manifestContent.deleted).toEqual([]);
      expect(manifestContent.generated_at).toBeDefined();

      const touchedEntry = manifestContent.files.find(
        (f: { path: string }) => f.path === "touched.txt",
      );
      expect(touchedEntry).toBeDefined();
      expect(touchedEntry.sha256).toBeDefined();
      expect(touchedEntry.sha256.length).toBe(64);

      // Ensure secret redaction happened on the manifest JSON
      const rawManifestString = Buffer.from(wsManifestRow!.data).toString(
        "utf8",
      );
      expect(rawManifestString).not.toContain("secret-token-xyz");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("handles failed push by appending workspace_capture_failed event without throwing", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "colony-ws-fail-test-"));
    const wsDir = join(tempRoot, "workspace");

    try {
      execSync(`git init "${wsDir}"`);
      execSync(`git -C "${wsDir}" config user.name "Test Runner"`);
      execSync(`git -C "${wsDir}" config user.email "test@example.com"`);
      writeFileSync(join(wsDir, "initial.txt"), "hello\n");
      execSync(`git -C "${wsDir}" add initial.txt`);
      execSync(`git -C "${wsDir}" commit -m "initial"`);
      const baseSha = execSync(`git -C "${wsDir}" rev-parse HEAD`, {
        encoding: "utf8",
      }).trim();

      // Point origin to a nonexistent path
      execSync(`git -C "${wsDir}" remote add origin "/nonexistent/repo.git"`);

      const handle = createWorkspaceSandboxHandle(wsDir);
      const { sink, events } = createRecordingSink();
      const runId = "run-fail-123";

      const res = await captureWorkspace({
        runId,
        handle,
        repo: {
          url: "/nonexistent/repo.git",
          branch: "main",
          base_commit: baseSha,
        },
        parentSha: baseSha,
        secrets: [],
        sink,
      });

      expect(res).toBeUndefined();

      const failEvent = events.find(
        (e) => e.event === "workspace_capture_failed",
      );
      expect(failEvent).toBeDefined();
      expect(failEvent?.detail.error).toBeDefined();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
