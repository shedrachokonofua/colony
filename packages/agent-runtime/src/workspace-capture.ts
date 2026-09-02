import { createHash } from "node:crypto";
import type { SandboxHandle } from "@colony/sandbox";
import type { RunAuditSink } from "./audit-sink.js";
import type { PacketRepoRef } from "./pi-runner-common.js";
import { redactText } from "./redact.js";

/** Manifest entry describing a changed or added file. */
export interface WorkspaceManifestFile {
  path: string;
  mode: string;
  size: number;
  sha256: string;
}

/** Workspace manifest covering changed-vs-head set. */
export interface WorkspaceManifest {
  files: WorkspaceManifestFile[];
  deleted: string[];
  generated_at: string;
}

/**
 * Execute a command against the sandbox handle capturing stdout and stderr.
 */
async function execInSandbox(
  handle: SandboxHandle,
  command: string,
  timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const result = await handle.exec(
    {
      command,
      cwd: ".",
      timeoutMs,
    },
    (event) => {
      if (event.kind === "stdout") {
        stdoutChunks.push(event.data);
      } else if (event.kind === "stderr") {
        stderrChunks.push(event.data);
      }
    },
  );

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    exitCode: result.exitCode,
  };
}

/**
 * Capture the pod workspace's full working tree as a pushed shadow ref plus a manifest artifact.
 *
 * Excludes: node_modules, .bun-cache, dist (and .git).
 * Pushes to: refs/colony/runs/<runId>
 * Records:
 *   - run event `workspace_ref` { ref, sha }
 *   - run_artifacts row (kind: `workspace_ref`, key: `runs/<runId>/workspace_ref`, ref: `refs/colony/runs/<runId>@<sha>`)
 *   - run_artifacts row (kind: `workspace_manifest`, key: `runs/<runId>/workspace-manifest.json`)
 *
 * Non-throwing / best-effort: on any failure, appends `workspace_capture_failed` run event and resolves undefined.
 */
