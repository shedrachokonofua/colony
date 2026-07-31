import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { describe, expect, it } from "vitest";
import {
  RECONCILE_INTERVAL,
  architectRequestedSignal,
  type LongRunningSupervisorActivities,
  type SupervisorActivities,
  operatorOverrideSignal,
  providerEventSignal,
  pipelineUpdateSignal,
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
          commitDecompositionProposal: () =>
            resolved({
              committed: false,
              reason: "not_used",
            }),
          syncCommittedTasksToProvider: () =>
            resolved({ projected: 0, skipped: 0, failed: 0, failures: [] }),
          mergeSpecMergeRequest: () =>
            resolved({
              merged: true,
              scope_id: scopeId,
              already_merged: true,
            }),
          autoApproveDecomposition: () =>
            resolved({
              approved: false,
              reason: "not_used",
            }),
          autoApproveTaskMerge: () =>
            resolved({
              recorded: false,
              reason: "not_used",
            }),
          autoCloseScope: () =>
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
          requestArchitectReplan: () =>
            resolved({ replanned: false, reason: "not_used" }),
          applyOperatorOverride: (input) => {
            calls.push(`applyOperatorOverride:${input.target}:${input.action}`);
            return resolved({
              applied: true,
              target: input.target,
              previous_state: "review_requested",
              new_state: input.target === "task" ? "blocked" : "canceled",
            });
          },
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
        await worker.runUntil(async () => {
          const handle = await client.workflow.start(scopeSupervisorWorkflow, {
            taskQueue,
            workflowId: `workflow-${randomUUID()}`,
            args: [scopeId],
          });
          await handle.signal(operatorOverrideSignal, {
            actor: "human:op-1",
            action: "block",
            reason: "pause for operator inspection",
            task_id: taskId,
            reference: {
              provider: "fake",
              event_id: "evt-operator-1",
            },
          });
          await handle.result();
        });
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
        "applyOperatorOverride:task:block",
        "claimReadyTask",
        "startDeveloperPlanRun:4",
        "startPlanReviewRun:4",
        "startDeveloperRun:3",
        "openMrGate",
        "startReviewerRun:3",
        "scopeHeartbeatTick",
      ]);
    }, 120_000);

    it("resumes from history after a worker shuts down before an activity retry", async () => {
      const address = process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233";
      const namespace = process.env["TEMPORAL_NAMESPACE"] ?? "default";
      const connection = await Connection.connect({ address });
      const nativeConnection1 = await NativeConnection.connect({ address });
      const nativeConnection2 = await NativeConnection.connect({ address });
      const client = new Client({ connection, namespace });
      const taskQueue = `colony-workflow-restart-test-${randomUUID()}`;
      const scopeId = "col-restart";
      const taskId = "col-restart.1";
      const calls: string[] = [];
      let planRun = 0;

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
              throw new Error("planner failed before worker restart");
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
            calls.push("startDeveloperRun");
            return resolved({
              started: true,
              task_id: taskId,
              run_id: "dev-after-restart",
              envelope_status: "succeeded",
              final_state: "review_requested",
              developer_envelope: { developerRun: "after-restart" },
            });
          },
          openMrGate: () => {
            calls.push("openMrGate");
            return resolved({ opened: true, gate_id: "gate-1" });
          },
          startReviewerRun: () => {
            calls.push("startReviewerRun");
            return resolved({
              started: true,
              task_id: taskId,
              run_id: "review-after-restart",
              review_id: "review-after-restart",
              envelope_status: "succeeded",
              review_result: "approved",
              final_state: "review_requested",
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
              checked_at: "2026-05-21T00:00:00.000Z",
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
          commitDecompositionProposal: () =>
            resolved({
              committed: false,
              reason: "not_used",
            }),
          syncCommittedTasksToProvider: () =>
            resolved({ projected: 0, skipped: 0, failed: 0, failures: [] }),
          mergeSpecMergeRequest: () =>
            resolved({
              merged: true,
              scope_id: scopeId,
              already_merged: true,
            }),
          autoApproveDecomposition: () =>
            resolved({
              approved: false,
              reason: "not_used",
            }),
          autoApproveTaskMerge: () =>
            resolved({
              recorded: false,
              reason: "not_used",
            }),
          autoCloseScope: () =>
            resolved({
              applied: false,
              reason: "not_used",
            }),
          requestTaskRework: () =>
            resolved({
              applied: false,
              task_id: taskId,
              reason: "not_used",
            }),
          requestArchitectReplan: () =>
            resolved({ replanned: false, reason: "not_used" }),
          applyOperatorOverride: () =>
            resolved({
              applied: false,
              reason: "not_used",
            }),
          checkProviderHealth: () =>
            resolved({
              provider: "fake",
              ok: true,
              checked_at: "2026-05-21T00:00:00.000Z",
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
        const worker1 = await Worker.create({
          connection: nativeConnection1,
          namespace,
          taskQueue,
          workflowsPath: resolve(
            dirname(fileURLToPath(import.meta.url)),
            "index.ts",
          ),
          activities,
        });
        const run1 = worker1.run();
        const handle = await client.workflow.start(scopeSupervisorWorkflow, {
          taskQueue,
          workflowId: `workflow-${randomUUID()}`,
          args: [scopeId],
        });

        await waitFor(() => calls.includes("startDeveloperPlanRun:1"), 15_000);
        worker1.shutdown();
        await run1;

        const worker2 = await Worker.create({
          connection: nativeConnection2,
          namespace,
          taskQueue,
          workflowsPath: resolve(
            dirname(fileURLToPath(import.meta.url)),
            "index.ts",
          ),
          activities,
        });
        await worker2.runUntil(handle.result());
      } finally {
        await nativeConnection2.close();
        await nativeConnection1.close();
        await connection.close();
      }

      expect(calls).toEqual([
        "readScopeState",
        "claimReadyTask",
        "startDeveloperPlanRun:1",
        "startDeveloperPlanRun:2",
        "startPlanReviewRun:2",
        "startDeveloperRun",
        "openMrGate",
        "startReviewerRun",
        "scopeHeartbeatTick",
      ]);
    }, 150_000);
    it("auto-approves and commits a reviewer-approved decomposition in yolo mode", async () => {
      const address = process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233";
      const namespace = process.env["TEMPORAL_NAMESPACE"] ?? "default";
      const connection = await Connection.connect({ address });
      const nativeConnection = await NativeConnection.connect({ address });
      const client = new Client({ connection, namespace });
      const taskQueue = `colony-workflow-yolo-${randomUUID()}`;
      const scopeId = "col-yolo";
      const calls: string[] = [];
      const base = makeSupervisorTestActivities(scopeId, "col-yolo.1", calls);
      const activities: SupervisorActivities & LongRunningSupervisorActivities =
        {
          ...base,
          readScopeState: () =>
            resolved({
              scope: {
                id: scopeId,
                state: "decomposition_proposed",
                state_version: 2,
              },
              hitl_mode: "yolo" as const,
              tasks: [],
            }),
          claimReadyTask: () => resolved({ claimed: false }),
          startArchitectRun: () => {
            calls.push("startArchitectRun");
            return resolved({
              started: true as const,
              scope_id: scopeId,
              run_id: "architect-1",
              envelope_status: "succeeded" as const,
              proposal_id: "proposal-1",
            });
          },
          startDecompositionReviewRun: () => {
            calls.push("startDecompositionReviewRun");
            return resolved({
              started: true as const,
              scope_id: scopeId,
              proposal_id: "proposal-1",
              run_id: "decomposition-review-1",
              envelope_status: "succeeded" as const,
              review_result: "approved" as const,
            });
          },
          autoApproveDecomposition: () => {
            calls.push("autoApproveDecomposition");
            return resolved({
              approved: true as const,
              proposal_id: "proposal-1",
              envelope_hash: "envelope-1",
            });
          },
          commitDecompositionProposal: () => {
            calls.push("commitDecompositionProposal");
            return resolved({
              committed: true as const,
              scope_id: scopeId,
              proposal_id: "proposal-1",
              task_count: 0,
              dependency_count: 0,
            });
          },
          syncCommittedTasksToProvider: () => {
            calls.push("syncCommittedTasksToProvider");
            return resolved({
              projected: 0,
              skipped: 0,
              failed: 0,
              failures: [],
            });
          },
          mergeSpecMergeRequest: () => {
            calls.push("mergeSpecMergeRequest");
            return resolved({ merged: true as const, scope_id: scopeId });
          },
          autoApproveTaskMerge: () =>
            resolved({ recorded: false as const, reason: "not_used" }),
          autoCloseScope: () =>
            resolved({ applied: false as const, reason: "not_used" }),
          scopeHeartbeatTick: () =>
            resolved({ scope_id: scopeId, status: "scope_terminal" as const }),
        };
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
      const run = worker.run();
      try {
        const handle = await client.workflow.start(scopeSupervisorWorkflow, {
          taskQueue,
          workflowId: `workflow-${randomUUID()}`,
          args: [scopeId],
        });
        await handle.signal(architectRequestedSignal, {
          actor: "human:test",
          reason: "start yolo decomposition",
        });
        await waitFor(
          () =>
            calls.includes("autoApproveDecomposition") &&
            calls.includes("commitDecompositionProposal"),
          15_000,
        );
        expect(calls).toContain("mergeSpecMergeRequest");
        expect(calls).not.toContain("recordHumanApproval");
      } finally {
        worker.shutdown();
        await run;
        await nativeConnection.close();
        await connection.close();
      }
    }, 120_000);
    it("re-drives a changes_requested task instead of leaving it parked", async () => {
      const calls: string[] = [];
      const base = makeSupervisorTestActivities(
        "col-extra",
        "col-extra.1",
        calls,
      );
      const activities: SupervisorActivities & LongRunningSupervisorActivities =
        {
          ...base,
          readScopeState: () =>
            resolved({
              scope: { id: "col-extra", state: "active", state_version: 0 },
              tasks: [
                {
                  id: "col-extra.1",
                  state: "changes_requested",
                  state_version: 3,
                  claim_version: 1,
                  assignee: "bot:engine",
                },
              ],
            }),
          claimReadyTask: () => resolved({ claimed: false }),
        };
      await runSupervisorTestScenario(activities, async (handle) => {
        await waitFor(() => calls.includes("startReviewerRun"), 15_000);
        await signalOperatorBlock(handle, "col-extra.1");
      });
      expect(calls).toContain("startDeveloperPlanRun");
      expect(calls).toContain("startDeveloperRun");
      expect(calls).toContain("startReviewerRun");
    }, 120_000);

    it("routes a planner escalation into the architect tier", async () => {
      const calls: string[] = [];
      const base = makeSupervisorTestActivities(
        "col-extra",
        "col-extra.1",
        calls,
      );
      const activities: SupervisorActivities & LongRunningSupervisorActivities =
        {
          ...base,
          startDeveloperPlanRun: () =>
            resolved({
              started: true,
              task_id: "col-extra.1",
              envelope_status: "succeeded",
              outcome: "escalate",
              final_state: "claimed",
              reason: "planner cannot resolve dependency",
            }),
          requestArchitectReplan: (input) => {
            calls.push(`requestArchitectReplan:${input.attempt}`);
            return resolved({
              replanned: true,
              reason: "split the task",
              task_ids: ["col-extra.1"],
            });
          },
        };
      await runSupervisorTestScenario(activities, async (handle) => {
        await waitFor(() => calls.includes("requestArchitectReplan:1"), 15_000);
        await signalOperatorBlock(handle, "col-extra.1");
      });
      expect(calls).toContain("requestArchitectReplan:1");
      expect(
        calls.filter((call) => call === "override:task:block"),
      ).toHaveLength(1);
    }, 120_000);

    it("blocks after architect re-plan exhaustion with ladder evidence", async () => {
      const calls: string[] = [];
      const blockedEvidence: unknown[] = [];
      const ladderEvents: object[] = [];
      const base = makeSupervisorTestActivities(
        "col-extra",
        "col-extra.1",
        calls,
      );
      const activities: SupervisorActivities & LongRunningSupervisorActivities =
        {
          ...base,
          readScopeState: () =>
            resolved({
              scope: { id: "col-extra", state: "active", state_version: 0 },
              tasks: [
                {
                  id: "col-extra.1",
                  state: "claimed",
                  state_version: 3,
                  claim_version: 1,
                  assignee: "bot:engine",
                  tier2_attempts: 2,
                  tier3_attempts: 2,
                },
              ],
            }),
          startDeveloperPlanRun: () =>
            resolved({
              started: true,
              task_id: "col-extra.1",
              envelope_status: "succeeded",
              outcome: "escalate",
              final_state: "claimed",
              reason: "planner cannot resolve dependency",
            }),
          applyOperatorOverride: (input) => {
            if (input.target === "task" && input.action === "block") {
              blockedEvidence.push(input.evidence ?? {});
            }
            return resolved({
              applied: true,
              target: input.target,
              previous_state: "claimed",
              new_state: input.target === "task" ? "blocked" : "canceled",
            });
          },
          recordWorkflowEvent: (input) => {
            if (input.kind === "task_escalation_ladder") {
              ladderEvents.push(input.payload);
            }
            return resolved({ recorded: true });
          },
        };
      await runSupervisorTestScenario(activities, async (handle) => {
        await waitFor(() => blockedEvidence.length > 0, 15_000);
        await signalOperatorBlock(handle, "col-extra.1");
      });
      expect(
        ladderEvents.some((event) => "tier" in event && event.tier === 2),
      ).toBe(true);
      expect(blockedEvidence).toContainEqual(
        expect.objectContaining({ tier: 4, attempt: 3 }),
      );
    }, 120_000);
  },
);
function makeSupervisorTestActivities(
  scopeId: string,
  taskId: string,
  calls: string[],
): SupervisorActivities & LongRunningSupervisorActivities {
  let claimCount = 0;
  return {
    readScopeState: () =>
      resolved({
        scope: { id: scopeId, state: "active", state_version: 0 },
        tasks: [],
      }),
    claimReadyTask: () => {
      claimCount += 1;
      return resolved(
        claimCount === 1
          ? { claimed: true, task_id: taskId, assignee: "bot:engine" }
          : { claimed: false },
      );
    },
    startDeveloperPlanRun: () =>
      resolved({
        started: true,
        task_id: taskId,
        envelope_status: "succeeded" as const,
        final_state: "plan_proposed" as const,
        developer_plan: { plan: true },
      }),
    startPlanReviewRun: () =>
      resolved({
        started: true,
        task_id: taskId,
        envelope_status: "succeeded" as const,
        review_result: "approved" as const,
        final_state: "in_progress" as const,
        plan_review: { approved: true },
      }),
    startDeveloperRun: () =>
      resolved({
        started: true,
        task_id: taskId,
        run_id: "developer-1",
        envelope_status: "succeeded" as const,
        final_state: "review_requested" as const,
        developer_envelope: { done: true },
      }),
    openMrGate: () => resolved({ opened: true, gate_id: "gate-1" }),
    startReviewerRun: () =>
      resolved({
        started: true,
        task_id: taskId,
        run_id: "review-1",
        review_id: "review-1",
        envelope_status: "succeeded" as const,
        review_result: "approved" as const,
        final_state: "review_requested" as const,
      }),
    recordWorkflowEvent: () => resolved({ recorded: true }),
    reconcileScope: () =>
      resolved({
        scope_id: scopeId,
        checked_at: "2026-07-30T00:00:00.000Z",
        ok: true,
        auto_corrected: 0,
        conflicts: 0,
        warnings: 0,
        tasks: [{ task_id: taskId, state: "review_requested" }],
      }),
    recordHumanApproval: () =>
      resolved({ recorded: true, approval_id: "approval-1" }),
    recordPipelineStatus: () =>
      resolved({ recorded: true, invalidated_approvals: 0 }),
    checkMrGate: () =>
      resolved({
        checked: true,
        task_id: taskId,
        final_state: "merge_ready" as const,
        gate_open: false,
        reasons: [],
      }),
    mergeTask: () =>
      resolved({ merged: false, task_id: taskId, reason: "gate_closed" }),
    closeTaskAfterMerge: () =>
      resolved({ closed: false, task_id: taskId, reason: "not_merged" }),
    applyDecompositionCommand: () =>
      resolved({ applied: false, reason: "not_used" }),
    commitDecompositionProposal: () =>
      resolved({ committed: false, reason: "not_used" }),
    syncCommittedTasksToProvider: () =>
      resolved({ projected: 0, skipped: 0, failed: 0, failures: [] }),
    mergeSpecMergeRequest: () =>
      resolved({ merged: true, scope_id: scopeId, already_merged: true }),
    requestTaskRework: () =>
      resolved({ applied: false, task_id: taskId, reason: "not_used" }),
    requestArchitectReplan: () =>
      resolved({ replanned: false, reason: "not_used" }),
    applyOperatorOverride: (input) => {
      calls.push(`override:${input.target}:${input.action}`);
      return resolved({
        applied: true,
        target: input.target,
        previous_state: "in_progress",
        new_state: input.target === "task" ? "blocked" : "canceled",
      });
    },
    checkProviderHealth: () =>
      resolved({
        provider: "fake",
        ok: true,
        checked_at: "2026-07-30T00:00:00.000Z",
      }),
    markScopePendingSync: () =>
      resolved({
        scope_id: scopeId,
        transitioned: 0,
        skipped: 0,
        already_pending: 0,
        task_ids: [],
      }),
    markTaskFailed: () =>
      resolved({
        marked: true,
        task_id: taskId,
        previous_state: "in_progress" as const,
        new_state: "failed" as const,
      }),
    scopeHeartbeatTick: () => {
      calls.push("heartbeat");
      return resolved({ scope_id: scopeId, status: "scope_terminal" as const });
    },
    startArchitectRun: () =>
      resolved({ started: false, scope_id: scopeId, reason: "not_used" }),
    startDecompositionReviewRun: () =>
      resolved({ started: false, scope_id: scopeId, reason: "not_used" }),
    autoApproveDecomposition: () =>
      resolved({ approved: false as const, reason: "not_used" }),
    autoApproveTaskMerge: () =>
      resolved({ recorded: false as const, reason: "not_used" }),
    autoCloseScope: () =>
      resolved({ applied: false as const, reason: "not_used" }),
  };
}

async function runSupervisorTestScenario(
  activities: SupervisorActivities & LongRunningSupervisorActivities,
  signaler?: (handle: unknown) => Promise<void>,
): Promise<void> {
  const address = process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233";
  const namespace = process.env["TEMPORAL_NAMESPACE"] ?? "default";
  const connection = await Connection.connect({ address });
  const nativeConnection = await NativeConnection.connect({ address });
  const client = new Client({ connection, namespace });
  const taskQueue = `colony-workflow-extra-test-${randomUUID()}`;
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
    await worker.runUntil(async () => {
      const handle = await client.workflow.start(scopeSupervisorWorkflow, {
        taskQueue,
        workflowId: `workflow-${randomUUID()}`,
        args: ["col-extra"],
      });
      await signaler?.(handle);
      await handle.result();
    });
  } finally {
    await nativeConnection.close();
    await connection.close();
  }
}

