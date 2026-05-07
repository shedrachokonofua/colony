import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { describe, expect, it } from "vitest";
import {
  RECONCILE_INTERVAL,
  type LongRunningSupervisorActivities,
  type SupervisorActivities,
  reconcileActivityIdempotencyKey,
  scopeSupervisorWorkflow,
  supervisorWorkflowId,
} from "./index.js";

describe("@colony/workflows reconciliation timer helpers", () => {
  it("uses the Phase 3 periodic reconciliation cadence", () => {
    expect(RECONCILE_INTERVAL).toBe("5 minutes");
  });

  it("builds deterministic reconcile activity idempotency keys", () => {
    expect(
      reconcileActivityIdempotencyKey({
        scope_id: "col-phase3",
        workflow_id: supervisorWorkflowId("col-phase3"),
        run_id: "run-1",
        sequence: 7,
      }),
    ).toBe("supervisor-col-phase3:run-1:reconcile:col-phase3:7");
  });
});

const temporalTestEnabled = process.env["COLONY_TEMPORAL_TEST"] === "1";

function resolved<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

describe.runIf(temporalTestEnabled)(
  "@colony/workflows Temporal supervisor",
  () => {
    it("drives the plan gate before each developer run in a reviewer rework loop", async () => {
      const address = process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233";
      const namespace = process.env["TEMPORAL_NAMESPACE"] ?? "default";
      const connection = await Connection.connect({ address });
      const nativeConnection = await NativeConnection.connect({ address });
      const client = new Client({ connection, namespace });
      const taskQueue = `colony-workflow-test-${randomUUID()}`;
      const scopeId = "col-temporal";
      const taskId = "col-temporal.1";
      const calls: string[] = [];
      let planRun = 0;
      let developerRun = 0;
      let reviewerRun = 0;

      const activities: SupervisorActivities & LongRunningSupervisorActivities =
        {
          readScopeState: () => {
            calls.push("readScopeState");
            return resolved({
              scope: { id: scopeId, state: "active", state_version: 0 },
              tasks: [],
            });
          },
          claimReadyTask: () => {
            calls.push("claimReadyTask");
            return resolved({
              claimed: true,
              task_id: taskId,
              assignee: "bot:engine",
            });
          },
          startDeveloperPlanRun: () => {
            planRun += 1;
            calls.push(`startDeveloperPlanRun:${planRun}`);
            if (planRun === 1) {
              throw new Error("transient planner stream failure");
            }
            return resolved({
              started: true,
              task_id: taskId,
              envelope_status: "succeeded",
              final_state: "plan_proposed",
              developer_plan: { planRun },
            });
          },
          startPlanReviewRun: (input) => {
            calls.push(
              `startPlanReviewRun:${(input.developer_plan as { planRun: number }).planRun}`,
            );
            return resolved({
              started: true,
              task_id: taskId,
              envelope_status: "succeeded",
              review_result: "approved",
              final_state: "in_progress",
              plan_review: { approvedPlan: input.developer_plan },
            });
          },
          startDeveloperRun: () => {
            developerRun += 1;
            calls.push(`startDeveloperRun:${developerRun}`);
            return resolved({
              started: true,
              task_id: taskId,
              run_id: `dev-${developerRun}`,
              envelope_status: "succeeded",
              final_state: "review_requested",
              developer_envelope: { developerRun },
            });
          },
          openMrGate: () => {
            calls.push("openMrGate");
            return resolved({ opened: true, gate_id: "gate-1" });
          },
          startReviewerRun: (input) => {
            reviewerRun += 1;
            calls.push(
              `startReviewerRun:${(input.developer_envelope as { developerRun: number }).developerRun}`,
            );
            return resolved({
              started: true,
              task_id: taskId,
              run_id: `review-${reviewerRun}`,
              review_id: `review-${reviewerRun}`,
              envelope_status: "succeeded",
              review_result:
                reviewerRun === 1 ? "changes_requested" : "approved",
              final_state:
                reviewerRun === 1 ? "changes_requested" : "review_requested",
            });
          },
          scopeHeartbeatTick: () => {
            calls.push("scopeHeartbeatTick");
            return resolved({
              scope_id: scopeId,
              status: "scope_terminal",
            });
          },
          recordWorkflowEvent: () => resolved({ recorded: true }),
          reconcileScope: () =>
            resolved({
              scope_id: scopeId,
              checked_at: "2026-05-04T00:00:00.000Z",
              ok: true,
              auto_corrected: 0,
              conflicts: 0,
              warnings: 0,
            }),
          recordHumanApproval: () =>
            resolved({
              recorded: true,
              approval_id: "approval-1",
            }),
          recordPipelineStatus: () =>
            resolved({
              recorded: true,
              invalidated_approvals: 0,
            }),
          checkMrGate: () =>
            resolved({
              checked: true,
              task_id: taskId,
              final_state: "merge_ready",
              gate_open: false,
              reasons: [],
            }),
          mergeTask: () =>
            resolved({
              merged: false,
              task_id: taskId,
              reason: "gate_closed",
            }),
          closeTaskAfterMerge: () =>
            resolved({
              closed: false,
              task_id: taskId,
              reason: "not_merged",
            }),
          applyDecompositionCommand: () =>
            resolved({
              applied: false,
              reason: "not_used",
            }),
          requestTaskRework: () =>
            resolved({
              applied: true,
              task_id: taskId,
              previous_state: "review_requested",
              new_state: "changes_requested",
              invalidated_approvals: 0,
              rework_count: 1,
            }),
          checkProviderHealth: () =>
            resolved({
              provider: "fake",
              ok: true,
              checked_at: "2026-05-04T00:00:00.000Z",
            }),
          markScopePendingSync: () =>
            resolved({
              scope_id: scopeId,
              transitioned: 0,
              skipped: 0,
              already_pending: 0,
              task_ids: [],
            }),
          markTaskFailed: () => {
            calls.push("markTaskFailed");
            return resolved({
              marked: true,
              task_id: taskId,
              previous_state: "plan_proposed",
              new_state: "failed",
            });
          },
          startArchitectRun: () =>
            resolved({
              started: false,
              scope_id: scopeId,
              reason: "not_used",
            }),
          startDecompositionReviewRun: () =>
            resolved({
              started: false,
              scope_id: scopeId,
              reason: "not_used",
            }),
        };

      try {
        const worker = await Worker.create({
          connection: nativeConnection,
          namespace,
          taskQueue,
          workflowsPath: resolve(
            dirname(fileURLToPath(import.meta.url)),
            "index.ts",
          ),
          activities,
        });
        await worker.runUntil(
          client.workflow.execute(scopeSupervisorWorkflow, {
            taskQueue,
            workflowId: `workflow-${randomUUID()}`,
            args: [scopeId],
          }),
        );
      } finally {
        await nativeConnection.close();
        await connection.close();
      }

      expect(calls).toEqual([
        "readScopeState",
        "claimReadyTask",
        "startDeveloperPlanRun:1",
        "startDeveloperPlanRun:2",
        "startPlanReviewRun:2",
        "startDeveloperRun:1",
        "openMrGate",
        "startReviewerRun:1",
        "startDeveloperPlanRun:3",
        "startPlanReviewRun:3",
        "startDeveloperRun:2",
        "openMrGate",
        "startReviewerRun:2",
        "scopeHeartbeatTick",
      ]);
    }, 120_000);
  },
);