export async function captureWorkspace(input: {
  runId: string;
  handle: SandboxHandle;
  repo: PacketRepoRef;
  parentSha: string;
  secrets: readonly string[];
  sink: RunAuditSink;
}): Promise<{ ref: string; sha: string } | undefined> {
  const fail = (error: string): undefined => {
    try {
      input.sink.appendEvent(input.runId, "workspace_capture_failed", {
        error,
      });
    } catch {
      // appendEvent is contractually non-throwing; foreign sink must not throw here
    }
    return undefined;
  };

  try {
    const tmpIndex = `.git/index_shadow_${input.runId}_${Date.now()}`;
    const cleanTmpIndexCmd = `rm -f ${tmpIndex}`;

    // 1. Stage working tree into temporary index
    // Exclude node_modules, .bun-cache, dist
    const addRes = await execInSandbox(
      input.handle,
      `GIT_INDEX_FILE=${tmpIndex} git add -A -- . ':(exclude)node_modules' ':(exclude).bun-cache' ':(exclude)dist'`,
      60_000,
    );
    if (addRes.exitCode !== 0) {
      await execInSandbox(input.handle, cleanTmpIndexCmd, 5_000).catch(
        () => {},
      );
      return fail(
        `git add failed (exit ${addRes.exitCode}): ${addRes.stderr || addRes.stdout}`,
      );
    }

    // 2. Write tree
    const writeTreeRes = await execInSandbox(
      input.handle,
      `GIT_INDEX_FILE=${tmpIndex} git write-tree`,
      60_000,
    );
    if (writeTreeRes.exitCode !== 0 || !writeTreeRes.stdout.trim()) {
      await execInSandbox(input.handle, cleanTmpIndexCmd, 5_000).catch(
        () => {},
      );
      return fail(
        `git write-tree failed (exit ${writeTreeRes.exitCode}): ${writeTreeRes.stderr || writeTreeRes.stdout}`,
      );
    }
    const treeSha = writeTreeRes.stdout.trim();

    // 3. Commit tree
    // Message: colony audit: run <run_id>
    const commitMsg = `colony audit: run ${input.runId}`;
    const commitTreeRes = await execInSandbox(
      input.handle,
      `git commit-tree ${treeSha} -p ${input.parentSha} -m "${commitMsg}"`,
      60_000,
    );
    if (commitTreeRes.exitCode !== 0 || !commitTreeRes.stdout.trim()) {
      await execInSandbox(input.handle, cleanTmpIndexCmd, 5_000).catch(
        () => {},
      );
      return fail(
        `git commit-tree failed (exit ${commitTreeRes.exitCode}): ${commitTreeRes.stderr || commitTreeRes.stdout}`,
      );
    }
    const shadowCommitSha = commitTreeRes.stdout.trim();

    // Clean up temporary index file
    await execInSandbox(input.handle, cleanTmpIndexCmd, 5_000).catch(() => {});

    // 4. Push shadow ref
    const targetRef = `refs/colony/runs/${input.runId}`;
    const pushRes = await execInSandbox(
      input.handle,
      `git push origin ${shadowCommitSha}:${targetRef}`,
      60_000,
    );
    if (pushRes.exitCode !== 0) {
      return fail(
        `git push failed (exit ${pushRes.exitCode}): ${pushRes.stderr || pushRes.stdout}`,
      );
    }

    // 5. Generate manifest covering changed-vs-head set (compared against parentSha)
    // Using `git diff-tree -r --name-status <parentSha> <shadowCommitSha>` or `git diff-tree -r -z`
    // Or `git diff --name-status <parentSha> <shadowCommitSha>`
    const diffRes = await execInSandbox(
      input.handle,
      `git diff-tree -r --no-commit-id --name-status ${input.parentSha} ${shadowCommitSha}`,
      60_000,
    );
    if (diffRes.exitCode !== 0) {
      return fail(
        `git diff-tree failed (exit ${diffRes.exitCode}): ${diffRes.stderr || diffRes.stdout}`,
      );
    }

    const files: WorkspaceManifestFile[] = [];
    const deleted: string[] = [];

    const lines = diffRes.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    for (const line of lines) {
      const parts = line.split(/\t+/);
      const status = parts[0] ?? "";
      const filePath = parts[1] ?? "";

      if (!filePath) continue;

      if (status.startsWith("D")) {
        deleted.push(filePath);
      } else {
        // Query mode, size, and blob sha / sha256
        // We can get mode and git object from `git ls-tree <shadowCommitSha> -- <filePath>`
        // and file content / sha256 / size.
        // Or inspect via `git ls-tree -r ${shadowCommitSha} -- ${filePath}`
        // For file size and sha256 of the file content in the shadow commit:
        // `git cat-file -s <shadowCommitSha>:<filePath>` for size
        // `git cat-file -p <shadowCommitSha>:<filePath>` or `git cat-file blob <sha>`
        const lsTreeRes = await execInSandbox(
          input.handle,
          `git ls-tree ${shadowCommitSha} -- "${filePath}"`,
          30_000,
        );
        let mode = "100644";
        if (lsTreeRes.exitCode === 0 && lsTreeRes.stdout.trim()) {
          const m = lsTreeRes.stdout.trim().split(/\s+/)[0];
          if (m) mode = m;
        }

        // We can pipe git cat-file blob to sha256sum in sandbox or compute in node.
        // Running sha256sum via cat-file: `git cat-file blob <shadowCommitSha>:<filePath> | sha256sum`
        // and `git cat-file -s <shadowCommitSha>:<filePath>`
        const catRes = await execInSandbox(
          input.handle,
          `git cat-file blob "${shadowCommitSha}:${filePath}" | sha256sum`,
          30_000,
        );
        const sizeRes = await execInSandbox(
          input.handle,
          `git cat-file -s "${shadowCommitSha}:${filePath}"`,
          30_000,
        );

        let sha256 = "";
        if (catRes.exitCode === 0 && catRes.stdout.trim()) {
          sha256 = catRes.stdout.trim().split(/\s+/)[0] ?? "";
        }
        let size = 0;
        if (sizeRes.exitCode === 0 && sizeRes.stdout.trim()) {
          size = parseInt(sizeRes.stdout.trim(), 10) || 0;
        }

        files.push({
          path: filePath,
          mode,
          size,
          sha256,
        });
      }
    }

    const manifest: WorkspaceManifest = {
      files,
      deleted,
      generated_at: new Date().toISOString(),
    };

    const manifestJson = JSON.stringify(manifest, null, 2);
    const redactedManifest = redactText(manifestJson, input.secrets);
    const manifestBytes = Buffer.from(redactedManifest, "utf8");

    // 6. Record artifacts and events
    // workspace_ref event
    input.sink.appendEvent(input.runId, "workspace_ref", {
      ref: targetRef,
      sha: shadowCommitSha,
    });

    // workspace_ref artifact row
    input.sink.recordArtifactRef(
      input.runId,
      "workspace_ref",
      `runs/${input.runId}/workspace_ref`,
      `${targetRef}@${shadowCommitSha}`,
    );

    // workspace_manifest artifact
    await input.sink.putArtifact(
      input.runId,
      "workspace_manifest",
      `runs/${input.runId}/workspace-manifest.json`,
      manifestBytes,
      "application/json",
    );

    return {
      ref: targetRef,
      sha: shadowCommitSha,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
