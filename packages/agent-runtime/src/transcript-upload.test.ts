import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "bun:test";
import type { RunAuditSink } from "./audit-sink.js";
import type { PiRunResult } from "./pi-adapter.js";
import type { PiModelSpec } from "./pi-runner-common.js";
import {
  PiBaseAgentRunner,
  REVIEWER_ROLE_PROFILE,
} from "./pi-base-agent-runner.js";

const servers: Server[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface StoredArtifact {
  kind: string;
  key: string;
  sha256: string;
  bytes: number;
  contentType: string;
  /** Gunzipped payload, so a test can assert on the redacted transcript. */
  text: string;
}

interface RecordingSink {
  sink: RunAuditSink;
  artifacts: StoredArtifact[];
  events: { event: string; detail: Record<string, unknown> }[];
  /**
   * Runs of `onUpload`'s snapshot, one per putArtifact call: the state of the
   * run dir WHILE the upload is in flight. Post-run, the leak fix has already
   * removed the dir, so "was the session file kept?" is only answerable here.
   */
  observedAtUpload: string[];
}

/**
 * Sink stub that behaves like colonyd's: hashes the bytes it was handed and
 * echoes that digest back, so the runner's own hash verification is exercised
 * with a value that can only match if the bytes really are the ones stored.
 * `fail` turns it into a sink whose store step resolves `undefined`.
 */
function recordingSink(
  options: {
    fail?: boolean;
    throwOnUpload?: boolean;
    onUpload?: () => string[];
  } = {},
): RecordingSink {
  const artifacts: StoredArtifact[] = [];
  const events: { event: string; detail: Record<string, unknown> }[] = [];
  const observedAtUpload: string[] = [];
  return {
    artifacts,
    events,
    observedAtUpload,
    sink: {
      appendEvent: (_runId, event, detail) => {
        events.push({ event, detail });
      },
      putArtifact: async (_runId, kind, key, data, contentType) => {
        const sha256 = createHash("sha256").update(data).digest("hex");
        if (options.onUpload) {
          observedAtUpload.push(...options.onUpload());
        }
        if (options.throwOnUpload) {
          throw new Error("artifact store unreachable");
        }
        if (options.fail) return undefined;
        artifacts.push({
          kind,
          key,
          sha256,
          bytes: data.byteLength,
          contentType,
          text: gunzipSync(Buffer.from(data)).toString("utf8"),
        });
        return { ref: `blob://${key}`, bytes: data.byteLength, sha256 };
      },
      recordArtifactRef: () => {
        throw new Error("recordArtifactRef must not be used for transcripts");
      },
    },
  };
}

/** Where teardown parks a transcript whose upload did not succeed. */
function keptTranscriptPath(runId: string): string {
  return join(tmpdir(), "colony-pi-run-transcripts", `${runId}.jsonl`);
}

const HEAD_SHA = "d".repeat(40);

const VERDICT = {
  kind: "reviewer_verdict",
  verdict: "approve",
  summary: "Transcript capture reviewed the change.",
  findings: [],
  head_sha: HEAD_SHA,
};

/** The provider token the run redacts out of its persisted transcript. */
const RUN_TOKEN = ["glpat", "uploadtest", "ZxYwVu987654"].join("-");

interface RunScenario {
  result: PiRunResult;
  sink: RecordingSink;
  runDir: string;
}

/**
 * Drive one reviewer run against a stub provider that submits on its first
 * turn. `scratchDir` is an override ROOT, so the run dir is its `<runId>`
 * subdirectory — the shape the daemon's validate workspace uses.
 */
async function runScenario(options: {
  runId: string;
  failUpload?: boolean;
  throwOnUpload?: boolean;
  packet?: Record<string, unknown>;
}): Promise<RunScenario> {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const model = (JSON.parse(body) as { model: string }).model;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
        "cache-control": "no-cache",
      });
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-upload",
          object: "chat.completion.chunk",
          created: 1,
          model,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-upload",
                    type: "function",
                    function: {
                      name: "submit_reviewer_verdict",
                      arguments: JSON.stringify(VERDICT),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-upload",
          object: "chat.completion.chunk",
          created: 1,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const model: PiModelSpec = {
    id: "upload-test",
    name: "upload-test",
    api: "openai-completions",
    provider: "test-gateway",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };

  // An override root, not the run dir: teardown must remove only <root>/<runId>.
  const scratchDir = mkdtempSync(join(tmpdir(), "colony-transcript-upload-"));
  scratchDirs.push(scratchDir);
  const runDir = join(scratchDir, options.runId);
  const sink = recordingSink({
    fail: options.failUpload ?? false,
    throwOnUpload: options.throwOnUpload ?? false,
    // Every session file under the run dir while the upload is in flight. The
    // upload is the last point at which a kept transcript is observable.
    onUpload: () =>
      existsSync(runDir)
        ? readdirSync(runDir, { recursive: true })
            .map((entry) => String(entry))
            .filter((entry) => entry.endsWith(".jsonl"))
        : [],
  });
  const runner = new PiBaseAgentRunner(
    {
      ...REVIEWER_ROLE_PROFILE,
      workspaceMode: "scratch",
      requireRepositoryInspection: false,
      defaultTools: [],
    },
    {
      model,
      scratchDir,
      broker: { resolve: () => "test-key" },
      maxTurns: 3,
      runTimeoutMs: 30_000,
      auditSink: sink.sink,
    },
  );

  const result = await runner.run({
    runId: options.runId,
    packet: {
      goal: "Review the transcript capture change",
      head_sha: HEAD_SHA,
      ...options.packet,
    },
    environment: { role: "reviewer" },
  });
  return { result, sink, runDir };
}

