import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createLocalArtifactStore, Store } from "@colony/core";
import { afterEach, describe, expect, it } from "bun:test";
import { createRunAuditSink, noopRunAuditSink } from "@colony/agent-runtime";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function wiredSink() {
  const root = mkdtempSync(join(tmpdir(), "colony-audit-sink-"));
  scratchDirs.push(root);
  const store = new Store(join(root, "test.db"));
  const artifacts = createLocalArtifactStore(join(root, "artifacts"));
  const scope = store.createScope({
    goal: "audit sink wiring",
    title: "audit sink wiring",
    provider_repo_id: "1",
    provider_repo_path: "so/fake",
  });
  const run = store.startRun({
    scope_id: scope.id,
    kind: "implement",
    lease_ttl_ms: 60_000,
  });
  return { store, artifacts, runId: run.id, root };
}

describe("createRunAuditSink", () => {
  it("putArtifact stores the blob and records the run_artifacts row", async () => {
    const { store, artifacts, runId, root } = wiredSink();
    const sink = createRunAuditSink(store, artifacts);
    const data = new TextEncoder().encode("blob body for the audit ledger");

    const result = await sink.putArtifact(
      runId,
      "tool_output",
      "runs/x/output.txt",
      data,
      "text/plain",
    );
    expect(result).toBeDefined();
    const expectedSha = createHash("sha256").update(data).digest("hex");
    expect(result!.sha256).toBe(expectedSha);
    expect(result!.bytes).toBe(data.byteLength);

    const { items, total } = store.listRunArtifacts(runId);
    expect(total).toBe(1);
    const row = items[0]!;
    expect(row.kind).toBe("tool_output");
    expect(row.key).toBe("runs/x/output.txt");
    expect(row.ref).toBe(result!.ref);
    expect(row.sha256).toBe(expectedSha);
    expect(row.bytes).toBe(data.byteLength);
    expect(row.content_type).toBe("text/plain");

    // The bytes really landed in the artifact store under the returned ref.
    const stored = await artifacts.get(result!.ref);
    expect(stored).toBeDefined();
    expect(new TextDecoder().decode(stored)).toBe(
      "blob body for the audit ledger",
    );
    // And the local backend layout agrees with the recorded ref.
    expect(readFileSync(join(root, "artifacts", result!.ref), "utf8")).toBe(
      "blob body for the audit ledger",
    );
  });

  it("putArtifact resolves undefined and records no row when the store fails", async () => {
    const { store, artifacts, runId } = wiredSink();
    const sink = createRunAuditSink(store, artifacts);
    // A key escaping the backend root is rejected before any bytes move.
    await expect(
      sink.putArtifact(
        runId,
        "tool_output",
        "../escape.txt",
        new Uint8Array(4),
        "text/plain",
      ),
    ).resolves.toBeUndefined();
    expect(store.listRunArtifacts(runId).total).toBe(0);
  });

  it("putArtifact resolves undefined when the run_artifacts insert fails", async () => {
    const { artifacts } = wiredSink();
    const sink = createRunAuditSink(artifacts as never, artifacts);
    await expect(
      sink.putArtifact(
        "missing-run",
        "tool_output",
        "k.txt",
        new Uint8Array(4),
        "text/plain",
      ),
    ).resolves.toBeUndefined();
  });

  it("putArtifact records the backend's byte count", async () => {
    const { store, runId, root } = wiredSink();
    // The row must describe the stored object, so the backend's own count
    // flows through — the S3 backend knows it exactly (payload bytes PUT).
    const countingBackend = createLocalArtifactStore(join(root, "counting"));
    const sink = createRunAuditSink(store, {
      ...countingBackend,
      put: async (key, data, meta) => {
        const stored = await countingBackend.put(key, data, meta);
        // 99 deliberately disagrees with the 26 payload bytes: if the sink
        // recomputed the size from `data` (the old workaround), the row would
        // say 26. Only the backend's count may land.
        return { ref: stored.ref, bytes: 99 };
      },
    });
    const data = new TextEncoder().encode("payload-of-seventeen-bytes");

    const result = await sink.putArtifact(
      runId,
      "tool_output",
      "runs/x/counted.txt",
      data,
      "text/plain",
    );
    expect(result).toBeDefined();
    expect(result!.bytes).toBe(99);
    const row = store.listRunArtifacts(runId).items[0]!;
    expect(row.bytes).toBe(99);
    expect(row.sha256).toBe(createHash("sha256").update(data).digest("hex"));
  });

  it("appendEvent persists events and swallows store failures", () => {
    const { store, artifacts, runId } = wiredSink();
    const sink = createRunAuditSink(store, artifacts);
    sink.appendEvent(runId, "command", { command: "ls" });
    const events = store.listRunEvents(runId).events;
    expect(events.length).toBe(1);
    expect(events[0]!.event).toBe("command");
    expect(JSON.parse(events[0]!.detail_json)).toEqual({ command: "ls" });

    const broken = createRunAuditSink(store, artifacts, {
      warn: () => {},
    });
    // A throwing logger must not break the swallow either.
    expect(() =>
      broken.appendEvent("no-such-run", "command", {}),
    ).not.toThrow();
  });

  it("noopRunAuditSink is inert", async () => {
    expect(() =>
      noopRunAuditSink.appendEvent("r", "command", {}),
    ).not.toThrow();
    await expect(
      noopRunAuditSink.putArtifact(
        "r",
        "k",
        "k",
        new Uint8Array(0),
        "text/plain",
      ),
    ).resolves.toBeUndefined();
  });
});
