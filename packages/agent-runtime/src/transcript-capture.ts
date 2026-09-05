import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { RunAuditSink } from "./audit-sink.js";
import { redactText } from "./redact.js";

/**
 * Where a transcript survives an upload failure. Outside the run dir by
 * construction: teardown sweeps the run workspace unconditionally, so a copy
 * parked inside it would be the one thing the failure clause promises to keep.
 */
function fallbackTranscriptPath(runId: string): string {
  return join(tmpdir(), "colony-pi-run-transcripts", `${runId}.jsonl`);
}

/**
 * Park a transcript that could not be uploaded outside the run dir, so the
 * workspace sweep at teardown cannot destroy the only copy. Best-effort and
 * non-throwing: a failure here must not unwind teardown, and the run event
 * recording the upload failure is the operator's signal either way.
 *
 * @returns the path the transcript now lives at, or undefined when there was
 * nothing to keep or the move failed.
 */
export function quarantineTranscript(
  runId: string,
  sessionFile: string,
): string | undefined {
  if (!existsSync(sessionFile)) return undefined;
  const target = fallbackTranscriptPath(runId);
  try {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(sessionFile, target);
    return target;
  } catch {
    // The file stays where it is; the run dir sweep decides its fate.
    return undefined;
  }
}

/**
 * Persist a run's session transcript as a gzip artifact: read the JSONL,
 * redact every line, gzip, and hand the bytes to `putArtifact`, which stores
 * the blob and records the `run_artifacts` row (kind `transcript`). On
 * success the source file is deleted — the artifact is the only copy.
 *
 * Strictly best-effort and expected to run after the run result is decided:
 * this never throws, and any failure (read, redaction, upload, or a stored
 * hash/length that disagrees with the bytes we sent) surfaces as a
 * `transcript_upload_failed` run event carrying the error message. When the
 * upload fails the source file is kept so the transcript is not lost.
 */
export async function captureTranscript(input: {
  runId: string;
  sessionFile: string;
  secrets: readonly string[];
  sink: RunAuditSink;
}): Promise<{ ref: string; sha256: string; bytes: number } | undefined> {
  const fail = (error: string): undefined => {
    try {
      input.sink.appendEvent(input.runId, "transcript_upload_failed", {
        error,
      });
    } catch {
      // appendEvent is contractually non-throwing; a foreign sink that does
      // must not turn a captured failure into an escaped throw.
    }
    return undefined;
  };
  // A run that ends before the session ever reached disk has no transcript,
  // not a failed upload: no artifact, no event. Reporting the two the same
  // way makes an ordinary pre-first-token failure read like a store outage.
  if (!existsSync(input.sessionFile)) return undefined;
  let gzipped: Buffer;
  try {
    // Line-by-line redaction before the bytes are ever compressed: a token
    // embedded in one transcript line must not survive into the artifact.
    const redacted = readFileSync(input.sessionFile, "utf8")
      .split("\n")
      .map((line) => redactText(line, input.secrets))
      .join("\n");
    gzipped = gzipSync(Buffer.from(redacted, "utf8"));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const sha256 = createHash("sha256").update(gzipped).digest("hex");
  const bytes = gzipped.byteLength;
  let stored: { ref: string; bytes: number; sha256: string } | undefined;
  try {
    // putArtifact stores the blob AND records the run_artifacts row; never
    // rejects, resolves undefined on failure.
    stored = await input.sink.putArtifact(
      input.runId,
      "transcript",
      `runs/${input.runId}/transcript.jsonl.gz`,
      new Uint8Array(gzipped),
      "application/gzip",
    );
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (!stored) {
    return fail("putArtifact did not store the transcript");
  }
  if (stored.sha256 !== sha256 || stored.bytes !== bytes) {
    return fail(
      `transcript artifact mismatch: stored sha256=${stored.sha256} bytes=${stored.bytes}, sent sha256=${sha256} bytes=${bytes}`,
    );
  }
  try {
    rmSync(input.sessionFile, { force: true });
  } catch (err) {
    // Upload succeeded; losing only the local scratch copy is not an upload
    // failure. The artifact row stays; the leak fix removes the run dir later.
    try {
      input.sink.appendEvent(input.runId, "transcript_upload_failed", {
        error: `uploaded but failed to delete scratch session file: ${
          err instanceof Error ? err.message : String(err)
        }`,
        ref: stored.ref,
      });
    } catch {
      // Same contractual guard as above.
    }
  }
  return { ref: stored.ref, sha256, bytes };
}