describe("run transcript upload", () => {
  it("stores one transcript artifact, redacts the run token, and removes the run dir", async () => {
    const { result, sink, runDir } = await runScenario({
      runId: "upload-green",
      packet: {
        repo: {
          url: "so/colony",
          branch: "colony/col-66b8a6c8.6",
          base_commit: "e".repeat(40),
          credentials: { token: RUN_TOKEN },
        },
      },
    });

    // The run result is the verdict the model submitted — capture never
    // touches it.
    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(VERDICT);

    // Exactly one artifact row: kind transcript under runs/<runId>/. The row
    // is written by putArtifact; the runner records it once, never twice.
    expect(sink.artifacts).toHaveLength(1);
    const row = sink.artifacts[0]!;
    expect(row.kind).toBe("transcript");
    expect(row.key).toBe("runs/upload-green/transcript.jsonl.gz");
    expect(row.contentType).toBe("application/gzip");
    expect(row.bytes).toBeGreaterThan(0);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The transcript really is the session JSONL, redacted: the run token
    // must not survive into the artifact even though the packet that seeded
    // the workspace carries it.
    expect(row.text).toContain('"type":"session"');
    expect(row.text).not.toContain(RUN_TOKEN);

    // No failure event: the upload succeeded.
    expect(
      sink.events.filter((entry) => entry.event === "transcript_upload_failed"),
    ).toHaveLength(0);

    // Leak fix: the run dir is gone, and the override root survives.
    expect(existsSync(runDir)).toBe(false);
    expect(existsSync(join(runDir, ".."))).toBe(true);
  });

  it("keeps the result, records transcript_upload_failed, and keeps the transcript when the upload fails", async () => {
    const { result, sink, runDir } = await runScenario({
      runId: "upload-fail",
      failUpload: true,
    });

    // Capture is strictly post-decision: a failed upload cannot change the
    // envelope or invent a failure reason.
    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(VERDICT);

    const failures = sink.events.filter(
      (entry) => entry.event === "transcript_upload_failed",
    );
    expect(failures).toHaveLength(1);
    expect(typeof failures[0]!.detail.error).toBe("string");
    expect(String(failures[0]!.detail.error).length).toBeGreaterThan(0);
    expect(sink.artifacts).toHaveLength(0);

    // The upload was attempted at all, and the session file was still there
    // while it ran: a failed upload keeps the transcript rather than trusting
    // an artifact row that was never written.
    expect(sink.observedAtUpload).toHaveLength(1);
    expect(sink.observedAtUpload[0]!.length).toBeGreaterThan(0);

    // The point of keeping it: the transcript still exists AFTER the run,
    // outside the swept run dir. It survives because teardown parked it
    // there; a copy left inside the run dir would have died with the sweep.
    expect(existsSync(runDir)).toBe(false);
    expect(existsSync(join(runDir, ".."))).toBe(true);
    const kept = keptTranscriptPath("upload-fail");
    expect(existsSync(kept)).toBe(true);
    expect(readFileSync(kept, "utf8")).toContain('"type":"session"');
    rmSync(kept, { force: true });
  });

  it("turns a throwing sink into transcript_upload_failed without changing the result or leaking the run dir", async () => {
    // The contract says putArtifact never rejects, but capture runs AFTER the
    // result is decided: a sink that breaks its contract must still only cost
    // the transcript, never the run.
    const { result, sink, runDir } = await runScenario({
      runId: "upload-throws",
      throwOnUpload: true,
    });

    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(VERDICT);

    const failures = sink.events.filter(
      (entry) => entry.event === "transcript_upload_failed",
    );
    expect(failures).toHaveLength(1);
    expect(String(failures[0]!.detail.error)).toContain(
      "artifact store unreachable",
    );
    expect(sink.artifacts).toHaveLength(0);

    // Teardown still ran all the way through: the leak is fixed even when
    // capture blows up, and the transcript was parked outside the run dir.
    expect(existsSync(runDir)).toBe(false);
    expect(existsSync(join(runDir, ".."))).toBe(true);
    expect(existsSync(keptTranscriptPath("upload-throws"))).toBe(true);
    rmSync(keptTranscriptPath("upload-throws"), { force: true });
  });
});
