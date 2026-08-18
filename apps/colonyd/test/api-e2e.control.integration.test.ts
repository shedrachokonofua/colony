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

  it("1. replan + replacement plan", async () => {
    // reset
    env.boundary.script.implementerStall = false;
    env.boundary.script.gateFailOnceFor = undefined;
    env.boundary.script.reviewerRejectFirst = false;

    const created = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "replan control goal",
        project: { path: "so/console-e2e" },
        approvals: "manual",
      },
    });
    expect(created.status).toBe(201);
    const scopeId = (created.body as { id: string }).id;

    const hasPlan = await waitFor(
      "initial plan",
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
    expect(hasPlan).toBe(true);

    const firstSnap = await http(env.port, "GET", `/scopes/${scopeId}`);
    expect(firstSnap.status).toBe(200);
    const firstPlanJson = (firstSnap.body as { scope: { plan_json: string } })
      .scope.plan_json;
    const firstPlan = JSON.parse(firstPlanJson) as {
      summary?: string;
      tasks?: { title: string }[];
    };
    const firstTitles = (firstPlan.tasks ?? []).map((t) => t.title);

    const feedback =
      "Split the migration from the rollout task and make the rollback explicit.";
    const replan = await http(env.port, "POST", `/scopes/${scopeId}/replan`, {
      body: { feedback },
    });
    expect(replan.status).toBe(200);
    const replanBody = replan.body as
      | { status: string; plan_json: string | null }
      | { scope: { status: string; plan_json: string | null } };
    const scopeAfterReplan =
      (replanBody as { scope?: { status: string; plan_json: string | null } })
        .scope ?? (replanBody as { status: string; plan_json: string | null });
    expect(scopeAfterReplan.status).toBe("planning");
    expect(scopeAfterReplan.plan_json).toBeNull();

    // replan with empty body -> 400 INVALID_BODY (needs scope still planning with no plan, so do before new plan arrives)
    const emptyBody = await http(
      env.port,
      "POST",
      `/scopes/${scopeId}/replan`,
      {
        body: {},
      },
    );
    // This hits the body validation before NO_PLAN_PENDING? Actually scope has no plan_json now, but body is invalid so should be 400
    // However our implementation checks scope status first then body. Scope is planning with no plan_json -> that case returns NO_PLAN_PENDING before body check.
    // But spec says replan with empty/invalid body -> 400. To get 400 we need a scope that still has a plan.
    // Create a fresh scope for invalid body checks.
    const invalidScopeCreated = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "replan invalid body goal",
        project: { path: "so/console-e2e" },
        approvals: "manual",
      },
    });
    expect(invalidScopeCreated.status).toBe(201);
    const invalidScopeId = (invalidScopeCreated.body as { id: string }).id;
    const invalidHasPlan = await waitFor(
      "invalid scope plan",
      async () => {
        const res = await http(env.port, "GET", `/scopes/${invalidScopeId}`);
        if (res.status !== 200) return false;
        const d = res.body as {
          scope: { status: string; plan_json: string | null };
        };
        return d.scope.status === "planning" && !!d.scope.plan_json;
      },
      90_000,
      250,
    );
    expect(invalidHasPlan).toBe(true);
    const emptyOnValidPlan = await http(
      env.port,
      "POST",
      `/scopes/${invalidScopeId}/replan`,
      { body: {} },
    );
    expect(emptyOnValidPlan.status).toBe(400);
    expect(
      (emptyOnValidPlan.body as { error?: { code?: string } })?.error?.code,
    ).toBe("INVALID_BODY");
    const invalidRaw = await httpRaw(
      env.port,
      "POST",
      `/scopes/${invalidScopeId}/replan`,
      JSON.stringify({ feedback: "" }),
      { "content-type": "application/json", "X-Actor-Id": "human:e2e" },
    );
    expect(invalidRaw.status).toBe(400);
    expect(
      (invalidRaw.body as { error?: { code?: string } })?.error?.code,
    ).toBe("INVALID_BODY");

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
          const p = JSON.parse(data.scope.plan_json) as {
            summary?: string;
            tasks?: { title: string }[];
          };
          if (!p.summary?.includes("Revised")) return false;
          const titles = (p.tasks ?? []).map((t) => t.title);
          const same =
            titles.length === firstTitles.length &&
            titles.every((t, i) => t === firstTitles[i]);
          if (same) return false;
          return true;
        } catch {
          return false;
        }
      },
      90_000,
      250,
    );
    expect(newPlanArrived).toBe(true);

    const audit = await http(
      env.port,
      "GET",
      `/audit?scope_id=${encodeURIComponent(scopeId)}&limit=1000`,
    );
    expect(audit.status).toBe(200);
    const rows = audit.body as { action: string; detail_json: string }[];
    const replanRow = rows.find((r) => r.action === "plan.replan_requested");
    expect(replanRow).toBeDefined();
    const detail = JSON.parse(replanRow!.detail_json) as { feedback: string };
    expect(detail.feedback).toBe(feedback);

    const approve = await http(
      env.port,
      "POST",
      `/scopes/${scopeId}/approve-plan`,
    );
    expect(approve.status).toBe(200);
    const replanAfterApprove = await http(
      env.port,
      "POST",
      `/scopes/${scopeId}/replan`,
      { body: { feedback } },
    );
    expect(replanAfterApprove.status).toBe(409);
    expect(
      (replanAfterApprove.body as { error?: { code?: string } })?.error?.code,
    ).toBe("NO_PLAN_PENDING");
  }, 90_000);

  it("2. task transitions", async () => {
    // reset script knobs
    env.boundary.script.implementerStall = true;
    env.boundary.script.gateFailOnceFor = undefined;
    env.boundary.script.reviewerRejectFirst = false;
    env.boundary.script.reviewerCalls = 0;
    env.boundary.script.gateCalls.clear();

    const created = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "task transitions goal",
        project: { path: "so/console-e2e" },
      },
    });
    expect(created.status).toBe(201);
    const scopeId = (created.body as { id: string }).id;

    await waitFor(
      "planning for transitions",
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

    // auto scope auto-materializes, but approve is harmless if planning still
    const approve = await http(
      env.port,
      "POST",
      `/scopes/${scopeId}/approve-plan`,
    );
    // either 200 (if still planning) or 409 (already active) both ok
    expect([200, 409]).toContain(approve.status);

    // wait for at least one running task
    let runningTaskId: string | null = null;
    let runningAttempt = 0;
    const foundRunning = await waitFor(
      "task running",
      async () => {
        const res = await http(env.port, "GET", `/scopes/${scopeId}`);
        if (res.status !== 200) return false;
        const data = res.body as {
          scope: { status: string };
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
    expect(runningTaskId).toBeTruthy();

    // capture attempt before stop
    const beforeStopTask = await http(
      env.port,
      "GET",
      `/tasks/${runningTaskId!}`,
    );
    expect(beforeStopTask.status).toBe(200);
    const beforeAttempt = (beforeStopTask.body as { task: { attempt: number } })
      .task.attempt;

    const stopRes = await http(
      env.port,
      "POST",
      `/tasks/${runningTaskId!}/stop`,
    );
    expect(stopRes.status).toBe(200);
    const stopped =
      (stopRes.body as { state?: string; task?: { state: string } }).state !==
      undefined
        ? (stopRes.body as {
            state: string;
            attempt: number;
            next_retry_at: string | null;
          })
        : (
            stopRes.body as {
              task: {
                state: string;
                attempt: number;
                next_retry_at: string | null;
              };
            }
          ).task;
    expect((stopped as { state: string }).state).toBe("queued");
    expect((stopped as { attempt: number }).attempt).toBe(beforeAttempt);
    expect(
      (stopped as { next_retry_at: string | null }).next_retry_at,
    ).toBeNull();

    const auditStop = await http(
      env.port,
      "GET",
      `/audit?task_id=${encodeURIComponent(runningTaskId!)}&limit=1000`,
    );
    expect(auditStop.status).toBe(200);
    const stopRows = auditStop.body as { action: string }[];
    expect(stopRows.some((r) => r.action === "task.stop_and_retry")).toBe(true);

    // stop a running task with NO active run -> 409 NO_ACTIVE_RUN
    // create running without run via store
    const store = env.handle.ctx.store;
    // find a queued task to fake
    const snap = await http(env.port, "GET", `/scopes/${scopeId}`);
    const tasks = (snap.body as { tasks: { id: string; state: string }[] })
      .tasks;
    const queuedForFake = tasks.find((t) => t.state === "queued");
    expect(queuedForFake).toBeDefined();
    const fakeId = queuedForFake!.id;
    const fakeTask = store.getTask(fakeId)!;
    // transition queued -> running without creating a run
    store.transitionTask(
      fakeId,
      fakeTask.state_version,
      "running",
      "human:e2e",
    );
    const noActiveRunRes = await http(
      env.port,
      "POST",
      `/tasks/${fakeId}/stop`,
    );
    expect(noActiveRunRes.status).toBe(409);
    expect(
      (noActiveRunRes.body as { error?: { code?: string } })?.error?.code,
    ).toBe("NO_ACTIVE_RUN");
    // cleanup: put it back to queued
    const afterFake = store.getTask(fakeId)!;
    store.transitionTask(
      fakeId,
      afterFake.state_version,
      "queued",
      "human:e2e",
      {
        attempt: afterFake.attempt,
        next_retry_at: null,
      },
    );

    // stop a non-running task -> 409 NOT_RUNNING
    const notRunningId = fakeId; // now queued
    const notRunningRes = await http(
      env.port,
      "POST",
      `/tasks/${notRunningId}/stop`,
    );
    expect(notRunningRes.status).toBe(409);
    expect(
      (notRunningRes.body as { error?: { code?: string } })?.error?.code,
    ).toBe("NOT_RUNNING");

    // unstall to allow progress for remaining ops
    env.boundary.script.implementerStall = false;
    // small wait for tick to dispatch if needed, but not required

    // cancel a task -> 200 canceled
    const snap2 = await http(env.port, "GET", `/scopes/${scopeId}`);
    const tasks2 = (snap2.body as { tasks: { id: string; state: string }[] })
      .tasks;
    const toCancel = tasks2.find((t) => t.state === "queued") ?? tasks2[0]!;
    const cancelRes = await http(
      env.port,
      "POST",
      `/tasks/${toCancel.id}/cancel`,
    );
    expect(cancelRes.status).toBe(200);
    const canceledState =
      (cancelRes.body as { state?: string; task?: { state: string } }).state ??
      (cancelRes.body as { task: { state: string } }).task.state;
    expect(canceledState).toBe("canceled");

    // cancel again / restore in abandoned scope -> 409 SCOPE_ABANDONED (restore case)
    const abandonCreated = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "abandon cancel goal",
        project: { path: "so/console-e2e" },
        approvals: "manual",
      },
    });
    expect(abandonCreated.status).toBe(201);
    const abandonScopeId = (abandonCreated.body as { id: string }).id;
    await waitFor(
      "abandon scope planning",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${abandonScopeId}`);
        const d = r.body as {
          scope: { status: string; plan_json: string | null };
        };
        return d.scope.status === "planning" && !!d.scope.plan_json;
      },
      90_000,
      250,
    );
    const approveAbandon = await http(
      env.port,
      "POST",
      `/scopes/${abandonScopeId}/approve-plan`,
    );
    expect(approveAbandon.status).toBe(200);
    const abandonTasks = (approveAbandon.body as { tasks: { id: string }[] })
      .tasks;
    const toCancelAbandon = abandonTasks[0]!.id;
    const cancelOne = await http(
      env.port,
      "POST",
      `/tasks/${toCancelAbandon}/cancel`,
    );
    expect(cancelOne.status).toBe(200);
    const abandonRes = await http(
      env.port,
      "POST",
      `/scopes/${abandonScopeId}/abandon`,
    );
    expect(abandonRes.status).toBe(200);
    // cancel again in abandoned (already canceled) -> 409 (generic)
    const cancelAgainAbandoned = await http(
      env.port,
      "POST",
      `/tasks/${toCancelAbandon}/cancel`,
    );
    expect(cancelAgainAbandoned.status).toBe(409);
    const restoreAbandoned = await http(
      env.port,
      "POST",
      `/tasks/${toCancelAbandon}/restore`,
    );
    expect(restoreAbandoned.status).toBe(409);
    expect(
      (restoreAbandoned.body as { error?: { code?: string } })?.error?.code,
    ).toBe("SCOPE_ABANDONED");

    // restore a canceled task in active scope -> 200 queued attempt 0
    const restoreRes = await http(
      env.port,
      "POST",
      `/tasks/${toCancel.id}/restore`,
    );
    expect(restoreRes.status).toBe(200);
    const restored =
      (restoreRes.body as { state?: string; task?: { state: string } })
        .state !== undefined
        ? (restoreRes.body as { state: string; attempt: number })
        : (restoreRes.body as { task: { state: string; attempt: number } })
            .task;
    expect((restored as { state: string }).state).toBe("queued");
    expect((restored as { attempt: number }).attempt).toBe(0);

    // unblock a blocked task -> 200 queued
    // create blocked via store: transition a queued task to blocked
    const snap3 = await http(env.port, "GET", `/scopes/${scopeId}`);
    const tasks3 = (snap3.body as { tasks: { id: string; state: string }[] })
      .tasks;
    const toBlock = tasks3.find((t) => t.state === "queued");
    if (toBlock) {
      const bt = store.getTask(toBlock.id)!;
      // queued -> running -> blocked
      store.transitionTask(
        toBlock.id,
        bt.state_version,
        "running",
        "human:e2e",
      );
      const runningBt = store.getTask(toBlock.id)!;
      store.transitionTask(
        toBlock.id,
        runningBt.state_version,
        "blocked",
        "human:e2e",
        { blocked_reason: "test block" },
      );
      const unblockRes = await http(
        env.port,
        "POST",
        `/tasks/${toBlock.id}/unblock`,
      );
      expect(unblockRes.status).toBe(200);
      const ub =
        (unblockRes.body as { state?: string; task?: { state: string } })
          .state !== undefined
          ? (unblockRes.body as { state: string })
          : (unblockRes.body as { task: { state: string } }).task;
      expect((ub as { state: string }).state).toBe("queued");
    }

    // retry a queued task (clears backoff) -> 200 next_retry_at null
    // create queued with future retry
    const snap4 = await http(env.port, "GET", `/scopes/${scopeId}`);
    const tasks4 = (snap4.body as { tasks: { id: string; state: string }[] })
      .tasks;
    const toRetry = tasks4.find((t) => t.state === "queued");
    if (toRetry) {
      const rt = store.getTask(toRetry.id)!;
      // put into running then back to queued with future next_retry_at
      if (rt.state === "queued") {
        store.transitionTask(
          toRetry.id,
          rt.state_version,
          "running",
          "human:e2e",
        );
        const r2 = store.getTask(toRetry.id)!;
        store.transitionTask(
          toRetry.id,
          r2.state_version,
          "queued",
          "human:e2e",
          {
            attempt: r2.attempt + 1,
            next_retry_at: new Date(Date.now() + 60_000).toISOString(),
          },
        );
      }
      const retryRes = await http(
        env.port,
        "POST",
        `/tasks/${toRetry.id}/retry`,
      );
      expect(retryRes.status).toBe(200);
      const retryTask =
        (
          retryRes.body as {
            task?: { next_retry_at: string | null };
            next_retry_at?: string | null;
          }
        ).task ?? (retryRes.body as { next_retry_at: string | null });
      expect(
        (retryTask as { next_retry_at: string | null }).next_retry_at,
      ).toBeNull();
    }

    // retry a non-queued task -> 409 NOT_QUEUED (use canceled from abandoned)
    const retryNonQueued = await http(
      env.port,
      "POST",
      `/tasks/${toCancelAbandon}/retry`,
    );
    expect(retryNonQueued.status).toBe(409);
    expect(
      (retryNonQueued.body as { error?: { code?: string } })?.error?.code,
    ).toBe("NOT_QUEUED");

    // amend-spec on mr_open task -> 200 and spec contains amendment
    // drive to mr_open
    const mrOpenFound = await waitFor(
      "mr_open for amend",
      async () => {
        const res = await http(env.port, "GET", `/scopes/${scopeId}`);
        if (res.status !== 200) return false;
        const data = res.body as { tasks: { id: string; state: string }[] };
        return data.tasks.some((t) => t.state === "mr_open");
      },
      90_000,
      250,
    );
    expect(mrOpenFound).toBe(true);
    const snapMr = await http(env.port, "GET", `/scopes/${scopeId}`);
    const mrTask = (
      snapMr.body as { tasks: { id: string; state: string }[] }
    ).tasks.find((t) => t.state === "mr_open")!;
    const amendment = "Amended spec for testing " + Date.now();
    const amendRes = await http(
      env.port,
      "POST",
      `/tasks/${mrTask.id}/amend-spec`,
      { body: { feedback: amendment } },
    );
    expect(amendRes.status).toBe(200);
    const taskGet = await http(env.port, "GET", `/tasks/${mrTask.id}`);
    expect(taskGet.status).toBe(200);
    const taskSpec = (taskGet.body as { task: { spec: string } }).task.spec;
    expect(taskSpec).toContain(amendment);

    // request-changes on mr_open -> 200 queued attempt+1 with audit
    // after amend, mr_open was requeued to queued, need to wait for next mr_open
    const mrOpen2 = await waitFor(
      "mr_open requeued",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${scopeId}`);
        const d = r.body as { tasks: { id: string; state: string }[] };
        return d.tasks.some((t) => t.state === "mr_open");
      },
      90_000,
      250,
    );
    expect(mrOpen2).toBe(true);
    const snapMr2 = await http(env.port, "GET", `/scopes/${scopeId}`);
    const mrTask2 = (
      snapMr2.body as { tasks: { id: string; state: string }[] }
    ).tasks.find((t) => t.state === "mr_open")!;
    const beforeAttempt2 = (
      snapMr2.body as { tasks: { id: string; attempt: number }[] }
    ).tasks.find((t) => t.id === mrTask2.id)!.attempt;
    const rc = await http(
      env.port,
      "POST",
      `/tasks/${mrTask2.id}/request-changes`,
      { body: { feedback: "please fix" } },
    );
    expect(rc.status).toBe(200);
    const rcBody =
      (rc.body as { state?: string; task?: { state: string; attempt: number } })
        .state !== undefined
        ? (rc.body as { state: string; attempt: number })
        : (rc.body as { task: { state: string; attempt: number } }).task;
    expect((rcBody as { state: string }).state).toBe("queued");
    expect((rcBody as { attempt: number }).attempt).toBe(beforeAttempt2 + 1);
    const auditRc = await http(
      env.port,
      "GET",
      `/audit?task_id=${encodeURIComponent(mrTask2.id)}&limit=1000`,
    );
    expect(auditRc.status).toBe(200);
    const rcRows = auditRc.body as { action: string }[];
    expect(rcRows.some((r) => r.action === "task.changes_requested")).toBe(
      true,
    );

    // request-changes on non-mr_open -> 409 NO_OPEN_MR
    const snapNonMr = await http(env.port, "GET", `/scopes/${scopeId}`);
    const nonMr = (
      snapNonMr.body as { tasks: { id: string; state: string }[] }
    ).tasks.find((t) => t.state !== "mr_open");
    if (nonMr) {
      const badRc = await http(
        env.port,
        "POST",
        `/tasks/${nonMr.id}/request-changes`,
        { body: { feedback: "x" } },
      );
      expect(badRc.status).toBe(409);
      expect((badRc.body as { error?: { code?: string } })?.error?.code).toBe(
        "NO_OPEN_MR",
      );
    }

    // amend-spec on merged/canceled -> 409 TASK_FINISHED
    // wait for a merged task if possible, otherwise use canceled
    // try to drive to merged quickly by clearing retries and waiting
    // but we can use the abandoned canceled task for canceled case
    const amendCanceled = await http(
      env.port,
      "POST",
      `/tasks/${toCancelAbandon}/amend-spec`,
      { body: { feedback: "should fail canceled" } },
    );
    expect(amendCanceled.status).toBe(409);
    expect(
      (amendCanceled.body as { error?: { code?: string } })?.error?.code,
    ).toBe("TASK_FINISHED");

    // try to get a merged task (if any) for amend check
    const mergedFound = await waitFor(
      "merged for amend",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${scopeId}`);
        const d = r.body as { tasks: { id: string; state: string }[] };
        return d.tasks.some((t) => t.state === "merged");
      },
      30_000,
      250,
    );
    if (mergedFound) {
      const snapM = await http(env.port, "GET", `/scopes/${scopeId}`);
      const mergedTask = (
        snapM.body as { tasks: { id: string; state: string }[] }
      ).tasks.find((t) => t.state === "merged")!;
      const amendMerged = await http(
        env.port,
        "POST",
        `/tasks/${mergedTask.id}/amend-spec`,
        { body: { feedback: "should fail merged" } },
      );
      expect(amendMerged.status).toBe(409);
      expect(
        (amendMerged.body as { error?: { code?: string } })?.error?.code,
      ).toBe("TASK_FINISHED");
    }

    // stop non-running already tested; ensure queued stop fails NOT_RUNNING again
    const finalSnap = await http(env.port, "GET", `/scopes/${scopeId}`);
    const queuedForStop = (
      finalSnap.body as { tasks: { id: string; state: string }[] }
    ).tasks.find((t) => t.state === "queued");
    if (queuedForStop) {
      const stopNotRunning2 = await http(
        env.port,
        "POST",
        `/tasks/${queuedForStop.id}/stop`,
      );
      expect(stopNotRunning2.status).toBe(409);
      expect(
        (stopNotRunning2.body as { error?: { code?: string } })?.error?.code,
      ).toBe("NOT_RUNNING");
    }
  }, 90_000);

  it("3. review loop", async () => {
    const reviewEnv = await bootFake({ reviewMode: "required" });
    try {
      reviewEnv.boundary.script.reviewerRejectFirst = true;
      reviewEnv.boundary.script.reviewerCalls = 0;

      const created = await http(reviewEnv.port, "POST", "/scopes", {
        body: { goal: "review loop goal", project: { path: "so/console-e2e" } },
      });
      expect(created.status).toBe(201);
      const scopeId = (created.body as { id: string }).id;

      await waitFor(
        "review planning",
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
      const approve = await http(
        reviewEnv.port,
        "POST",
        `/scopes/${scopeId}/approve-plan`,
      );
      expect([200, 409]).toContain(approve.status);

      const done = await waitFor(
        "review done",
        async () => {
          const r = await http(reviewEnv.port, "GET", `/scopes/${scopeId}`);
          const d = r.body as { scope: { status: string } };
          return d.scope.status === "done";
        },
        90_000,
        250,
      );
      expect(done).toBe(true);

      const scopeSnap = await http(reviewEnv.port, "GET", `/scopes/${scopeId}`);
      const tasks = (
        scopeSnap.body as { tasks: { id: string; state: string }[] }
      ).tasks;
      expect(tasks.length).toBeGreaterThanOrEqual(1);
      // total review.changes_requested exactly once across scope
      let totalChanges = 0;
      for (const t of tasks) {
        const audit = await http(
          reviewEnv.port,
          "GET",
          `/audit?task_id=${encodeURIComponent(t.id)}&limit=1000`,
        );
        expect(audit.status).toBe(200);
        const rows = audit.body as { action: string }[];
        totalChanges += rows.filter(
          (r) => r.action === "review.changes_requested",
        ).length;
      }
      expect(totalChanges).toBe(1);

      for (const t of tasks) {
        const audit = await http(
          reviewEnv.port,
          "GET",
          `/audit?task_id=${encodeURIComponent(t.id)}&limit=1000`,
        );
        const rows = audit.body as {
          action: string;
          detail_json: string;
        }[];
        const opened = rows.filter((r) => r.action === "mr.opened");
        expect(opened.length).toBe(1);
        const reused = rows.some((r) => r.action === "mr.reused");
        expect(reused).toBe(true);
      }
    } finally {
      await reviewEnv.cleanup();
    }
  }, 90_000);

  it("4. merge gate fail-then-pass", async () => {
    env.boundary.script.gateFailOnceFor = undefined;
    env.boundary.script.gateCalls.clear();
    env.boundary.script.implementerStall = false;

    const created = await http(env.port, "POST", "/scopes", {
      body: { goal: "gate fail goal", project: { path: "so/console-e2e" } },
    });
    expect(created.status).toBe(201);
    const scopeId = (created.body as { id: string }).id;

    await waitFor(
      "gate planning",
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
    // auto scope may be 409, manual would be 200; our goal uses auto default
    expect([200, 409]).toContain(approve.status);

    // need to wait for active and get first task id
    const active = await waitFor(
      "gate active",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${scopeId}`);
        if (r.status !== 200) return false;
        const d = r.body as {
          scope: { status: string };
          tasks: { id: string }[];
        };
        return d.scope.status === "active" && d.tasks.length > 0;
      },
      90_000,
      250,
    );
    expect(active).toBe(true);
    const snap = await http(env.port, "GET", `/scopes/${scopeId}`);
    const tasks = (snap.body as { tasks: { id: string }[] }).tasks;
    const gateTask = tasks[0]!.id;
    env.boundary.script.gateFailOnceFor = gateTask;

    const failed = await waitFor(
      "gate failed",
      async () => {
        const r = await http(env.port, "GET", `/tasks/${gateTask}`);
        if (r.status !== 200) return false;
        const d = r.body as {
          task: { state: string; attempt: number };
          runs: {
            kind: string;
            status: string;
            evidence_json: string | null;
          }[];
        };
        const hasFailed = d.runs.some((run) => {
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
        return hasFailed && d.task.state === "queued" && d.task.attempt === 1;
      },
      90_000,
      250,
    );
    expect(failed).toBe(true);

    const retry = await http(env.port, "POST", `/tasks/${gateTask}/retry`);
    expect(retry.status).toBe(200);

    const merged = await waitFor(
      "gate merged",
      async () => {
        const r = await http(env.port, "GET", `/tasks/${gateTask}`);
        if (r.status !== 200) return false;
        const d = r.body as {
          task: { state: string };
          runs: { kind: string; status: string }[];
        };
        return (
          d.task.state === "merged" &&
          d.runs.some(
            (x) => x.kind === "merge_gate" && x.status === "succeeded",
          )
        );
      },
      90_000,
      250,
    );
    expect(merged).toBe(true);

    const audit = await http(
      env.port,
      "GET",
      `/audit?task_id=${encodeURIComponent(gateTask)}&limit=1000`,
    );
    expect(audit.status).toBe(200);
    const rows = audit.body as { action: string }[];
    const opened = rows.filter((r) => r.action === "mr.opened");
    expect(opened.length).toBe(1);
  }, 90_000);

  it("5. manual vs auto merge approvals", async () => {
    env.boundary.script.gateFailOnceFor = undefined;
    env.boundary.script.gateCalls.clear();
    env.boundary.script.implementerStall = false;

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
    const manualApprove = await http(
      env.port,
      "POST",
      `/scopes/${manualScopeId}/approve-plan`,
    );
    expect(manualApprove.status).toBe(200);

    const mrOpen = await waitFor(
      "manual mr_open",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${manualScopeId}`);
        const d = r.body as { tasks: { id: string; state: string }[] };
        return d.tasks.some((t) => t.state === "mr_open");
      },
      90_000,
      250,
    );
    expect(mrOpen).toBe(true);

    const snap = await http(env.port, "GET", `/scopes/${manualScopeId}`);
    const mrTask = (
      snap.body as { tasks: { id: string; state: string }[] }
    ).tasks.find((t) => t.state === "mr_open")!;
    const stillOpen = await http(env.port, "GET", `/tasks/${mrTask.id}`);
    expect(stillOpen.status).toBe(200);
    expect((stillOpen.body as { task: { state: string } }).task.state).toBe(
      "mr_open",
    );

    const approveMerge = await http(
      env.port,
      "POST",
      `/tasks/${mrTask.id}/approve-merge`,
    );
    expect(approveMerge.status).toBe(200);

    const merged = await waitFor(
      "manual merged",
      async () => {
        const r = await http(env.port, "GET", `/tasks/${mrTask.id}`);
        const d = r.body as { task: { state: string } };
        return d.task.state === "merged";
      },
      90_000,
      250,
    );
    expect(merged).toBe(true);

    // auto scope approve-merge -> 409 AUTO_MERGE_SCOPE
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
    const autoApprove = await http(
      env.port,
      "POST",
      `/scopes/${autoScopeId}/approve-plan`,
    );
    expect([200, 409]).toContain(autoApprove.status);

    // wait for mr_open then check AUTO_MERGE_SCOPE
    const autoMr = await waitFor(
      "auto mr_open",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${autoScopeId}`);
        const d = r.body as { tasks: { id: string; state: string }[] };
        return d.tasks.some((t) => t.state === "mr_open");
      },
      90_000,
      250,
    );
    if (autoMr) {
      const autoSnap2 = await http(env.port, "GET", `/scopes/${autoScopeId}`);
      const chosen = (
        autoSnap2.body as { tasks: { id: string; state: string }[] }
      ).tasks.find((t) => t.state === "mr_open");
      if (chosen) {
        const autoApproveMerge = await http(
          env.port,
          "POST",
          `/tasks/${chosen.id}/approve-merge`,
        );
        expect(autoApproveMerge.status).toBe(409);
        expect(
          (autoApproveMerge.body as { error?: { code?: string } })?.error?.code,
        ).toBe("AUTO_MERGE_SCOPE");
      }
    }

    // approve-merge before mr_open -> 409 NO_OPEN_MR for manual scope queued task
    const manualScope2 = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "manual before mr_open goal",
        project: { path: "so/console-e2e" },
        approvals: "manual",
      },
    });
    expect(manualScope2.status).toBe(201);
    const manualScope2Id = (manualScope2.body as { id: string }).id;
    await waitFor(
      "manual2 planning",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${manualScope2Id}`);
        const d = r.body as {
          scope: { status: string; plan_json: string | null };
        };
        return d.scope.status === "planning" && !!d.scope.plan_json;
      },
      90_000,
      250,
    );
    const approve2 = await http(
      env.port,
      "POST",
      `/scopes/${manualScope2Id}/approve-plan`,
    );
    expect(approve2.status).toBe(200);
    const tasks2 = (approve2.body as { tasks: { id: string; state: string }[] })
      .tasks;
    const queuedManual = tasks2.find((t) => t.state === "queued")!;
    const beforeMr = await http(
      env.port,
      "POST",
      `/tasks/${queuedManual.id}/approve-merge`,
    );
    expect(beforeMr.status).toBe(409);
    expect((beforeMr.body as { error?: { code?: string } })?.error?.code).toBe(
      "NO_OPEN_MR",
    );
  }, 90_000);

  it("6. abandon", async () => {
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
      "abandon planning",
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
    expect(approve.status).toBe(200);

    const abandon = await http(env.port, "POST", `/scopes/${scopeId}/abandon`);
    expect(abandon.status).toBe(200);
    const abandonedScope =
      (abandon.body as { status?: string; scope?: { status: string } }).scope ??
      (abandon.body as { status: string });
    expect((abandonedScope as { status: string }).status).toBe("abandoned");

    const snap = await http(env.port, "GET", `/scopes/${scopeId}`);
    expect(snap.status).toBe(200);
    const tasks = (snap.body as { tasks: { id: string; state: string }[] })
      .tasks;
    for (const t of tasks) {
      expect(["canceled", "merged"]).toContain(t.state);
      if (t.state !== "merged") expect(t.state).toBe("canceled");
    }

    const audit = await http(
      env.port,
      "GET",
      `/audit?scope_id=${encodeURIComponent(scopeId)}&limit=1000`,
    );
    expect(audit.status).toBe(200);
    const rows = audit.body as {
      action: string;
      detail_json: string;
    }[];
    const hasAbandon = rows.some(
      (r) =>
        r.action === "scope.transition" &&
        (() => {
          try {
            const d = JSON.parse(r.detail_json) as { to?: string };
            return d.to === "abandoned";
          } catch {
            return false;
          }
        })(),
    );
    expect(hasAbandon).toBe(true);
    // also at least one task transition to canceled
    const canceledTransitions = rows.filter(
      (r) => r.action === "task.transition",
    );
    expect(canceledTransitions.length).toBeGreaterThan(0);
  }, 90_000);
});
