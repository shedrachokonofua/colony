import { createHash } from "node:crypto";
import type { ArtifactStore, Store } from "@colony/core";

/**
 * Audit-facing sink for a run: activity events and artifact rows. colonyd
 * builds the real one (`createRunAuditSink`) from its store + artifact store;
 * tests and roles without an engine use `noopRunAuditSink`.
 *
 * `putArtifact` is THE single path that records a `run_artifacts` row for any
 * stored blob: it stores the bytes via the artifact store, then records the
 * row, so the row and the bytes can never disagree about `sha256`/`bytes`.
 * `recordArtifactRef` records a row for content that was NOT stored here
 * (e.g. a git ref the run created) and takes its metadata on faith.
 */
export interface RunAuditSink {
  /** Best-effort activity feed append. Never throws. */
  appendEvent(
    runId: string,
    event: string,
    detail: Record<string, unknown>,
  ): void;
  /**
   * Store bytes and record the artifact row in one step. Never rejects: on
   * any failure it resolves `undefined` and records no row, so a missing row
   * always means missing bytes — never half a record.
   */
  putArtifact(
    runId: string,
    kind: string,
    key: string,
    data: Uint8Array,
    contentType: string,
  ): Promise<{ ref: string; bytes: number; sha256: string } | undefined>;
  /** Record a row for a non-blob artifact (a git ref). Never throws. */
  recordArtifactRef(
    runId: string,
    kind: string,
    key: string,
    ref: string,
    sha256?: string,
    bytes?: number,
    contentType?: string,
  ): void;
}

export const noopRunAuditSink: RunAuditSink = {
  appendEvent: () => {},
  putArtifact: () => Promise.resolve(undefined),
  recordArtifactRef: () => {},
};

/**
 * colonyd's sink over the daemon's store and artifact store. Every call is
 * best-effort: the activity feed and artifact ledger must never break a run,
 * so failures are swallowed and logged.
 */
export function createRunAuditSink(
  store: Store,
  artifacts: ArtifactStore,
  logger?: { warn?(fields: Record<string, unknown>, message: string): void },
): RunAuditSink {
  return {
    appendEvent(runId, event, detail) {
      try {
        store.appendRunEvent(runId, event, detail);
      } catch (err) {
        logger?.warn?.(
          {
            runId,
            event,
            error: err instanceof Error ? err.message : String(err),
          },
          "audit_sink_append_event_failed",
        );
      }
    },
    async putArtifact(runId, kind, key, data, contentType) {
      try {
        const { ref } = await artifacts.put(key, data, {
          contentType,
        });
        const sha256 = createHash("sha256").update(data).digest("hex");
        // The row and the resolved value describe exactly the bytes hashed
        // above. The backend's own count is backend-dependent (the S3 backend
        // reads a response header that can disagree with the payload), so it
        // is never trusted here.
        const bytes = data.byteLength;
        try {
          store.recordRunArtifact(runId, {
            kind,
            key,
            ref,
            sha256,
            bytes,
            contentType,
          });
        } catch (err) {
          logger?.warn?.(
            {
              runId,
              kind,
              key,
              error: err instanceof Error ? err.message : String(err),
            },
            "audit_sink_record_artifact_failed",
          );
          return undefined;
        }
        return { ref, bytes, sha256 };
      } catch (err) {
        logger?.warn?.(
          {
            runId,
            kind,
            key,
            error: err instanceof Error ? err.message : String(err),
          },
          "audit_sink_put_artifact_failed",
        );
        return undefined;
      }
    },
    recordArtifactRef(runId, kind, key, ref, sha256, bytes, contentType) {
      try {
        store.recordRunArtifact(runId, {
          kind,
          key,
          ref,
          sha256,
          bytes,
          contentType,
        });
      } catch (err) {
        logger?.warn?.(
          {
            runId,
            kind,
            key,
            error: err instanceof Error ? err.message : String(err),
          },
          "audit_sink_record_artifact_ref_failed",
        );
      }
    },
  };
}
