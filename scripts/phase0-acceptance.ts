#!/usr/bin/env -S tsx
// Phase 0 acceptance demo:
// - creates a fresh synthetic scope with tasks and a dependency
// - proves exactly one of two concurrent repository claimers wins
// - verifies the scope audit trail contains every expected mutation

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

const webUrl = process.env["COLONY_WEB_URL"] ?? "http://localhost:3000";
const scopeId = (process.env["COLONY_ACCEPTANCE_SCOPE_ID"] ??
  `col-p0${Date.now().toString(36)}`) as ScopeId;
const taskA = `${scopeId}.1` as TaskId;
const taskB = `${scopeId}.2` as TaskId;

const supervisor = "svc:supervisor" as ActorId;
const dev1 = "agent:dev-1" as ActorId;
const dev2 = "agent:dev-2" as ActorId;

const pool = createPool({ connectionString: url, role: "colony_writer" });
const repo = new TaskGraphRepository(pool);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  const existing = await repo.getScope(scopeId);
  assert(!existing, `scope already exists: ${scopeId}`);

  await repo.createScope(
    {
      id: scopeId,
      title: "Phase 0 acceptance",
      description:
        "Synthetic end-to-end acceptance scope for Task Graph, audit, and Web UI visibility.",
    },
    {
      actor: supervisor,
      capability: "graph.write",
      reason: "phase0_acceptance",
    },
  );

  await repo.createTask(
    {
      id: taskA,
      scope_id: scopeId,
      title: "Claimable acceptance task",
      description:
        "Two concurrent claimers race this task; exactly one must win.",
      acceptance_criteria: ["exactly one claimer wins"],
      state: "ready",
    },
    {
      actor: supervisor,
      capability: "graph.write",
      reason: "phase0_acceptance",
    },
  );

  await repo.createTask(
    {
      id: taskB,
      scope_id: scopeId,
      title: "Blocked follow-up task",
      description:
        "This task proves dependency and audit data are visible in the Web UI.",
      acceptance_criteria: ["dependency appears on the task detail page"],
      state: "ready",
    },
    {
      actor: supervisor,
      capability: "graph.write",
      reason: "phase0_acceptance",
    },
  );

  await repo.addDependency(taskA, taskB, "blocks", {
    actor: supervisor,
    capability: "graph.write",
    reason: "phase0_acceptance",
  });

  await repo.withTransaction(async (tx) => {
    const event = await tx.recordEvent({
      scope_id: scopeId,
      task_id: taskA,
      kind: "provider_event",
      actor: supervisor,
      payload: {
        source: "phase0_acceptance",
        note: "synthetic provider event for the audit timeline",
      },
    });
    await tx.writeAudit({
      scope_id: scopeId,
      task_id: taskA,
      actor: supervisor,
      action: "event.record",
      capability: "graph.write",
      target_kind: "event",
      target_id: event.id,
      reason: "phase0_acceptance",
      evidence: { kind: event.kind },
    });
  });

  const [claim1, claim2] = await Promise.all([
    repo.claimTask(taskA, dev1, 0, {
      actor: supervisor,
      capability: "task.claim",
      reason: "phase0_acceptance",
    }),
    repo.claimTask(taskA, dev2, 0, {
      actor: supervisor,
      capability: "task.claim",
      reason: "phase0_acceptance",
    }),
  ]);

  const winners = [claim1, claim2].filter((claim) => claim !== null);
  assert(
    winners.length === 1,
    `expected one claim winner, got ${winners.length}`,
  );
  assert(winners[0]?.state === "claimed", "winning claim did not claim task");

  const audit = await repo.listAuditForScope(scopeId, { limit: 100 });
  const actions = audit.map((record) => record.action);
  for (const action of [
    "scope.create",
    "task.create",
    "dependency.add",
    "event.record",
    "task.claim",
    "task.claim_failed",
  ]) {
    assert(actions.includes(action), `missing audit action: ${action}`);
  }

  const createdTaskAudits = audit.filter(
    (record) => record.action === "task.create",
  );
  assert(
    createdTaskAudits.length === 2,
    `expected 2 task.create audit rows, got ${createdTaskAudits.length}`,
  );

  const deps = await repo.getTaskDependencies(taskB);
  assert(
    deps.blocked_by.includes(taskA),
    `expected ${taskB} to be blocked by ${taskA}`,
  );

  const winner = winners[0];
  console.log("Phase 0 acceptance passed");
  console.log(`scope: ${scopeId}`);
  console.log(`claim winner: ${winner?.assignee}`);
  console.log(`audit rows: ${audit.length}`);
  console.log(`scope UI: ${webUrl}/scopes/${scopeId}`);
  console.log(`claimed task UI: ${webUrl}/scopes/${scopeId}/tasks/${taskA}`);
  console.log(`blocked task UI: ${webUrl}/scopes/${scopeId}/tasks/${taskB}`);
} finally {
  await pool.end();
}
