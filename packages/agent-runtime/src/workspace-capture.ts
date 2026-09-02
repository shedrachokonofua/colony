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

    // Clean up temporary index file
    await execInSandbox(input.handle, cleanTmpIndexCmd, 5_000).catch(() => {});

    // 3. Commit tree
    // Provide explicit author & committer identity so it works in isolated sandbox envs without gitconfig
    const commitMsg = `colony audit: run ${input.runId}`;
    const authorEnv =
      'GIT_AUTHOR_NAME="colony" GIT_AUTHOR_EMAIL="colony@colony.local" GIT_COMMITTER_NAME="colony" GIT_COMMITTER_EMAIL="colony@colony.local"';
    const commitTreeRes = await execInSandbox(
      input.handle,
      `${authorEnv} git commit-tree ${treeSha} -p ${input.parentSha} -m "${commitMsg}"`,
      60_000,
    );
    if (commitTreeRes.exitCode !== 0 || !commitTreeRes.stdout.trim()) {
      return fail(
        `git commit-tree failed (exit ${commitTreeRes.exitCode}): ${commitTreeRes.stderr || commitTreeRes.stdout}`,
      );
    }
    const shadowCommitSha = commitTreeRes.stdout.trim();

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
    // Run in a single sandbox script using node to avoid multiple sandbox exec roundtrips
    const manifestScript = `node -e '
const { execSync } = require("child_process");
const { createHash } = require("crypto");

const parentSha = process.argv[1];
const shadowCommitSha = process.argv[2];

const diffOut = execSync(\`git diff-tree -r -z --no-commit-id --name-status \${parentSha} \${shadowCommitSha}\`, { maxBuffer: 32 * 1024 * 1024 });

// diff-tree -z separates items by NUL: [status, path, (destPath if rename/copy), status, path, ...]
const tokens = diffOut.toString("binary").split("\\0");
if (tokens.length && tokens[tokens.length - 1] === "") tokens.pop();

const deleted = [];
const nonDeleted = [];

let i = 0;
while (i < tokens.length) {
  const status = tokens[i++];
  if (!status) break;
  const path = tokens[i++];
  if (!path) break;

  if (status.startsWith("R") || status.startsWith("C")) {
    const destPath = tokens[i++];
    if (destPath) {
      nonDeleted.push(destPath);
    }
  } else if (status.startsWith("D")) {
    deleted.push(path);
  } else {
    nonDeleted.push(path);
  }
}

// Get metadata (mode, object sha, size) for all files in shadow commit using ls-tree -r -l -z
const lsTreeOut = execSync(\`git ls-tree -r -l -z \${shadowCommitSha}\`, { maxBuffer: 64 * 1024 * 1024 });
const lsEntries = lsTreeOut.toString("binary").split("\\0");
if (lsEntries.length && lsEntries[lsEntries.length - 1] === "") lsEntries.pop();

const treeMap = new Map();
for (const entry of lsEntries) {
  // format: <mode> SP <type> SP <object> SP <size> TAB <file>
  const tabIdx = entry.indexOf("\\t");
  if (tabIdx === -1) continue;
  const meta = entry.slice(0, tabIdx);
  const filePath = entry.slice(tabIdx + 1);
  const parts = meta.split(/ +/);
  if (parts.length >= 4) {
    const mode = parts[0];
    const objSha = parts[2];
    const sizeStr = parts[3].trim();
    const size = sizeStr === "-" ? 0 : parseInt(sizeStr, 10) || 0;
    treeMap.set(filePath, { mode, objSha, size });
  }
}

const files = [];
for (const filePath of nonDeleted) {
  const meta = treeMap.get(filePath);
  if (!meta) continue;

  // Compute sha256 of the blob content
  const blobBuf = execSync(\`git cat-file blob \${meta.objSha}\`, { maxBuffer: 128 * 1024 * 1024 });
  const sha256 = createHash("sha256").update(blobBuf).digest("hex");

  files.push({
    path: filePath,
    mode: meta.mode,
    size: meta.size,
    sha256,
  });
}

const manifest = {
  files,
  deleted,
  generated_at: new Date().toISOString(),
};

process.stdout.write(JSON.stringify(manifest));
' "${input.parentSha}" "${shadowCommitSha}"`;

    const manifestRes = await execInSandbox(
      input.handle,
      manifestScript,
      30_000,
    );
    if (manifestRes.exitCode !== 0 || !manifestRes.stdout.trim()) {
      return fail(
        `manifest generation failed (exit ${manifestRes.exitCode}): ${manifestRes.stderr || manifestRes.stdout}`,
      );
    }

    let manifestObj: WorkspaceManifest;
    try {
      manifestObj = JSON.parse(manifestRes.stdout);
    } catch (e) {
      return fail(
        `invalid manifest JSON produced: ${manifestRes.stdout.slice(0, 200)}`,
      );
    }

    const manifestJson = JSON.stringify(manifestObj, null, 2);
    const redactedManifest = redactText(manifestJson, input.secrets);
    const manifestBytes = Buffer.from(redactedManifest, "utf8");

    // 6. Record artifacts and events
    // workspace_manifest artifact via putArtifact (must verify result)
    const storedManifest = await input.sink.putArtifact(
      input.runId,
      "workspace_manifest",
      `runs/${input.runId}/workspace-manifest.json`,
      manifestBytes,
      "application/json",
    );
    if (!storedManifest) {
      return fail("putArtifact did not store the workspace manifest");
    }

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

    return {
      ref: targetRef,
      sha: shadowCommitSha,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
