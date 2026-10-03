import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Store } from "@colony/core";
import { createRunEventSink } from "../src/agent-runtime.js";

// Kept out of run-model-fallback.test.ts (a file edited concurrently
// elsewhere): this is the served-model half of the sink's model attribution.
const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seededRun(modelId: string): {
  store: Store;
  runId: string;
} {
  const dbDir = mkdtempSync(join(tmpdir(), "colony-served-model-"));
  dirs.push(dbDir);
  const store = new Store(join(dbDir, "test.db"));
  stores.push(store);
  const scope = store.createScope({
    goal: "served model sink",
    title: "served model sink",
    provider_repo_id: "1",
    provider_repo_path: "so/fake",
  });
  const run = store.startRun({
    scope_id: scope.id,
    kind: "implement",
    lease_ttl_ms: 60_000,
    model_id: modelId,
  });
  return { store, runId: run.id };
}

describe("createRunEventSink served-model attribution", () => {
  it("rewrites runs.served_model_id on pi_served_model and keeps the configured model_id", () => {
    const { store, runId } = seededRun("moira/strong");
    const sink = createRunEventSink(store);

    sink(runId, "pi_served_model", {
      model: "xiaomi/mimo-v2.6-pro",
      model_id: "deployment-1",
    });

    expect(store.getRun(runId)).toMatchObject({
      model_id: "moira/strong",
      served_model_id: "xiaomi/mimo-v2.6-pro",
    });

    // A routing change overwrites the served model only.
    sink(runId, "pi_served_model", { model: "zai/glm-5.3" });
    expect(store.getRun(runId)).toMatchObject({
      model_id: "moira/strong",
      served_model_id: "zai/glm-5.3",
    });
  });

  it("ignores a served-model event without a model name", () => {
    const { store, runId } = seededRun("moira/flash");
    const sink = createRunEventSink(store);

    sink(runId, "pi_served_model", { model_id: "deployment-1" });

    expect(store.getRun(runId)!.served_model_id).toBeNull();
  });
});
