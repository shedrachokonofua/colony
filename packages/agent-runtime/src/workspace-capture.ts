import type { SandboxHandle } from "@colony/sandbox";
import type { RunAuditSink } from "./audit-sink.js";
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
  parent_sha: string;
  sha: string;
  git_ref: string;
}

/** Quote one value for use as a POSIX shell word. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
 * Capture the pod workspace as an incremental Git bundle and a manifest.
 *
 * The local snapshot ref exists only while the bundle is being produced. The
 * ref is deleted before this function exits, while the bundle itself is kept
 * in the artifact store and can be applied to the parent commit during
 * recovery. Excluded dependency/build trees are never staged.
 *
 * Non-throwing / best-effort: on any failure, appends
 * `workspace_capture_failed` and resolves undefined.
 */
export async function captureWorkspace(input: {
  runId: string;
  handle: SandboxHandle;
  parentSha: string;
  secrets: readonly string[];
  sink: RunAuditSink;
}): Promise<{ ref: string; sha: string } | undefined> {
  const fail = (error: string): undefined => {
    try {
      input.sink.appendEvent(input.runId, "workspace_capture_failed", {
        error: redactText(error, input.secrets),
      });
    } catch {
      // appendEvent is contractually non-throwing; foreign sinks must not
      // unwind teardown or hide the original capture failure.
    }
    return undefined;
  };

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tmpIndex = `.git/index_shadow_${suffix}`;
  const bundlePath = `.git/workspace_bundle_${suffix}.bundle`;
  const gitRef = `refs/colony/runs/${input.runId}`;
  let shadowCommitSha: string | undefined;
  let previousRefSha: string | undefined;
  let localRefCreated = false;

  const cleanup = async (): Promise<void> => {
    // Each cleanup operation is isolated: a cleanup failure must never hide a
    // primary Git/store failure, and deleting the temporary ref is conditional
    // on the exact commit we created.
    try {
      await execInSandbox(
        input.handle,
        `rm -f -- ${shellQuote(tmpIndex)} ${shellQuote(bundlePath)}`,
        5_000,
      );
    } catch {
      // Best effort; the sandbox is being torn down by the caller next.
    }
    if (localRefCreated && shadowCommitSha) {
      try {
        await execInSandbox(
          input.handle,
          previousRefSha
            ? `git update-ref ${shellQuote(gitRef)} ${shellQuote(previousRefSha)} ${shellQuote(shadowCommitSha)}`
            : `git update-ref -d ${shellQuote(gitRef)} ${shellQuote(shadowCommitSha)}`,
          5_000,
        );
      } catch {
        // Never replace the capture result with a cleanup error.
      }
    }
  };

  try {
    // Stage into a temporary index. Glob exclusions are intentional: literal
    // directory exclusions can make git add exit 1 for ignored directories.
    const addRes = await execInSandbox(
      input.handle,
      `GIT_INDEX_FILE=${shellQuote(tmpIndex)} git add -A -- . ` +
        "':(exclude,glob)**/node_modules' ':(exclude,glob)**/node_modules/**' " +
        "':(exclude,glob)**/.bun-cache' ':(exclude,glob)**/.bun-cache/**' " +
        "':(exclude,glob)**/dist' ':(exclude,glob)**/dist/**'",
      60_000,
    );
    if (addRes.exitCode !== 0) {
      return fail(
        `git add failed (exit ${addRes.exitCode}): ${addRes.stderr || addRes.stdout}`,
      );
    }

    const writeTreeRes = await execInSandbox(
      input.handle,
      `GIT_INDEX_FILE=${shellQuote(tmpIndex)} git write-tree`,
      60_000,
    );
    if (writeTreeRes.exitCode !== 0 || !writeTreeRes.stdout.trim()) {
      return fail(
        `git write-tree failed (exit ${writeTreeRes.exitCode}): ${writeTreeRes.stderr || writeTreeRes.stdout}`,
      );
    }
    const treeSha = writeTreeRes.stdout.trim();

    // Explicit identity keeps isolated sandbox environments independent of
    // user Git configuration.
    const authorEnv =
      'GIT_AUTHOR_NAME="colony" GIT_AUTHOR_EMAIL="colony@colony.local" GIT_COMMITTER_NAME="colony" GIT_COMMITTER_EMAIL="colony@colony.local"';
    const commitMsg = `colony audit: run ${input.runId}`;
    const commitTreeRes = await execInSandbox(
      input.handle,
      `${authorEnv} git commit-tree ${shellQuote(treeSha)} -p ${shellQuote(input.parentSha)} -m ${shellQuote(commitMsg)}`,
      60_000,
    );
    if (commitTreeRes.exitCode !== 0 || !commitTreeRes.stdout.trim()) {
      return fail(
        `git commit-tree failed (exit ${commitTreeRes.exitCode}): ${commitTreeRes.stderr || commitTreeRes.stdout}`,
      );
    }
    shadowCommitSha = commitTreeRes.stdout.trim();

    // Keep the snapshot under a local ref while creating a delta bundle. The
    // ordinary HEAD, index, and worktree are never touched by these commands.
    const previousRef = await execInSandbox(
      input.handle,
      `git rev-parse --verify --quiet ${shellQuote(gitRef)}`,
      5_000,
    );
    if (previousRef.exitCode !== 0 && previousRef.exitCode !== 1) {
      return fail(`git ref lookup failed (exit ${previousRef.exitCode})`);
    }
    previousRefSha = previousRef.stdout.trim() || undefined;
    const updateRefRes = await execInSandbox(
      input.handle,
      `git update-ref ${shellQuote(gitRef)} ${shellQuote(shadowCommitSha)} ${shellQuote(previousRefSha ?? "0".repeat(shadowCommitSha.length))}`,
      5_000,
    );
    if (updateRefRes.exitCode !== 0) {
      return fail(
        `git update-ref failed (exit ${updateRefRes.exitCode}): ${updateRefRes.stderr || updateRefRes.stdout}`,
      );
    }
    localRefCreated = true;

    const bundleRes = await execInSandbox(
      input.handle,
      `git bundle create ${shellQuote(bundlePath)} ${shellQuote(`${input.parentSha}..${gitRef}`)}`,
      60_000,
    );
    if (bundleRes.exitCode !== 0) {
      return fail(
        `git bundle failed (exit ${bundleRes.exitCode}): ${bundleRes.stderr || bundleRes.stdout}`,
      );
    }
    const bundleBytes = await input.handle.readFile(bundlePath);

    const storedBundle = await input.sink.putArtifact(
      input.runId,
      "workspace_bundle",
      `runs/${input.runId}/workspace.bundle`,
      bundleBytes,
      "application/x-git-bundle",
    );
    if (!storedBundle) {
      return fail("putArtifact did not store the workspace bundle");
    }

    // Generate a manifest covering the changed-vs-parent set. Bun is
    // guaranteed by the sandbox image and the colonyd runtime.
    const manifestScript = `
const { execFileSync } = require("child_process");
const { createHash } = require("crypto");

const parentSha = process.argv[1];
const shadowCommitSha = process.argv[2];

const diffOut = execFileSync("git", ["diff-tree", "-r", "-z", "--no-commit-id", "--name-status", parentSha, shadowCommitSha], { maxBuffer: 32 * 1024 * 1024 });
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
    if (destPath) nonDeleted.push(destPath);
  } else if (status.startsWith("D")) {
    deleted.push(path);
  } else {
    nonDeleted.push(path);
  }
}

const lsTreeOut = execFileSync("git", ["ls-tree", "-r", "-l", "-z", shadowCommitSha], { maxBuffer: 64 * 1024 * 1024 });
const lsEntries = lsTreeOut.toString("binary").split("\\0");
if (lsEntries.length && lsEntries[lsEntries.length - 1] === "") lsEntries.pop();

const treeMap = new Map();
for (const entry of lsEntries) {
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
  const blobBuf = execFileSync("git", ["cat-file", "blob", meta.objSha], { maxBuffer: 128 * 1024 * 1024 });
  const sha256 = createHash("sha256").update(blobBuf).digest("hex");
  files.push({ path: filePath, mode: meta.mode, size: meta.size, sha256 });
}

process.stdout.write(JSON.stringify({
  files,
  deleted,
  generated_at: new Date().toISOString(),
  parent_sha: parentSha,
  sha: shadowCommitSha,
  git_ref: ${JSON.stringify(gitRef)},
}));
`;
    const manifestRes = await execInSandbox(
      input.handle,
      `bun -e ${shellQuote(manifestScript)} ${shellQuote(input.parentSha)} ${shellQuote(shadowCommitSha)}`,
      30_000,
    );
    if (manifestRes.exitCode !== 0 || !manifestRes.stdout.trim()) {
      return fail(
        `manifest generation failed (exit ${manifestRes.exitCode}): ${manifestRes.stderr || manifestRes.stdout}`,
      );
    }

    let manifestObj: WorkspaceManifest;
    try {
      manifestObj = JSON.parse(manifestRes.stdout) as WorkspaceManifest;
    } catch {
      return fail(
        `invalid manifest JSON produced: ${manifestRes.stdout.slice(0, 200)}`,
      );
    }

    const manifestBytes = Buffer.from(
      redactText(JSON.stringify(manifestObj, null, 2), input.secrets),
      "utf8",
    );
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

    input.sink.appendEvent(input.runId, "workspace_snapshot", {
      ref: storedBundle.ref,
      sha: shadowCommitSha,
      parent_sha: input.parentSha,
      git_ref: gitRef,
    });

    return {
      ref: storedBundle.ref,
      sha: shadowCommitSha,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    await cleanup();
  }
}