describe.runIf(temporalTestEnabled)(
  "@colony/workflows supervisor failure ownership",
  () => {
    it("blocks a task when the developer envelope fails", async () => {
      const calls: string[] = [];
      const baseActivities = makeSupervisorTestActivities(
        "col-extra",
        "col-extra.1",
        calls,
      );
      const activities: SupervisorActivities & LongRunningSupervisorActivities =
        {
          ...baseActivities,
          startDeveloperRun: () =>
            resolved({
              started: true,
              task_id: "col-extra.1",
              run_id: "developer-failed",
              envelope_status: "failed" as const,
              final_state: "in_progress" as const,
              reason: "developer_envelope_invalid",
            }),
        };
      await runSupervisorTestScenario(activities);
      expect(calls).toContain("override:task:block");
    }, 120_000);

    it("blocks a task when the refinement loop cap is exhausted", async () => {
      const calls: string[] = [];
      const baseActivities = makeSupervisorTestActivities(
        "col-extra",
        "col-extra.1",
        calls,
      );
      const activities: SupervisorActivities & LongRunningSupervisorActivities =
        {
          ...baseActivities,
          startPlanReviewRun: () =>
            resolved({
              started: true,
              task_id: "col-extra.1",
              envelope_status: "succeeded" as const,
              review_result: "changes_requested" as const,
              final_state: "plan_review" as const,
            }),
        };
      await runSupervisorTestScenario(activities);
      expect(calls).toContain("override:task:block");
    }, 120_000);

    it("re-reviews once after an invalidated approval when the head pipeline is green", async () => {
      const calls: string[] = [];
      let reviewerRuns = 0;
      let gateChecks = 0;
      const baseActivities = makeSupervisorTestActivities(
        "col-extra",
        "col-extra.1",
        calls,
      );
      const activities: SupervisorActivities & LongRunningSupervisorActivities =
        {
          ...baseActivities,
          readScopeState: () =>
            resolved({
              scope: { id: "col-extra", state: "active", state_version: 1 },
              hitl_mode: "gated",
              tasks: [
                {
                  id: "col-extra.1",
                  state: "review_requested",
                  state_version: 2,
                  claim_version: 1,
                },
              ],
            }),
          claimReadyTask: () => resolved({ claimed: false }),
          scopeHeartbeatTick: () =>
            resolved({
              scope_id: "col-extra",
              status: "scope_terminal" as const,
            }),
          recordPipelineStatus: () =>
            resolved({ recorded: true, invalidated_approvals: 1 }),
          checkMrGate: () => {
            gateChecks += 1;
            return resolved(
              gateChecks === 1
                ? {
                    checked: true as const,
                    task_id: "col-extra.1",
                    final_state: "review_requested" as const,
                    gate_open: false,
                    reasons: ["missing approvals from: reviewer"],
                    missing: ["reviewer"],
                    needs_re_review: true,
                    review_attempts: 0,
                    head_commit_sha: "head-1",
                    pipeline_status: "success",
                    pipeline_commit_sha: "head-1",
                  }
                : {
                    checked: true as const,
                    task_id: "col-extra.1",
                    final_state: "merge_ready" as const,
                    gate_open: true,
                    reasons: [],
                    missing: [],
                  },
            );
          },
          startReviewerRun: (input) => {
            reviewerRuns += 1;
            expect(input.head_commit_sha).toBe("head-1");
            return resolved({
              started: true,
              task_id: "col-extra.1",
              run_id: `review-${reviewerRuns}`,
              review_id: `review-${reviewerRuns}`,
              envelope_status: "succeeded" as const,
              review_result: "approved" as const,
              final_state: "review_requested" as const,
            });
          },
        };
      await runSupervisorTestScenario(activities, async (unknownHandle) => {
        const handle = unknownHandle as {
          signal: (
            signal: typeof pipelineUpdateSignal,
            payload: unknown,
          ) => Promise<void>;
        };
        await handle.signal(pipelineUpdateSignal, {
          provider: "fake",
          pipeline_id: "pipeline-1",
          status: "success",
          commit_sha: "head-1",
          task_id: "col-extra.1",
        });
      });
      expect(reviewerRuns).toBe(1);
      expect(gateChecks).toBe(2);
    }, 120_000);

    it("fires heartbeat while signals remain continuously queued", async () => {
      const calls: string[] = [];
      const activities = makeSupervisorTestActivities(
        "col-extra",
        "col-extra.1",
        calls,
      );
      await runSupervisorTestScenario(activities, async (unknownHandle) => {
        const handle = unknownHandle as {
          signal: (
            signal: typeof operatorOverrideSignal,
            payload: unknown,
          ) => Promise<void>;
        };
        for (let index = 0; index < 120; index += 1) {
          await handle.signal(operatorOverrideSignal, {
            actor: "test",
            action: "block",
            reason: `load-${index}`,
            task_id: "col-extra.1",
          });
        }
      });
      expect(calls).toContain("heartbeat");
    }, 120_000);
    it("merges the spec MR immediately after a successful DAG commit", async () => {
      const calls: string[] = [];
      const baseActivities = makeSupervisorTestActivities(
        "col-extra",
        "col-extra.1",
        calls,
      );
      const activities: SupervisorActivities & LongRunningSupervisorActivities =
        {
          ...baseActivities,
          applyDecompositionCommand: () =>
            resolved({
              applied: true,
              proposal_id: "proposal-1",
              action: "human_approved",
            }),
          commitDecompositionProposal: () => {
            calls.push("commitDecompositionProposal");
            return resolved({
              committed: true,
              scope_id: "col-extra",
              proposal_id: "proposal-1",
              task_count: 1,
              dependency_count: 0,
            });
          },
          syncCommittedTasksToProvider: () => {
            calls.push("syncCommittedTasksToProvider");
            return resolved({
              projected: 0,
              skipped: 0,
              failed: 0,
              failures: [],
            });
          },
          mergeSpecMergeRequest: () => {
            calls.push("mergeSpecMergeRequest");
            return resolved({ merged: true, scope_id: "col-extra" });
          },
        };
      await runSupervisorTestScenario(activities, async (unknownHandle) => {
        const handle = unknownHandle as {
          signal: (
            signal: typeof providerEventSignal,
            payload: unknown,
          ) => Promise<void>;
        };
        await handle.signal(providerEventSignal, {
          provider: "fake",
          event_type: "note",
          event_id: "event-1",
          object_kind: "merge_request",
          object_id: "mr-1",
          attributes: {
            command_target: "scope_decomposition",
            command_kind: "approve",
            commit_sha: "spec-head-1",
            envelope_hash: "sha256:spec-envelope",
          },
        });
      });
      expect(calls.indexOf("commitDecompositionProposal")).toBeGreaterThan(-1);
      expect(calls.indexOf("mergeSpecMergeRequest")).toBeGreaterThan(
        calls.indexOf("commitDecompositionProposal"),
      );
    }, 120_000);
  },
);

async function signalOperatorBlock(
  handle: unknown,
  taskId: string,
): Promise<void> {
  if (
    !handle ||
    typeof handle !== "object" ||
    !("signal" in handle) ||
    typeof handle.signal !== "function"
  ) {
    throw new Error("workflow handle cannot signal");
  }
  await Reflect.apply(handle.signal, handle, [
    operatorOverrideSignal,
    {
      actor: "human:test",
      action: "block",
      reason: "end test",
      task_id: taskId,
    },
  ]);
}
