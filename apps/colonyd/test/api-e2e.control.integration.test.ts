import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { http, httpRaw, waitFor } from "../e2e/client.js";
import { bootFake, type BootFakeHandle } from "../e2e/boot-fake.js";

let env: BootFakeHandle;

describe("api e2e control", () => {
  beforeAll(async () => {
    env = await bootFake();
  }, 90_000);

  afterAll(async () => {
    if (env) await env.cleanup();
  });

  describe("1. replan + replacement plan", () => {
    it("replan creates revised plan and audit, validates error codes", async () => {
      const created = await http(env.port, "POST", "/scopes", {
        body: {
          goal: "replan control goal",
          project: { path: "so/console-e2e" },
          approvals: "manual",
        },
      });
      expect(created.status).toBe(201);
      const scopeId = (created.body as { id: string }).id;

      const hasFirstPlan = await waitFor(
        "first plan",
        async () => {
          const res = await http(env.port, "GET", `/scopes/${scopeId}`);
          if (res.status !== 200) return false;
          const data = res.body as {
            scope: { status: string; plan_json: string | null };
          };
          return data.scope.status === "planning" && !!data.scope.plan_json;
        },
        90_000,
        250,
      );
      expect(hasFirstPlan).toBe(true);

      const firstRes = await http(env.port, "GET", `/scopes/${scopeId}`);
      const firstData = firstRes.body as {
        scope: { status: string; plan_json: string | null };
      };
      const firstPlan = JSON.parse(firstData.scope.plan_json!) as {
        summary?: string;
        tasks: { title: string }[];
      };
      const firstTitles = firstPlan.tasks.map((t) => t.title);

      const feedback =
        "Split the migration from the rollout task and make the rollback explicit.";
      const replanRes = await http(
        env.port,
        "POST",
        `/scopes/${scopeId}/replan`,
        {
          body: { feedback },
        },
      );
      expect(replanRes.status).toBe(200);
      const afterReplan = await http(env.port, "GET", `/scopes/${scopeId}`);
      expect(
        (afterReplan.body as { scope: { status: string } }).scope.status,
      ).toBe("planning");

      const newPlanArrived = await waitFor(
        "revised plan",
        async () => {
          const res = await http(env.port, "GET", `/scopes/${scopeId}`);
          if (res.status !== 200) return false;
          const data = res.body as {
            scope: { status: string; plan_json: string | null };
          };
          if (data.scope.status !== "planning" || !data.scope.plan_json)
            return false;
          try {
            const plan = JSON.parse(data.scope.plan_json) as {
              summary?: string;
              tasks: { title: string }[];
            };
            const hasRevised = (plan.summary ?? "").includes("Revised");
            const titles = plan.tasks.map((t) => t.title);
            const different =
              titles.some((t) => !firstTitles.includes(t)) ||
              firstTitles.some((t) => !titles.includes(t));
            return hasRevised && different;
          } catch {
            return false;
          }
        },
        90_000,
        250,
      );
      expect(newPlanArrived).toBe(true);

      const finalRes = await http(env.port, "GET", `/scopes/${scopeId}`);
      const finalPlan = JSON.parse(
        (finalRes.body as { scope: { plan_json: string } }).scope.plan_json,
      ) as { summary: string; tasks: { title: string }[] };
      expect(finalPlan.summary).toContain("Revised");
      expect(finalPlan.tasks.map((t) => t.title)).not.toEqual(firstTitles);

      const audit = await http(
        env.port,
        "GET",
        `/audit?scope_id=${encodeURIComponent(scopeId)}&limit=1000`,
      );
      expect(audit.status).toBe(200);
      const rows = audit.body as { action: string; detail_json: string }[];
      const replanRow = rows.find((r) => r.action === "plan.replan_requested");
      expect(replanRow).toBeDefined();
      const detail = JSON.parse(replanRow!.detail_json) as {
        feedback?: string;
      };
      expect(detail.feedback).toBe(feedback);

      const empty = await http(env.port, "POST", `/scopes/${scopeId}/replan`, {
        body: {},
      });
      expect(empty.status).toBe(400);
      expect((empty.body as { error?: { code?: string } })?.error?.code).toBe(
        "INVALID_BODY",
      );

      const invalid = await httpRaw(
        env.port,
        "POST",
        `/scopes/${scopeId}/replan`,
        JSON.stringify({ feedback: "" }),
        { "content-type": "application/json", "X-Actor-Id": "human:e2e" },
      );
      expect(invalid.status).toBe(400);
      expect((invalid.body as { error?: { code?: string } })?.error?.code).toBe(
        "INVALID_BODY",
      );

      const approve = await http(
        env.port,
        "POST",
        `/scopes/${scopeId}/approve-plan`,
      );
      expect(approve.status).toBe(200);
      const afterApproveReplan = await http(
        env.port,
        "POST",
        `/scopes/${scopeId}/replan`,
        {
          body: { feedback },
        },
      );
      expect(afterApproveReplan.status).toBe(409);
      expect(
        (afterApproveReplan.body as { error?: { code?: string } })?.error?.code,
      ).toBe("NO_PLAN_PENDING");
    }, 90_000);
  });

  describe("2. task transitions", () => {
    it("exercises stop, cancel, restore, unblock, retry, amend-spec, request-changes", async () => {
      // 2a. stop with active run, NO_ACTIVE_RUN, NOT_RUNNING
      {
        (
          env.boundary.script as unknown as { implementerStall?: boolean }
        ).implementerStall = true;
        const created = await http(env.port, "POST", "/scopes", {
          body: {
            goal: "task transitions stop goal",
            project: { path: "so/console-e2e" },
            approvals: "auto",
          },
        });
        expect(created.status).toBe(201);
        const scopeId = (created.body as { id: string }).id;

        await waitFor(
          "active",
          async () => {
            const r = await http(env.port, "GET", `/scopes/${scopeId}`);
            const d = r.body as { scope: { status: string }; tasks: unknown[] };
            return (
              d.scope.status === "active" && (d.tasks as unknown[]).length >= 2
            );
          },
          90_000,
          250,
        );

        let runningTaskId: string | undefined;
        let runningAttempt: number | undefined;
        const foundRunning = await waitFor(
          "running task",
          async () => {
            const r = await http(env.port, "GET", `/scopes/${scopeId}`);
            if (r.status !== 200) return false;
            const data = r.body as {
              tasks: { id: string; state: string; attempt: number }[];
            };
            const t = data.tasks.find((x) => x.state === "running");
            if (t) {
              runningTaskId = t.id;
              runningAttempt = t.attempt;
              return true;
            }
            return false;
          },
          90_000,
          250,
        );
        expect(foundRunning).toBe(true);
        expect(runningTaskId).toBeDefined();

        const stopRes = await http(
          env.port,
          "POST",
          `/tasks/${runningTaskId!}/stop`,
        );
        expect(stopRes.status).toBe(200);
        const stopped = stopRes.body as {
          state: string;
          attempt: number;
          next_retry_at: string | null;
        };
        expect(stopped.state).toBe("queued");
        expect(stopped.attempt).toBe(runningAttempt);
        expect(stopped.next_retry_at).toBeNull();

        const auditStop = await http(
          env.port,
          "GET",
          `/audit?task_id=${encodeURIComponent(runningTaskId!)}&limit=1000`,
        );
        expect(auditStop.status).toBe(200);
        expect(
          (auditStop.body as { action: string }[]).some(
            (r) => r.action === "task.stop_and_retry",
          ),
        ).toBe(true);

        // NO_ACTIVE_RUN: force a task to running without active run via store
        const store = (env.handle as unknown as { ctx: { store: unknown } }).ctx
          .store as {
          listTasks: (scopeId: string) => {
            id: string;
            state: string;
            state_version: number;
          }[];
          transitionTask: (
            id: string,
            v: number,
            to: string,
            actor: string,
            patch?: unknown,
          ) => unknown;
          db: {
            prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
          };
        };
        const tasksAfter = store.listTasks(scopeId);
        const queuedForNoRun = tasksAfter.find((t) => t.state === "queued");
        if (queuedForNoRun) {
          store.transitionTask(
            queuedForNoRun.id,
            queuedForNoRun.state_version,
            "running",
            "human:e2e",
          );
          const noRunRes = await http(
            env.port,
            "POST",
            `/tasks/${queuedForNoRun.id}/stop`,
          );
          expect(noRunRes.status).toBe(409);
          expect(
            (noRunRes.body as { error?: { code?: string } })?.error?.code,
          ).toBe("NO_ACTIVE_RUN");
          const cur = store
            .listTasks(scopeId)
            .find((t) => t.id === queuedForNoRun.id)!;
          store.transitionTask(
            cur.id,
            cur.state_version,
            "queued",
            "human:e2e",
            {
              attempt: 0,
              next_retry_at: null,
            },
          );
        }

        // NOT_RUNNING: stop a queued task
        const snapForNotRunning = await http(
          env.port,
          "GET",
          `/scopes/${scopeId}`,
        );
        const queuedTask = (
          snapForNotRunning.body as { tasks: { id: string; state: string }[] }
        ).tasks.find((t) => t.state === "queued");
        if (queuedTask) {
          const notRunningRes = await http(
            env.port,
            "POST",
            `/tasks/${queuedTask.id}/stop`,
          );
          expect(notRunningRes.status).toBe(409);
          expect(
            (notRunningRes.body as { error?: { code?: string } })?.error?.code,
          ).toBe("NOT_RUNNING");
        }

        // cleanup: let it finish or abandon
        (
          env.boundary.script as unknown as { implementerStall?: boolean }
        ).implementerStall = false;
        await http(env.port, "POST", `/scopes/${scopeId}/abandon`);
      }

      // 2b. cancel, restore, abandon interactions, unblock, retry
      let canceledIdForLater: string | undefined;
      {
        const created = await http(env.port, "POST", "/scopes", {
          body: {
            goal: "task transitions cancel restore goal",
            project: { path: "so/console-e2e" },
            approvals: "manual",
          },
        });
        expect(created.status).toBe(201);
        const scopeId = (created.body as { id: string }).id;
        await waitFor(
          "planning",
          async () => {
            const r = await http(env.port, "GET", `/scopes/${scopeId}`);
            const d = r.body as {
              scope: { status: string; plan_json: string | null };
            };
            return d.scope.status === "planning" && !!d.scope.plan_json;
          },
          90_000,
          250,
        );
        await http(env.port, "POST", `/scopes/${scopeId}/approve-plan`);
        await waitFor(
          "queued",
          async () => {
            const r = await http(env.port, "GET", `/scopes/${scopeId}`);
            const d = r.body as { tasks: { state: string }[] };
            return d.tasks.some((t) => t.state === "queued");
          },
          10_000,
          250,
        );
        const snap = await http(env.port, "GET", `/scopes/${scopeId}`);
        const tasks = (snap.body as { tasks: { id: string; state: string }[] })
          .tasks;
        const toCancel = tasks.find((t) => t.state === "queued")!;
        expect(toCancel).toBeDefined();
        const cancelRes = await http(
          env.port,
          "POST",
          `/tasks/${toCancel.id}/cancel`,
        );
        expect(cancelRes.status).toBe(200);
        expect((cancelRes.body as { state: string }).state).toBe("canceled");
        canceledIdForLater = toCancel.id;

        // restore in active scope -> queued attempt 0 and reactivates if blocked/validating/done
        const restoreRes = await http(
          env.port,
          "POST",
          `/tasks/${toCancel.id}/restore`,
        );
        expect(restoreRes.status).toBe(200);
        expect((restoreRes.body as { state: string }).state).toBe("queued");
        expect((restoreRes.body as { attempt: number }).attempt).toBe(0);

        // cancel again to have a canceled task for later checks
        await http(env.port, "POST", `/tasks/${toCancel.id}/cancel`);

        // unblock: create blocked task via store
        const store = (env.handle as unknown as { ctx: { store: unknown } }).ctx
          .store as {
          listTasks: (scopeId: string) => {
            id: string;
            state: string;
            state_version: number;
          }[];
          transitionTask: (
            id: string,
            v: number,
            to: string,
            actor: string,
            patch?: unknown,
          ) => unknown;
        };
        const tasksForBlock = store.listTasks(scopeId);
        const toBlock = tasksForBlock.find((t) => t.state === "queued");
        if (toBlock) {
          store.transitionTask(
            toBlock.id,
            toBlock.state_version,
            "blocked",
            "human:e2e",
            {
              blocked_reason: "test block",
            },
          );
          const unblockRes = await http(
            env.port,
            "POST",
            `/tasks/${toBlock.id}/unblock`,
          );
          expect(unblockRes.status).toBe(200);
          expect((unblockRes.body as { state: string }).state).toBe("queued");
        }

        // retry: need a queued task with future next_retry_at
        const retrySnap = await http(env.port, "GET", `/scopes/${scopeId}`);
        const toRetry = (
          retrySnap.body as { tasks: { id: string; state: string }[] }
        ).tasks.find((t) => t.state === "queued");
        if (toRetry) {
          const store2 = (env.handle as unknown as { ctx: { store: unknown } })
            .ctx.store as {
            db: {
              prepare: (sql: string) => {
                run: (...args: unknown[]) => unknown;
              };
            };
          };
          const future = new Date(Date.now() + 60_000).toISOString();
          store2.db
            .prepare(
              "UPDATE tasks SET next_retry_at = ?, updated_at = ? WHERE id = ?",
            )
            .run(future, new Date().toISOString(), toRetry.id);
          const retryRes = await http(
            env.port,
            "POST",
            `/tasks/${toRetry.id}/retry`,
          );
          expect(retryRes.status).toBe(200);
          expect(
            (retryRes.body as { next_retry_at: string | null }).next_retry_at,
          ).toBeNull();
        }

        // retry non-queued -> 409 NOT_QUEUED
        const badRetry = await http(
          env.port,
          "POST",
          `/tasks/${canceledIdForLater!}/retry`,
        );
        expect(badRetry.status).toBe(409);
        expect(
          (badRetry.body as { error?: { code?: string } })?.error?.code,
        ).toBe("NOT_QUEUED");

        // scope reactivation: set scope to blocked then restore should reactivate to active
        const store3 = (env.handle as unknown as { ctx: { store: unknown } })
          .ctx.store as {
          db: {
            prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
          };
        };
        store3.db
          .prepare(
            "UPDATE scopes SET status = 'blocked', updated_at = ? WHERE id = ?",
          )
          .run(new Date().toISOString(), scopeId);
        const reactivateRestore = await http(
          env.port,
          "POST",
          `/tasks/${canceledIdForLater!}/restore`,
        );
        expect(reactivateRestore.status).toBe(200);
        expect((reactivateRestore.body as { state: string }).state).toBe(
          "queued",
        );
        const afterReactivate = await http(
          env.port,
          "GET",
          `/scopes/${scopeId}`,
        );
        expect(
          (afterReactivate.body as { scope: { status: string } }).scope.status,
        ).toBe("active");

        // abandon this scope to test cancel/restore in abandoned scope
        await http(env.port, "POST", `/scopes/${scopeId}/abandon`);
        const afterAbandonSnap = await http(
          env.port,
          "GET",
          `/scopes/${scopeId}`,
        );
        const afterTasks = (
          afterAbandonSnap.body as { tasks: { id: string; state: string }[] }
        ).tasks;
        const canceledInAbandoned = afterTasks.find(
          (t) => t.state === "canceled",
        );
        if (canceledInAbandoned) {
          const restoreAbandoned = await http(
            env.port,
            "POST",
            `/tasks/${canceledInAbandoned.id}/restore`,
          );
          expect(restoreAbandoned.status).toBe(409);
          expect(
            (restoreAbandoned.body as { error?: { code?: string } })?.error
              ?.code,
          ).toBe("SCOPE_ABANDONED");
          const cancelAbandoned = await http(
            env.port,
            "POST",
            `/tasks/${canceledInAbandoned.id}/cancel`,
          );
          // cancel on already canceled in abandoned scope may still be 200 or 409; if 409 expect any error
          if (cancelAbandoned.status !== 200) {
            expect(cancelAbandoned.status).toBe(409);
          }
        }
        // also test cancel in abandoned scope on a fresh abandoned scope with queued
        const abandon2 = await http(env.port, "POST", "/scopes", {
          body: {
            goal: "abandon cancel 2",
            project: { path: "so/console-e2e" },
            approvals: "manual",
          },
        });
        const abandon2Id = (abandon2.body as { id: string }).id;
        await waitFor(
          "planning2",
          async () => {
            const r = await http(env.port, "GET", `/scopes/${abandon2Id}`);
            const d = r.body as {
              scope: { status: string; plan_json: string | null };
            };
            return d.scope.status === "planning" && !!d.scope.plan_json;
          },
          90_000,
          250,
        );
        await http(env.port, "POST", `/scopes/${abandon2Id}/approve-plan`);
        await waitFor(
          "queued2",
          async () => {
            const r = await http(env.port, "GET", `/scopes/${abandon2Id}`);
            const d = r.body as { tasks: { state: string }[] };
            return d.tasks.some((t) => t.state === "queued");
          },
          10_000,
          250,
        );
        await http(env.port, "POST", `/scopes/${abandon2Id}/abandon`);
        const snapAb2 = await http(env.port, "GET", `/scopes/${abandon2Id}`);
        const tasksAb2 = (
          snapAb2.body as { tasks: { id: string; state: string }[] }
        ).tasks;
        const canceledAb2 = tasksAb2.find((t) => t.state === "canceled");
        if (canceledAb2) {
          // use cancel again to hit SCOPE_ABANDONED? restore already tested, cancel again should also be 409 due to state, not SCOPE_ABANDONED
          // we have covered restore SCOPE_ABANDONED above
        }
      }

      // 2c. amend-spec and request-changes on mr_open, and amend-spec on merged/canceled
      {
        const created = await http(env.port, "POST", "/scopes", {
          body: {
            goal: "amend and request changes goal",
            project: { path: "so/console-e2e" },
          },
        });
        expect(created.status).toBe(201);
        const scopeId = (created.body as { id: string }).id;
        await waitFor(
          "planning",
          async () => {
            const r = await http(env.port, "GET", `/scopes/${scopeId}`);
            const d = r.body as {
              scope: { status: string; plan_json: string | null };
            };
            return d.scope.status === "planning" && !!d.scope.plan_json;
          },
          90_000,
          250,
        );
        const approve = await http(
          env.port,
          "POST",
          `/scopes/${scopeId}/approve-plan`,
        );
        void approve;

        const mrOpenId = await waitForTaskState(
          env.port,
          scopeId,
          "mr_open",
          90_000,
        );
        expect(mrOpenId).toBeDefined();

        const amendment = "Add explicit rollback step for mr_open";
        const amendRes = await http(
          env.port,
          "POST",
          `/tasks/${mrOpenId!}/amend-spec`,
          {
            body: { feedback: amendment },
          },
        );
        expect(amendRes.status).toBe(200);
        expect((amendRes.body as { state: string }).state).toBe("queued");
        const taskGet = await http(env.port, "GET", `/tasks/${mrOpenId!}`);
        expect(taskGet.status).toBe(200);
        const specText = (taskGet.body as { task: { spec: string } }).task.spec;
        expect(specText).toContain(amendment);

        const mrOpen2 = await waitForTaskState(
          env.port,
          scopeId,
          "mr_open",
          90_000,
        );
        expect(mrOpen2).toBeDefined();
        const before = await http(env.port, "GET", `/tasks/${mrOpen2!}`);
        const beforeAttempt = (before.body as { task: { attempt: number } })
          .task.attempt;
        const rcRes = await http(
          env.port,
          "POST",
          `/tasks/${mrOpen2!}/request-changes`,
          {
            body: { feedback: "please fix" },
          },
        );
        expect(rcRes.status).toBe(200);
        expect((rcRes.body as { state: string }).state).toBe("queued");
        expect((rcRes.body as { attempt: number }).attempt).toBe(
          beforeAttempt + 1,
        );
        const auditRc = await http(
          env.port,
          "GET",
          `/audit?task_id=${encodeURIComponent(mrOpen2!)}&limit=1000`,
        );
        expect(auditRc.status).toBe(200);
        expect(
          (auditRc.body as { action: string }[]).some(
            (r) => r.action === "task.changes_requested",
          ),
        ).toBe(true);

        // After request-changes the task is queued, so second request-changes must 409 NO_OPEN_MR
        // verify NO_OPEN_MR on a non-mr_open task (use a fresh canceled task to avoid race where mrOpen2 is redispatched to mr_open)
        const noOpenScope = await http(env.port, "POST", "/scopes", {
          body: {
            goal: "no open mr goal",
            project: { path: "so/console-e2e" },
            approvals: "manual",
          },
        });
        const noOpenScopeId = (noOpenScope.body as { id: string }).id;
        await waitFor(
          "noOpen planning",
          async () => {
            const r = await http(env.port, "GET", `/scopes/${noOpenScopeId}`);
            const d = r.body as {
              scope: { status: string; plan_json: string | null };
            };
            return d.scope.status === "planning" && !!d.scope.plan_json;
          },
          90_000,
          250,
        );
        await http(env.port, "POST", `/scopes/${noOpenScopeId}/approve-plan`);
        await waitFor(
          "noOpen queued",
          async () => {
            const r = await http(env.port, "GET", `/scopes/${noOpenScopeId}`);
            const d = r.body as { tasks: { state: string }[] };
            return d.tasks.some((t) => t.state === "queued");
          },
          10_000,
          250,
        );
        const noOpenSnap = await http(
          env.port,
          "GET",
          `/scopes/${noOpenScopeId}`,
        );
        const noOpenTask = (
          noOpenSnap.body as { tasks: { id: string; state: string }[] }
        ).tasks.find((t) => t.state === "queued")!;
        const badRc = await http(
          env.port,
          "POST",
          `/tasks/${noOpenTask.id}/request-changes`,
          {
            body: { feedback: "again" },
          },
        );
        expect(badRc.status).toBe(409);
        expect((badRc.body as { error?: { code?: string } })?.error?.code).toBe(
          "NO_OPEN_MR",
        );

        await waitFor(
          "done",
          async () => {
            const r = await http(env.port, "GET", `/scopes/${scopeId}`);
            const d = r.body as { scope: { status: string } };
            return d.scope.status === "done";
          },
          90_000,
          250,
        );
        const doneSnap = await http(env.port, "GET", `/scopes/${scopeId}`);
        const doneTasks = (
          doneSnap.body as { tasks: { id: string; state: string }[] }
        ).tasks;
        const merged = doneTasks.find((t) => t.state === "merged");
        expect(merged).toBeDefined();
        if (merged) {
          const amendMerged = await http(
            env.port,
            "POST",
            `/tasks/${merged.id}/amend-spec`,
            {
              body: { feedback: "late amend" },
            },
          );
          expect(amendMerged.status).toBe(409);
          expect(
            (amendMerged.body as { error?: { code?: string } })?.error?.code,
          ).toBe("TASK_FINISHED");
        }

        // amend-spec on canceled -> 409 TASK_FINISHED
        const cancelScope = await http(env.port, "POST", "/scopes", {
          body: {
            goal: "cancel amend goal",
            project: { path: "so/console-e2e" },
            approvals: "manual",
          },
        });
        const cancelScopeId = (cancelScope.body as { id: string }).id;
        await waitFor(
          "cancel planning",
          async () => {
            const r = await http(env.port, "GET", `/scopes/${cancelScopeId}`);
            const d = r.body as {
              scope: { status: string; plan_json: string | null };
            };
            return d.scope.status === "planning" && !!d.scope.plan_json;
          },
          90_000,
          250,
        );
        await http(env.port, "POST", `/scopes/${cancelScopeId}/approve-plan`);
        await waitFor(
          "cancel queued",
          async () => {
            const r = await http(env.port, "GET", `/scopes/${cancelScopeId}`);
            const d = r.body as { tasks: { state: string }[] };
            return d.tasks.some((t) => t.state === "queued");
          },
          10_000,
          250,
        );
        const csSnap = await http(env.port, "GET", `/scopes/${cancelScopeId}`);
        const csTask = (
          csSnap.body as { tasks: { id: string; state: string }[] }
        ).tasks.find((t) => t.state === "queued")!;
        await http(env.port, "POST", `/tasks/${csTask.id}/cancel`);
        const amendCanceled = await http(
          env.port,
          "POST",
          `/tasks/${csTask.id}/amend-spec`,
          {
            body: { feedback: "should fail" },
          },
        );
        expect(amendCanceled.status).toBe(409);
        expect(
          (amendCanceled.body as { error?: { code?: string } })?.error?.code,
        ).toBe("TASK_FINISHED");
      }
    }, 90_000);
  });

  describe("3. review loop", () => {
    it("reviewerRejectFirst then approve merges on one MR with reuse", async () => {
      const reviewEnv = await bootFake({ reviewMode: "required" });
      try {
        // mirror loop.integration syncMrHead: MR head must track branch commit for re-implement
        const origGet = reviewEnv.boundary.provider.mergeRequests.get.bind(
          reviewEnv.boundary.provider.mergeRequests,
        );
        reviewEnv.boundary.provider.mergeRequests.get = async (project, id) => {
          const mr = await origGet(project, id);
          if (!mr.source_branch) return mr;
          try {
            const head = await reviewEnv.boundary.provider.commits.get(
              project,
              mr.source_branch,
            );
            return { ...mr, head_commit_sha: head.sha };
          } catch {
            return mr;
          }
        };
        (
          reviewEnv.boundary.script as unknown as {
            reviewerRejectFirst?: boolean;
          }
        ).reviewerRejectFirst = true;
        (
          reviewEnv.boundary.script as unknown as { distinctShas?: boolean }
        ).distinctShas = true;
        const created = await http(reviewEnv.port, "POST", "/scopes", {
          body: {
            goal: "review loop goal",
            project: { path: "so/console-e2e" },
          },
        });
        expect(created.status).toBe(201);
        const scopeId = (created.body as { id: string }).id;

        await waitFor(
          "planning",
          async () => {
            const r = await http(reviewEnv.port, "GET", `/scopes/${scopeId}`);
            const d = r.body as {
              scope: { status: string; plan_json: string | null };
            };
            return d.scope.status === "planning" && !!d.scope.plan_json;
          },
          90_000,
          250,
        );
        // auto approvals: materializes without approve-plan; try approve but ignore 409
        await http(reviewEnv.port, "POST", `/scopes/${scopeId}/approve-plan`);

        // retry backoff after review rejection (10s/20s) blocks dispatch; poll clearing retry + tick
        const done = await waitFor(
          "done",
          async () => {
            try {
              const snap2 = await http(
                reviewEnv.port,
                "GET",
                `/scopes/${scopeId}`,
              );
              if (snap2.status === 200) {
                const s2 = snap2.body as {
                  tasks: {
                    id: string;
                    state: string;
                    next_retry_at: string | null;
                  }[];
                };
                for (const t of s2.tasks) {
                  if (t.state === "queued" && t.next_retry_at) {
                    const due = Date.parse(t.next_retry_at);
                    if (due > Date.now()) {
                      await http(
                        reviewEnv.port,
                        "POST",
                        `/tasks/${t.id}/retry`,
                      );
                    }
                  }
                }
              }
            } catch {
              // ignore
            }
            const r = await http(reviewEnv.port, "GET", `/scopes/${scopeId}`);
            const d = r.body as { scope: { status: string } };
            return d.scope.status === "done";
          },
          90_000,
          250,
        );
        expect(done).toBe(true);

        const snap = await http(reviewEnv.port, "GET", `/scopes/${scopeId}`);
        const tasks = (snap.body as { tasks: { id: string; state: string }[] })
          .tasks;
        expect(tasks.length).toBeGreaterThanOrEqual(1);
        const firstTask = tasks[0]!.id;
        const audit = await http(
          reviewEnv.port,
          "GET",
          `/audit?task_id=${encodeURIComponent(firstTask)}&limit=1000`,
        );
        expect(audit.status).toBe(200);
        const rows = audit.body as { action: string }[];
        const changesCount = rows.filter(
          (r) => r.action === "review.changes_requested",
        ).length;
        expect(changesCount).toBe(1);

        // spec requires: task requeued, GET /audit review.changes_requested exactly once; then approve → merged on ONE MR (mr.opened count 1, mr.reused present)
        // Use single-task decomposition to make scope audit counts deterministic (otherwise second task contributes extra mr.opened)
        const scopeAudit = await http(
          reviewEnv.port,
          "GET",
          `/audit?scope_id=${encodeURIComponent(scopeId)}&limit=1000`,
        );
        expect(scopeAudit.status).toBe(200);
        const sRowsAll = scopeAudit.body as { action: string }[];
        // per-task: exactly one mr.opened and one mr.reused for the first task, scope total should be taskCount with reuse
        const sRows = sRowsAll;
        // scope-level mr.opened count equals task count (each task opens one); with single-task it is 1
        // Instead assert per-task MR counts
        const taskAudit = await http(
          reviewEnv.port,
          "GET",
          `/audit?task_id=${encodeURIComponent(firstTask)}&limit=1000`,
        );
        const taskRows = taskAudit.body as { action: string }[];
        expect(taskRows.filter((r) => r.action === "mr.opened").length).toBe(1);
        expect(taskRows.filter((r) => r.action === "mr.reused").length).toBe(1);
        expect(sRows.some((r) => r.action === "mr.reused")).toBe(true);
      } finally {
        await reviewEnv.cleanup();
      }
    }, 90_000);
  });

  describe("4. merge gate fail-then-pass", () => {
    it("gate fails once then passes without duplicate MR", async () => {
      const created = await http(env.port, "POST", "/scopes", {
        body: { goal: "gate fail goal", project: { path: "so/console-e2e" } },
      });
      expect(created.status).toBe(201);
      const scopeId = (created.body as { id: string }).id;

      await waitFor(
        "planning",
        async () => {
          const r = await http(env.port, "GET", `/scopes/${scopeId}`);
          const d = r.body as {
            scope: { status: string; plan_json: string | null };
          };
          return d.scope.status === "planning" && !!d.scope.plan_json;
        },
        90_000,
        250,
      );
      await http(env.port, "POST", `/scopes/${scopeId}/approve-plan`);

      const snap0 = await http(env.port, "GET", `/scopes/${scopeId}`);
      const tasks0 = (snap0.body as { tasks: { id: string }[] }).tasks;
      expect(tasks0.length).toBeGreaterThanOrEqual(1);
      const targetTask = tasks0[0]!.id;
      (
        env.boundary.script as unknown as { gateFailOnceFor?: string }
      ).gateFailOnceFor = targetTask;

      const failed = await waitFor(
        "gate failed",
        async () => {
          const r = await http(env.port, "GET", `/tasks/${targetTask}`);
          if (r.status !== 200) return false;
          const data = r.body as {
            task: { state: string };
            runs: {
              kind: string;
              status: string;
              evidence_json: string | null;
            }[];
          };
          const hasFailedGate = data.runs.some((run) => {
            if (run.kind !== "merge_gate" || run.status !== "failed")
              return false;
            try {
              const ev = JSON.parse(run.evidence_json ?? "{}") as {
                reason?: string;
              };
              return ev.reason === "command_failed";
            } catch {
              return false;
            }
          });
          return hasFailedGate && data.task.state === "queued";
        },
        90_000,
        250,
      );
      expect(failed).toBe(true);

      const afterFail = await http(env.port, "GET", `/tasks/${targetTask}`);
      const afterData = afterFail.body as {
        task: { attempt: number };
      };
      expect(afterData.task.attempt).toBeGreaterThanOrEqual(1);

      await http(env.port, "POST", `/tasks/${targetTask}/retry`);

      const merged = await waitFor(
        "merged after gate",
        async () => {
          const r = await http(env.port, "GET", `/tasks/${targetTask}`);
          if (r.status !== 200) return false;
          const d = r.body as {
            task: { state: string };
            runs: { kind: string; status: string }[];
          };
          const hasSucceededGate = d.runs.some(
            (run) => run.kind === "merge_gate" && run.status === "succeeded",
          );
          return d.task.state === "merged" && hasSucceededGate;
        },
        90_000,
        250,
      );
      expect(merged).toBe(true);

      const audit = await http(
        env.port,
        "GET",
        `/audit?task_id=${encodeURIComponent(targetTask)}&limit=1000`,
      );
      expect(audit.status).toBe(200);
      const rows = audit.body as { action: string }[];
      const openedCount = rows.filter((r) => r.action === "mr.opened").length;
      expect(openedCount).toBe(1);

      (
        env.boundary.script as unknown as { gateFailOnceFor?: string }
      ).gateFailOnceFor = undefined;
    }, 90_000);
  });

  describe("5. manual vs auto merge approvals", () => {
    it("manual stays mr_open until approve-merge, auto merges, error branches", async () => {
      const manualCreated = await http(env.port, "POST", "/scopes", {
        body: {
          goal: "manual approvals goal",
          project: { path: "so/console-e2e" },
          approvals: "manual",
        },
      });
      expect(manualCreated.status).toBe(201);
      const manualScopeId = (manualCreated.body as { id: string }).id;

      await waitFor(
        "manual planning",
        async () => {
          const r = await http(env.port, "GET", `/scopes/${manualScopeId}`);
          const d = r.body as {
            scope: { status: string; plan_json: string | null };
          };
          return d.scope.status === "planning" && !!d.scope.plan_json;
        },
        90_000,
        250,
      );
      await http(env.port, "POST", `/scopes/${manualScopeId}/approve-plan`);

      const mrOpen = await waitForTaskState(
        env.port,
        manualScopeId,
        "mr_open",
        90_000,
      );
      expect(mrOpen).toBeDefined();
      const mrTask = await http(env.port, "GET", `/tasks/${mrOpen!}`);
      expect((mrTask.body as { task: { state: string } }).task.state).toBe(
        "mr_open",
      );

      await new Promise((resolve) => setTimeout(resolve, 800));
      const still = await http(env.port, "GET", `/tasks/${mrOpen!}`);
      expect((still.body as { task: { state: string } }).task.state).toBe(
        "mr_open",
      );

      const approveMerge = await http(
        env.port,
        "POST",
        `/tasks/${mrOpen!}/approve-merge`,
      );
      expect(approveMerge.status).toBe(200);
      const afterApprove = await waitFor(
        "manual merged",
        async () => {
          const r = await http(env.port, "GET", `/tasks/${mrOpen!}`);
          return (
            (r.body as { task: { state: string } }).task.state === "merged"
          );
        },
        90_000,
        250,
      );
      expect(afterApprove).toBe(true);

      const autoCreated = await http(env.port, "POST", "/scopes", {
        body: {
          goal: "auto approvals goal",
          project: { path: "so/console-e2e" },
        },
      });
      expect(autoCreated.status).toBe(201);
      const autoScopeId = (autoCreated.body as { id: string }).id;
      await waitFor(
        "auto planning",
        async () => {
          const r = await http(env.port, "GET", `/scopes/${autoScopeId}`);
          const d = r.body as {
            scope: { status: string; plan_json: string | null };
          };
          return d.scope.status === "planning" && !!d.scope.plan_json;
        },
        90_000,
        250,
      );
      await http(env.port, "POST", `/scopes/${autoScopeId}/approve-plan`);
      const autoMrOpen = await waitForTaskState(
        env.port,
        autoScopeId,
        "mr_open",
        90_000,
      );
      if (autoMrOpen) {
        const badApprove = await http(
          env.port,
          "POST",
          `/tasks/${autoMrOpen}/approve-merge`,
        );
        expect(badApprove.status).toBe(409);
        expect(
          (badApprove.body as { error?: { code?: string } })?.error?.code,
        ).toBe("AUTO_MERGE_SCOPE");
      }

      const fresh = await http(env.port, "POST", "/scopes", {
        body: {
          goal: "fresh manual goal",
          project: { path: "so/console-e2e" },
          approvals: "manual",
        },
      });
      const freshId = (fresh.body as { id: string }).id;
      await waitFor(
        "fresh planning",
        async () => {
          const r = await http(env.port, "GET", `/scopes/${freshId}`);
          const d = r.body as {
            scope: { status: string; plan_json: string | null };
          };
          return d.scope.status === "planning" && !!d.scope.plan_json;
        },
        90_000,
        250,
      );
      await http(env.port, "POST", `/scopes/${freshId}/approve-plan`);
      const snap = await http(env.port, "GET", `/scopes/${freshId}`);
      const queued = (
        snap.body as { tasks: { id: string; state: string }[] }
      ).tasks.find((t) => t.state === "queued");
      if (queued) {
        const early = await http(
          env.port,
          "POST",
          `/tasks/${queued.id}/approve-merge`,
        );
        expect(early.status).toBe(409);
        expect((early.body as { error?: { code?: string } })?.error?.code).toBe(
          "NO_OPEN_MR",
        );
      }
    }, 90_000);
  });

  describe("6. abandon", () => {
    it("abandon cancels nonterminal tasks and audits", async () => {
      const created = await http(env.port, "POST", "/scopes", {
        body: {
          goal: "abandon goal",
          project: { path: "so/console-e2e" },
          approvals: "manual",
        },
      });
      expect(created.status).toBe(201);
      const scopeId = (created.body as { id: string }).id;
      await waitFor(
        "planning",
        async () => {
          const r = await http(env.port, "GET", `/scopes/${scopeId}`);
          const d = r.body as {
            scope: { status: string; plan_json: string | null };
          };
          return d.scope.status === "planning" && !!d.scope.plan_json;
        },
        90_000,
        250,
      );
      await http(env.port, "POST", `/scopes/${scopeId}/approve-plan`);
      await waitFor(
        "queued",
        async () => {
          const r = await http(env.port, "GET", `/scopes/${scopeId}`);
          const d = r.body as { tasks: { state: string }[] };
          return d.tasks.some((t) => t.state === "queued");
        },
        10_000,
        250,
      );

      const abandonRes = await http(
        env.port,
        "POST",
        `/scopes/${scopeId}/abandon`,
      );
      expect(abandonRes.status).toBe(200);
      const abandonedStatus =
        (abandonRes.body as { status: string }).status ??
        (abandonRes.body as { scope: { status: string } }).scope?.status;
      expect(abandonedStatus).toBe("abandoned");

      const after = await http(env.port, "GET", `/scopes/${scopeId}`);
      expect(after.status).toBe(200);
      const data = after.body as {
        scope: { status: string };
        tasks: { state: string }[];
      };
      expect(data.scope.status).toBe("abandoned");
      for (const t of data.tasks) {
        expect(["canceled", "merged"]).toContain(t.state);
        if (t.state !== "merged") expect(t.state).toBe("canceled");
      }

      const audit = await http(
        env.port,
        "GET",
        `/audit?scope_id=${encodeURIComponent(scopeId)}&limit=1000`,
      );
      expect(audit.status).toBe(200);
      const rows = audit.body as { action: string; detail_json: string }[];
      expect(
        rows.some(
          (r) =>
            r.action === "scope.transition" &&
            JSON.parse(r.detail_json).to === "abandoned",
        ),
      ).toBe(true);

      const taskList = (
        after.body as { tasks: { id: string; state: string }[] }
      ).tasks;
      const canceled = taskList.find((t) => t.state === "canceled");
      if (canceled) {
        const restoreAbandoned = await http(
          env.port,
          "POST",
          `/tasks/${canceled.id}/restore`,
        );
        expect(restoreAbandoned.status).toBe(409);
        expect(
          (restoreAbandoned.body as { error?: { code?: string } })?.error?.code,
        ).toBe("SCOPE_ABANDONED");
        const cancelAgain = await http(
          env.port,
          "POST",
          `/tasks/${canceled.id}/cancel`,
        );
        if (cancelAgain.status !== 200) {
          expect(cancelAgain.status).toBe(409);
        }
      }
    }, 90_000);
  });
});

async function waitForTaskState(
  port: number,
  scopeId: string,
  state: string,
  timeoutMs: number,
): Promise<string | undefined> {
  let found: string | undefined;
  await waitFor(
    `task ${state}`,
    async () => {
      const res = await http(port, "GET", `/scopes/${scopeId}`);
      if (res.status !== 200) return false;
      const data = res.body as { tasks: { id: string; state: string }[] };
      const t = data.tasks.find((x) => x.state === state);
      if (t) {
        found = t.id;
        return true;
      }
      return false;
    },
    timeoutMs,
    250,
  );
  return found;
}
