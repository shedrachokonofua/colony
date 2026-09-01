import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "bun:test";
import type { RunAuditSink } from "./audit-sink.js";
import { captureTranscript } from "./transcript-capture.js";

const FIXTURE = join(import.meta.dir, "testdata", "transcript-fixture.jsonl");
const OUT_FILE = join(
  import.meta.dir,
  "testdata",
  "out",
  "transcript-redacted.jsonl",
);
/** Secrets the fixture must not survive redaction with. */
const RAW_TOKEN = "glpat-fixture-AbCdEf123456";
const STUB_TOKEN = "stub-run-token-SECRET";

interface RecordedRow {
  runId: string;
  kind: string;
  key: string;
  bytes: number;
  sha256: string;
  contentType: string;
  data: Uint8Array;
}

interface RecordedEvent {
  event: string;
  detail: Record<string, unknown>;
}

/** Recording stub sink: keeps every putArtifact payload and event append. */
function recordingSink(): {
  sink: RunAuditSink;
  artifacts: RecordedRow[];
  events: RecordedEvent[];
} {
  const artifacts: RecordedRow[] = [];
  const events: RecordedEvent[] = [];
  return {
    artifacts,
    events,
    sink: {
      appendEvent: (_runId, event, detail) => {
        events.push({ event, detail });
      },
      putArtifact: async (runId, kind, key, data, contentType) => {
        const sha256 = createHash("sha256").update(data).digest("hex");
        artifacts.push({
          runId,
          kind,
          key,
          bytes: data.byteLength,
          sha256,
          contentType,
          data,
        });
        return { ref: `blob://${key}`, bytes: data.byteLength, sha256 };
      },
      recordArtifactRef: () => {
        throw new Error("recordArtifactRef must not be used for transcripts");
      },
    },
  };
}

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("captureTranscript", () => {
  it("redacts every line, gzips, stores via putArtifact, and deletes the source", async () => {
    const { sink, artifacts } = recordingSink();
    const dir = mkdtempSync(join(tmpdir(), "transcript-capture-"));
    scratchDirs.push(dir);
    const sessionFile = join(dir, "session.jsonl");
    copyFileSync(FIXTURE, sessionFile);

    const result = await captureTranscript({
      runId: "run-fixture",
      sessionFile,
      secrets: [STUB_TOKEN],
      sink,
    });

    expect(result).toBeDefined();
    // Exactly one run_artifacts row: kind transcript, key runs/<runId>/transcript.jsonl.gz.
    expect(artifacts).toHaveLength(1);
    const row = artifacts[0]!;
    expect(row.kind).toBe("transcript");
    expect(row.key).toBe("runs/run-fixture/transcript.jsonl.gz");
    expect(row.contentType).toBe("application/gzip");
    expect(row.runId).toBe("run-fixture");

    // The recorded row's metadata describes exactly the stored bytes.
    expect(row.sha256).toBe(
      createHash("sha256").update(row.data).digest("hex"),
    );
    expect(row.bytes).toBe(row.data.byteLength);
    expect(result!.sha256).toBe(row.sha256);
    expect(result!.bytes).toBe(row.bytes);
    expect(result!.ref).toBe("blob://runs/run-fixture/transcript.jsonl.gz");

    // Gunzip and persist the redacted transcript for operator inspection.
    const redacted = gunzipSync(Buffer.from(row.data)).toString("utf8");
    mkdirSync(join(import.meta.dir, "testdata", "out"), { recursive: true });
    writeFileSync(OUT_FILE, redacted, "utf8");

    // Line-by-line redaction: same line count as the fixture, both secrets
    // gone, stable marker present.
    const fixtureLines = readFileSync(FIXTURE, "utf8").split("\n");
    const outLines = redacted.split("\n");
    expect(outLines).toHaveLength(fixtureLines.length);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain(RAW_TOKEN);
    expect(redacted).not.toContain(STUB_TOKEN);
    expect(existsSync(OUT_FILE)).toBe(true);
    // Success deletes the scratch session file.
    expect(existsSync(sessionFile)).toBe(false);
  });

  it("silently skips a session the SDK never materialized", async () => {
    const events: RecordedEvent[] = [];
    const dir = mkdtempSync(join(tmpdir(), "transcript-capture-absent-"));
    scratchDirs.push(dir);
    const sessionFile = join(dir, "session.jsonl");
    const sink: RunAuditSink = {
      appendEvent: (_runId, event, detail) => {
        events.push({ event, detail });
      },
      putArtifact: () => {
        throw new Error("putArtifact must not be reached");
      },
      recordArtifactRef: () => {},
    };

    // A run that dies before its first assistant message leaves the SDK's
    // lazy gate unmaterialized. That is an absent transcript, not a store
    // outage: no artifact, and above all no transcript_upload_failed event,
    // which an operator would read as an artifact-store failure.
    const result = await captureTranscript({
      runId: "run-absent",
      sessionFile,
      secrets: [],
      sink,
    });

    expect(result).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("keeps the session file and appends transcript_upload_failed when the upload fails", async () => {
    const events: RecordedEvent[] = [];
    const dir = mkdtempSync(join(tmpdir(), "transcript-capture-fail-"));
    scratchDirs.push(dir);
    const sessionFile = join(dir, "session.jsonl");
    copyFileSync(FIXTURE, sessionFile);
    const failingSink: RunAuditSink = {
      appendEvent: (_runId, event, detail) => {
        events.push({ event, detail });
      },
      putArtifact: () => Promise.resolve(undefined),
      recordArtifactRef: () => {},
    };

    const result = await captureTranscript({
      runId: "run-fail",
      sessionFile,
      secrets: [STUB_TOKEN],
      sink: failingSink,
    });

    expect(result).toBeUndefined();
    expect(
      events.some(
        (entry) =>
          entry.event === "transcript_upload_failed" &&
          typeof entry.detail.error === "string" &&
          entry.detail.error.length > 0,
      ),
    ).toBe(true);
    // Source kept: the transcript is not lost when the upload fails.
    expect(existsSync(sessionFile)).toBe(true);
  });

  it("appends transcript_upload_failed when the stored hash disagrees with the sent bytes", async () => {
    const events: RecordedEvent[] = [];
    const dir = mkdtempSync(join(tmpdir(), "transcript-capture-evil-"));
    scratchDirs.push(dir);
    const sessionFile = join(dir, "session.jsonl");
    copyFileSync(FIXTURE, sessionFile);
    const lyingSink: RunAuditSink = {
      appendEvent: (_runId, event, detail) => {
        events.push({ event, detail });
      },
      putArtifact: () =>
        Promise.resolve({
          ref: "blob://runs/run-evil/transcript.jsonl.gz",
          bytes: 1,
          sha256: "deadbeef",
        }),
      recordArtifactRef: () => {},
    };

    const result = await captureTranscript({
      runId: "run-evil",
      sessionFile,
      secrets: [],
      sink: lyingSink,
    });

    expect(result).toBeUndefined();
    expect(
      events.some(
        (entry) =>
          entry.event === "transcript_upload_failed" &&
          String(entry.detail.error).includes("mismatch"),
      ),
    ).toBe(true);
    expect(existsSync(sessionFile)).toBe(true);
  });
});
