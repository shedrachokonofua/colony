#!/usr/bin/env -S tsx
// One-shot synthetic data seed for the COL-0.12 Web UI shell.
// Writes a scope + two tasks with one "blocks" edge, then records an event
// so the audit timeline has something to show.

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ActorId, ScopeId, TaskId } from "@colony/domain";
import { createPool, TaskGraphRepository } from "@colony/db";

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"),
  quiet: true,
});

const url =
  process.env["DATABASE_URL"] ??
  "postgres://colony:colony@localhost:5432/colony";

const ACTOR = "human:op-1" as ActorId;
const SCOPE = "col-uidemo" as ScopeId;
const T1 = "col-uidemo.1" as TaskId;
const T2 = "col-uidemo.2" as TaskId;

const pool = createPool({ connectionString: url, role: "colony_writer" });
const repo = new TaskGraphRepository(pool);

try {
  const existing = await repo.getScope(SCOPE);
  if (existing) {
    console.log(`Scope ${SCOPE} already present — skipping seed.`);
  } else {
    await repo.createScope(
      {
        id: SCOPE,
        title: "UI shell demo",
        description:
          "Synthetic scope created by scripts/seed-synthetic.ts for the Web UI shell.",
      },
      { actor: ACTOR, capability: "graph.write", reason: "seed" },
    );
    await repo.createTask(
      {
        id: T1,
        scope_id: SCOPE,
        title: "Design data pipeline",
        description: "Sketch the ingestion → transform → load path.",
        acceptance_criteria: [
          "pipeline steps enumerated",
          "one happy path documented",
        ],
      },
      { actor: ACTOR, capability: "graph.write", reason: "seed" },
    );
    await repo.createTask(
      {
        id: T2,
        scope_id: SCOPE,
        title: "Implement transform stage",
        description:
          "Build the transform stage once the pipeline design is approved.",
        acceptance_criteria: ["unit tests green", "one end-to-end walkthrough"],
      },
      { actor: ACTOR, capability: "graph.write", reason: "seed" },
    );
    await repo.addDependency(T1, T2, "blocks", {
      actor: ACTOR,
      capability: "graph.write",
      reason: "seed",
    });
    await repo.recordEvent({
      scope_id: SCOPE,
      task_id: T1,
      kind: "provider_event",
      actor: ACTOR,
      payload: { source: "seed", note: "synthetic provider webhook" },
    });
    console.log(`Seeded scope ${SCOPE} with tasks ${T1}, ${T2}.`);
  }
} finally {
  await pool.end();
}
