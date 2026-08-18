import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@colony/config";
import { http, httpRaw, waitFor } from "../e2e/client.js";
import { bootFake, type BootFakeHandle } from "../e2e/boot-fake.js";
import { buildEnvVars, installEnv, prepareEnvWithPort } from "../e2e/env.js";
import { createScriptedBoundary } from "../e2e/fakes.js";

let env: BootFakeHandle;

describe("api e2e control plane", () => {
  beforeAll(async () => {
    env = await bootFake();
  }, 90_000);

  afterAll(async () => {
    if (env) await env.cleanup();
    resetEnvCache();
  });

  it("1. replan + replacement plan", async () => {
    const created = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "replan goal covering migration and rollout",
        project: { path: "so/console-e2e" },
        approvals: "manual",
      },
    });
    expect(created.status).toBe(201);
    const scopeId = (created.body as { id: string }).id;

    const planning = await waitFor(
      "replan initial planning",
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
    expect(planning).toBe(true);

    const firstRes = await http(env.port, "GET", `/scopes/${scopeId}`);
    expect(firstRes.status).toBe(200);
    const firstScope = (firstRes.body as { scope: { plan_json: string | null } })
      .scope;
    const firstPlan = JSON.parse(firstScope.plan_json!) as {
      summary: string;
      tasks: { title: string }[];
    };
    const firstTitles = firstPlan.tasks.map((t) => t.title);

    const feedback =
      "Split the migration from the rollout task and make the rollback explicit.";
    const replanRes = await http(env.port, "POST", `/scopes/${scopeId}/replan`, {
      body: { feedback },
    });
    expect(replanRes.status).toBe(200);
    const afterReplan = await http(env.port, "GET", `/scopes/${scopeId}`);
    expect(afterReplan.status).toBe(200);
    const afterData = afterReplan.body as {
      scope: { status: string; plan_json: string | null };
    };
    expect(afterData.scope.status).toBe("planning");
    expect(afterData.scope.plan_json).toBeNull();

    const revised = await waitFor(
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
            summary: string;
            tasks: { title: string }[];
          };
          if (!plan.summary.includes("Revised")) return false;
          const titles = plan.tasks.map((t) => t.title);
          if (titles.join(",") === firstTitles.join(",")) return false;
          return true;
        } catch {
          return false;
        }
      },
      90_000,
      250,
    );
    expect(revised).toBe(true);

    const revisedRes = await http(env.port, "GET", `/scopes/${scopeId}`);
    const revisedPlan = JSON.parse(
      (revisedRes.body as { scope: { plan_json: string } }).scope.plan_json,
    ) as { summary: string };
    expect(revisedPlan.summary).toContain("Revised");

    const auditRes = await http(
      env.port,
      "GET",
      `/audit?scope_id=${encodeURIComponent(scopeId)}&limit=1000`,
    );
    expect(auditRes.status).toBe(200);
    const rows = auditRes.body as {
      action: string;
      detail_json: string;
    }[];
    const replanRow = rows.find((r) => r.action === "plan.replan_requested");
    expect(replanRow).toBeTruthy();
    const detail = JSON.parse(replanRow!.detail_json) as {
      feedback?: string;
    };
    expect(detail.feedback).toBe(feedback);

    const emptyReplan = await http(
      env.port,
      "POST",
      `/scopes/${scopeId}/replan`,
      { body: {} as unknown as Record<string, unknown> },
    );
    expect(emptyReplan.status).toBe(400);
    expect(
      (emptyReplan.body as { error?: { code?: string } })?.error?.code,
    ).toBe("INVALID_BODY");

    const invalidReplan = await httpRaw(
      env.port,
      "POST",
      `/scopes/${scopeId}/replan`,
      JSON.stringify({ feedback: "" }),
      { "content-type": "application/json", "X-Actor-Id": "human:e2e" },
    );
    expect(invalidReplan.status).toBe(400);
    expect(
      (invalidReplan.body as { error?: { code?: string } })?.error?.code,
    ).toBe("INVALID_BODY");

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
    // stop running with active run
    env.boundary.script.implementerStall = true;
    const created = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "task transitions goal",
        project: { path: "so/console-e2e" },
      },
    });
    expect(created.status).toBe(201);
    const scopeId = (created.body as { id: string }).id;

    const planning = await waitFor(
      "transitions planning",
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
    expect(planning).toBe(true);

    // auto approvals scope materializes automatically; if manual we'd approve, but default is auto
    // For auto, ticks will dispatch; wait for a running task with active run
    const runningObserved = await waitFor(
      "task running with active run",
      async () => {
        const res = await http(env.port, "GET", `/scopes/${scopeId}`);
        if (res.status !== 200) return false;
        const data = res.body as {
          scope: { status: string };
          tasks: { id: string; state: string }[];
          runs: { kind: string; status: string; task_id: string | null }[];
        };
        const running = data.tasks.find((t) => t.state === "running");
        if (!running) return false;
        return data.runs.some(
          (r) =>
            r.kind === "implement" &&
            r.status === "running" &&
            r.task_id === running.id,
        );
      },
      90_000,
      250,
    );
    expect(runningObserved).toBe(true);

    const snap = await http(env.port, "GET", `/scopes/${scopeId}`);
    const snapData = snap.body as {
      tasks: { id: string; state: string; attempt: number }[];
    };
    const runningTask = snapData.tasks.find((t) => t.state === "running")!;
    const attemptBefore = runningTask.attempt;

    const stopRes = await http(
      env.port,
      "POST",
      `/tasks/${runningTask.id}/stop`,
    );
    expect(stopRes.status).toBe(200);
    const stopped = stopRes.body as {
      state: string;
      attempt: number;
      next_retry_at: string | null;
    };
    expect(stopped.state).toBe("queued");
    expect(stopped.attempt).toBe(attemptBefore);
    expect(stopped.next_retry_at).toBeNull();

    const auditStop = await http(
      env.port,
      "GET",
      `/audit?task_id=${encodeURIComponent(runningTask.id)}&limit=1000`,
    );
    expect(auditStop.status).toBe(200);
    const stopRows = auditStop.body as { action: string }[];
    expect(stopRows.some((r) => r.action === "task.stop_and_retry")).toBe(true);

    // allow queued task to be retried; unstall implementer
    env.boundary.script.implementerStall = false;
    // give tick a chance to dispatch again then quickly test NO_ACTIVE_RUN case via store manipulation
    // create a running task without active run using store
    const noActiveScope = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "no active run scope",
        project: { path: "so/console-e2e" },
        approvals: "manual",
      },
    });
    expect(noActiveScope.status).toBe(201);
    const noActiveScopeId = (noActiveScope.body as { id: string }).id;
    await waitFor(
      "no-active planning",
      async () => {
        const res = await http(env.port, "GET", `/scopes/${noActiveScopeId}`);
        const data = res.body as {
          scope: { status: string; plan_json: string | null };
        };
        return data.scope.status === "planning" && !!data.scope.plan_json;
      },
      30_000,
      250,
    );
    const approveNoActive = await http(
      env.port,
      "POST",
      `/scopes/${noActiveScopeId}/approve-plan`,
    );
    expect(approveNoActive.status).toBe(200);
    const tasksNoActive = (
      approveNoActive.body as { tasks: { id: string; state: string }[] }
    ).tasks;
    const taskForNoActive = tasksNoActive[0]!.id;
    // manually transition to running without creating a run
    const store = env.handle.ctx.store;
    const t = store.getTask(taskForNoActive)!;
    store.transitionTask(t.id, t.state_version, "running", "svc:colonyd");
    const stopNoActive = await http(
      env.port,
      "POST",
      `/tasks/${taskForNoActive}/stop`,
    );
    expect(stopNoActive.status).toBe(409);
    expect(
      (stopNoActive.body as { error?: { code?: string } })?.error?.code,
    ).toBe("NO_ACTIVE_RUN");
    // cleanup: requeue via direct transition so scope not stuck
    const cur = store.getTask(taskForNoActive)!;
    if (cur.state === "running") {
      store.transitionTask(cur.id, cur.state_version, "queued", "svc:colonyd", {
        attempt: cur.attempt,
        next_retry_at: null,
        blocked_reason: null,
      });
    }

    // stop non-running task -> 409 NOT_RUNNING
    const queuedTaskId = tasksNoActive[1] ? tasksNoActive[1]!.id : taskForNoActive;
    // ensure queued
    const queuedSnap = store.getTask(queuedTaskId);
    if (queuedSnap && queuedSnap.state !== "queued") {
      // force to queued if needed
      try {
        store.transitionTask(
          queuedSnap.id,
          queuedSnap.state_version,
          "queued",
          "svc:colonyd",
          { attempt: 0, next_retry_at: null },
        );
      } catch {
        // ignore
      }
    }
    const stopNotRunning = await http(
      env.port,
      "POST",
      `/tasks/${queuedTaskId}/stop`,
    );
    expect(stopNotRunning.status).toBe(409);
    expect(
      (stopNotRunning.body as { error?: { code?: string } })?.error?.code,
    ).toBe("NOT_RUNNING");

    // cancel a task -> 200 canceled
    const cancelRes = await http(
      env.port,
      "POST",
      `/tasks/${queuedTaskId}/cancel`,
    );
    expect(cancelRes.status).toBe(200);
    expect((cancelRes.body as { state: string }).state).toBe("canceled");

    // create a scope to abandon and test cancel again / restore in abandoned scope
    const abandonScopeCreated = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "abandon cancel scope",
        project: { path: "so/console-e2e" },
        approvals: "manual",
      },
    });
    expect(abandonScopeCreated.status).toBe(201);
    const abandonScopeId = (abandonScopeCreated.body as { id: string }).id;
    await waitFor(
      "abandon planning",
      async () => {
        const res = await http(env.port, "GET", `/scopes/${abandonScopeId}`);
        const data = res.body as {
          scope: { status: string; plan_json: string | null };
        };
        return data.scope.status === "planning" && !!data.scope.plan_json;
      },
      30_000,
      250,
    );
    const approveAbandon = await http(
      env.port,
      "POST",
      `/scopes/${abandonScopeId}/approve-plan`,
    );
    expect(approveAbandon.status).toBe(200);
    const abandonTasks = (
      approveAbandon.body as { tasks: { id: string }[] }
    ).tasks;
    const cancelTaskId = abandonTasks[0]!.id;
    await http(env.port, "POST", `/tasks/${cancelTaskId}/cancel`);
    const abandonRes = await http(
      env.port,
      "POST",
      `/scopes/${abandonScopeId}/abandon`,
    );
    expect(abandonRes.status).toBe(200);
    // try restore in abandoned scope -> 409 SCOPE_ABANDONED
    const restoreAbandoned = await http(
      env.port,
      "POST",
      `/tasks/${cancelTaskId}/restore`,
    );
    expect(restoreAbandoned.status).toBe(409);
    expect(
      (restoreAbandoned.body as { error?: { code?: string } })?.error?.code,
    ).toBe("SCOPE_ABANDONED");
    // cancel again in abandoned scope -> 409 (expect SCOPE_ABANDONED or CONFLICT)
    const cancelAgain = await http(
      env.port,
      "POST",
      `/tasks/${abandonTasks[1]!.id}/cancel`,
    );
    // this task was canceled by abandon; cancel again should be 409
    expect(cancelAgain.status).toBe(409);

    // restore a canceled task in an active scope -> 200 queued attempt 0 and scope reactivates if done/blocked/validating
    // use a done scope: create and drive to done via auto scope
    const doneScopeCreated = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "restore active goal",
        project: { path: "so/console-e2e" },
        approvals: "manual",
      },
    });
    expect(doneScopeCreated.status).toBe(201);
    const doneScopeId = (doneScopeCreated.body as { id: string }).id;
    await waitFor(
      "restore planning",
      async () => {
        const res = await http(env.port, "GET", `/scopes/${doneScopeId}`);
        const data = res.body as {
          scope: { status: string; plan_json: string | null };
        };
        return data.scope.status === "planning" && !!data.scope.plan_json;
      },
      30_000,
      250,
    );
    const approveDone = await http(
      env.port,
      "POST",
      `/scopes/${doneScopeId}/approve-plan`,
    );
    expect(approveDone.status).toBe(200);
    const doneTasks = (
      approveDone.body as { tasks: { id: string }[] }
    ).tasks;
    const toCancel = doneTasks[0]!.id;
    const cancelForRestore = await http(
      env.port,
      "POST",
      `/tasks/${toCancel}/cancel`,
    );
    expect(cancelForRestore.status).toBe(200);
    // restore should succeed
    const restoreRes = await http(
      env.port,
      "POST",
      `/tasks/${toCancel}/restore`,
    );
    expect(restoreRes.status).toBe(200);
    expect((restoreRes.body as { state: string }).state).toBe("queued");
    expect((restoreRes.body as { attempt: number }).attempt).toBe(0);

    // force a blocked task for unblock/retry tests
    const blockedScopeCreated = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "blocked goal",
        project: { path: "so/console-e2e" },
        approvals: "manual",
      },
    });
    expect(blockedScopeCreated.status).toBe(201);
    const blockedScopeId = (blockedScopeCreated.body as { id: string }).id;
    await waitFor(
      "blocked planning",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${blockedScopeId}`);
        const d = r.body as {
          scope: { status: string; plan_json: string | null };
        };
        return d.scope.status === "planning" && !!d.scope.plan_json;
      },
      30_000,
      250,
    );
    const approveBlocked = await http(
      env.port,
      "POST",
      `/scopes/${blockedScopeId}/approve-plan`,
    );
    expect(approveBlocked.status).toBe(200);
    const blockedTaskId = (
      approveBlocked.body as { tasks: { id: string }[] }
    ).tasks[0]!.id;
    // manually block it
    const bt = store.getTask(blockedTaskId)!;
    // transition queued -> blocked via direct store transition (need to go via running->blocked? but test via store blocked from queued not allowed per state machine; so go queued->running->blocked)
    store.transitionTask(bt.id, bt.state_version, "running", "svc:colonyd");
    const rt = store.getTask(blockedTaskId)!;
    store.transitionTask(rt.id, rt.state_version, "blocked", "svc:colonyd", {
      blocked_reason: "test block",
    });
    const unblockRes = await http(
      env.port,
      "POST",
      `/tasks/${blockedTaskId}/unblock`,
    );
    expect(unblockRes.status).toBe(200);
    expect((unblockRes.body as { state: string }).state).toBe("queued");

    // retry a queued task (clears backoff)
    const retryTaskId = blockedTaskId;
    // set next_retry_at to future
    const qt = store.getTask(retryTaskId)!;
    store.transitionTask(qt.id, qt.state_version, "running", "svc:colonyd");
    const rt2 = store.getTask(retryTaskId)!;
    store.transitionTask(rt2.id, rt2.state_version, "queued", "svc:colonyd", {
      attempt: 1,
      next_retry_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const retryRes = await http(
      env.port,
      "POST",
      `/tasks/${retryTaskId}/retry`,
    );
    expect(retryRes.status).toBe(200);
    expect((retryRes.body as { next_retry_at: string | null }).next_retry_at).toBeNull();

    // retry a non-queued task -> 409 NOT_QUEUED
    // put task to blocked again
    const cur2 = store.getTask(retryTaskId)!;
    store.transitionTask(cur2.id, cur2.state_version, "running", "svc:colonyd");
    const cur3 = store.getTask(retryTaskId)!;
    store.transitionTask(cur3.id, cur3.state_version, "blocked", "svc:colonyd", {
      blocked_reason: "again",
    });
    const retryNotQueued = await http(
      env.port,
      "POST",
      `/tasks/${retryTaskId}/retry`,
    );
    expect(retryNotQueued.status).toBe(409);
    expect(
      (retryNotQueued.body as { error?: { code?: string } })?.error?.code,
    ).toBe("NOT_QUEUED");
    // unblock again for later
    const curBlocked = store.getTask(retryTaskId)!;
    await http(env.port, "POST", `/tasks/${curBlocked.id}/unblock`);

    // amend-spec on mr_open -> 200
    const amendScopeCreated = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "amend spec goal",
        project: { path: "so/console-e2e" },
      },
    });
    expect(amendScopeCreated.status).toBe(201);
    const amendScopeId = (amendScopeCreated.body as { id: string }).id;
    await waitFor(
      "amend planning",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${amendScopeId}`);
        const d = r.body as {
          scope: { status: string; plan_json: string | null };
        };
        return d.scope.status === "planning" && !!d.scope.plan_json;
      },
      30_000,
      250,
    );
    const approveAmend = await http(
      env.port,
      "POST",
      `/scopes/${amendScopeId}/approve-plan`,
    );
    expect(approveAmend.status).toBe(200);
    const amendTasks = (
      approveAmend.body as { tasks: { id: string }[] }
    ).tasks;
    // wait until mr_open
    const mrOpenFound = await waitFor(
      "amend mr_open",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${amendScopeId}`);
        const d = r.body as {
          tasks: { id: string; state: string }[];
        };
        return d.tasks.some((t) => t.state === "mr_open");
      },
      90_000,
      250,
    );
    expect(mrOpenFound).toBe(true);
    const amendSnap = await http(env.port, "GET", `/scopes/${amendScopeId}`);
    const mrOpenTask = (
      amendSnap.body as { tasks: { id: string; state: string }[] }
    ).tasks.find((t) => t.state === "mr_open")!;
    const amendment = "Add explicit rollback step to the spec.";
    const amendRes = await http(
      env.port,
      "POST",
      `/tasks/${mrOpenTask.id}/amend-spec`,
      { body: { feedback: amendment } },
    );
    expect(amendRes.status).toBe(200);
    const taskAfterAmend = await http(
      env.port,
      "GET",
      `/tasks/${mrOpenTask.id}`,
    );
    expect(taskAfterAmend.status).toBe(200);
    expect(
      (taskAfterAmend.body as { task: { spec: string } }).task.spec,
    ).toContain(amendment);

    // amend-spec on merged/canceled -> 409 TASK_FINISHED
    // drive amend scope to done then try amend on merged task
    // use a fresh merged task from earlier doneScope? Instead wait for amendScope to finish after clearing?
    // More reliable: create a canceled task and try amend
    const canceledForAmend = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "canceled amend goal",
        project: { path: "so/console-e2e" },
        approvals: "manual",
      },
    });
    expect(canceledForAmend.status).toBe(201);
    const canceledScopeId = (canceledForAmend.body as { id: string }).id;
    await waitFor(
      "canceled amend planning",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${canceledScopeId}`);
        const d = r.body as {
          scope: { status: string; plan_json: string | null };
        };
        return d.scope.status === "planning" && !!d.scope.plan_json;
      },
      30_000,
      250,
    );
    const approveCanceled = await http(
      env.port,
      "POST",
      `/scopes/${canceledScopeId}/approve-plan`,
    );
    expect(approveCanceled.status).toBe(200);
    const canceledTaskId = (
      approveCanceled.body as { tasks: { id: string }[] }
    ).tasks[0]!.id;
    await http(env.port, "POST", `/tasks/${canceledTaskId}/cancel`);
    const amendCanceled = await http(
      env.port,
      "POST",
      `/tasks/${canceledTaskId}/amend-spec`,
      { body: { feedback: amendment } },
    );
    expect(amendCanceled.status).toBe(409);
    expect(
      (amendCanceled.body as { error?: { code?: string } })?.error?.code,
    ).toBe("TASK_FINISHED");

    // request-changes on mr_open -> 200 queued attempt+1
    // reuse mr_open task if still mr_open; but after amend, mr_open was requeued to queued, need new mr_open
    // wait again for mr_open on amendScope
    const mrOpenAgain = await waitFor(
      "second mr_open for request-changes",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${amendScopeId}`);
        const d = r.body as {
          tasks: { id: string; state: string }[];
        };
        return d.tasks.some((t) => t.state === "mr_open");
      },
      90_000,
      250,
    );
    expect(mrOpenAgain).toBe(true);
    const snap2 = await http(env.port, "GET", `/scopes/${amendScopeId}`);
    const rcTask = (
      snap2.body as { tasks: { id: string; state: string; attempt: number }[] }
    ).tasks.find((t) => t.state === "mr_open")!;
    const attemptBeforeRc = rcTask.attempt;
    const rcRes = await http(
      env.port,
      "POST",
      `/tasks/${rcTask.id}/request-changes`,
      { body: { feedback: "please fix the test" } },
    );
    expect(rcRes.status).toBe(200);
    expect((rcRes.body as { state: string }).state).toBe("queued");
    expect((rcRes.body as { attempt: number }).attempt).toBe(
      attemptBeforeRc + 1,
    );
    const auditRc = await http(
      env.port,
      "GET",
      `/audit?task_id=${encodeURIComponent(rcTask.id)}&limit=1000`,
    );
    expect(auditRc.status).toBe(200);
    expect(
      (auditRc.body as { action: string }[]).some(
        (r) => r.action === "task.changes_requested",
      ),
    ).toBe(true);

    const rcNotOpen = await http(
      env.port,
      "POST",
      `/tasks/${canceledTaskId}/request-changes`,
      { body: { feedback: "oops" } },
    );
    expect(rcNotOpen.status).toBe(409);
    expect(
      (rcNotOpen.body as { error?: { code?: string } })?.error?.code,
    ).toBe("NO_OPEN_MR");
  }, 90_000);

  it("3. review loop", async () => {
    // boot review-required harness
    const prepared = await prepareEnvWithPort();
    // write colony-review.yaml equivalent
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      prepared.configPath,
      [
        "agent_runtime: fake",
        "allow_literal_keys: true",
        "hitl:",
        "  mode: yolo",
        "review:",
        "  mode: required",
        "providers:",
        "  fake_llm:",
        "    api: openai-completions",
        "    base_url: http://localhost:9/v1",
        "    auth:",
        "      kind: api_key",
        "      value: fake-key",
        "    models:",
        "      - id: fake-model",
        "        name: fake-model",
        "agents:",
        "  architect:",
        "    provider: fake_llm",
        "    model: fake-model",
        "  developer:",
        "    provider: fake_llm",
        "    model: fake-model",
        "  reviewer:",
        "    provider: fake_llm",
        "    model: fake-model",
      ].join("\n"),
      "utf8",
    );
    const envVars = buildEnvVars({
      dbPath: prepared.dbPath,
      port: prepared.port,
      configPath: prepared.configPath,
      webhookSecret: "",
      tickMs: 250,
    });
    installEnv(envVars);
    resetEnvCache();
    const { boot } = await import("../src/main.js");
    const boundary = createScriptedBoundary();
    const project = await boundary.provider.projects.create({
      name: "console-e2e",
      path: "so/console-e2e",
    });
    boundary.script.projectId = project.id;
    boundary.script.reviewerRejectFirst = true;
    const reviewHandle = await boot({
      provider: boundary.provider,
      agents: boundary.agents,
      gateExecutor: boundary.gateExecutor,
      validateExecutor: boundary.validateExecutor,
    });
    const reviewPort = prepared.port;
    try {
      const created = await http(reviewPort, "POST", "/scopes", {
        body: {
          goal: "review loop goal",
          project: { path: "so/console-e2e" },
        },
      });
      expect(created.status).toBe(201);
      const scopeId = (created.body as { id: string }).id;

      // wait until task requeued after first review rejection
      const requeued = await waitFor(
        "review requeued",
        async () => {
          const res = await http(reviewPort, "GET", `/scopes/${scopeId}`);
          if (res.status !== 200) return false;
          const data = res.body as {
            tasks: { id: string; state: string; attempt: number }[];
          };
          return data.tasks.some(
            (t) => t.state === "queued" && t.attempt === 1,
          );
        },
        90_000,
        250,
      );
      expect(requeued).toBe(true);

      const scopeSnap = await http(reviewPort, "GET", `/scopes/${scopeId}`);
      const taskId = (
        scopeSnap.body as { tasks: { id: string; state: string }[] }
      ).tasks.find((t) => t.id.endsWith(".1"))!.id;
      const audit = await http(
        reviewPort,
        "GET",
        `/audit?task_id=${encodeURIComponent(taskId)}&limit=1000`,
      );
      expect(audit.status).toBe(200);
      const rows = audit.body as { action: string }[];
      expect(
        rows.filter((r) => r.action === "review.changes_requested").length,
      ).toBe(1);

      // clear retry delay to allow second implement
      reviewHandle.ctx.store.clearRetryDelay(taskId);

      const done = await waitFor(
        "review done",
        async () => {
          const res = await http(reviewPort, "GET", `/scopes/${scopeId}`);
          if (res.status !== 200) return false;
          const data = res.body as {
            scope: { status: string };
            tasks: { state: string }[];
          };
          return (
            data.scope.status === "done" &&
            data.tasks.every((t) => t.state === "merged")
          );
        },
        90_000,
        250,
      );
      expect(done).toBe(true);

      const finalAudit = await http(
        reviewPort,
        "GET",
        `/audit?task_id=${encodeURIComponent(taskId)}&limit=1000`,
      );
      const finalRows = finalAudit.body as { action: string }[];
      expect(
        finalRows.filter((r) => r.action === "mr.opened").length,
      ).toBe(1);
      expect(finalRows.some((r) => r.action === "mr.reused")).toBe(true);
    } finally {
      await reviewHandle.shutdown();
      prepared.cleanup();
      // restore original env for remaining tests
      installEnv(
        buildEnvVars({
          dbPath: env.dir + "/colonyd.db",
          port: env.port,
          configPath: env.dir + "/colony.yaml",
          webhookSecret: "",
          tickMs: 250,
        }),
      );
      // Actually re-install original env vars via current env.handle? simpler: keep existing env handle's DB
      resetEnvCache();
    }
  }, 90_000);

  it("4. merge gate fail-then-pass", async () => {
    const created = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "gate fail goal",
        project: { path: "so/console-e2e" },
      },
    });
    expect(created.status).toBe(201);
    const scopeId = (created.body as { id: string }).id;

    await waitFor(
      "gate planning",
      async () => {
        const res = await http(env.port, "GET", `/scopes/${scopeId}`);
        const data = res.body as {
          scope: { status: string; plan_json: string | null };
        };
        return data.scope.status === "planning" && !!data.scope.plan_json;
      },
      30_000,
      250,
    );
    // approve if manual? but default auto will materialize; ensure we are active
    // poll until first task is mr_open
    const taskId = `${scopeId}.1`;
    env.boundary.script.gateFailOnceFor = taskId;

    const mrOpen = await waitFor(
      "gate mr_open first",
      async () => {
        const res = await http(env.port, "GET", `/scopes/${scopeId}`);
        const data = res.body as {
          tasks: { id: string; state: string }[];
        };
        return data.tasks.some((t) => t.id === taskId && t.state === "mr_open");
      },
      90_000,
      250,
    );
    expect(mrOpen).toBe(true);

    const failedGate = await waitFor(
      "gate failed requeue",
      async () => {
        const res = await http(env.port, "GET", `/tasks/${taskId}`);
        if (res.status !== 200) return false;
        const data = res.body as {
          task: { state: string; attempt: number };
          runs: {
            kind: string;
            status: string;
            evidence_json: string | null;
          }[];
        };
        if (data.task.state !== "queued" || data.task.attempt !== 1)
          return false;
        const failed = data.runs.find(
          (r) => r.kind === "merge_gate" && r.status === "failed",
        );
        if (!failed || !failed.evidence_json) return false;
        try {
          const ev = JSON.parse(failed.evidence_json) as {
            reason?: string;
          };
          return ev.reason === "command_failed";
        } catch {
          return false;
        }
      },
      90_000,
      250,
    );
    expect(failedGate).toBe(true);

    env.handle.ctx.store.clearRetryDelay(taskId);

    const merged = await waitFor(
      "gate merged",
      async () => {
        const res = await http(env.port, "GET", `/tasks/${taskId}`);
        if (res.status !== 200) return false;
        const data = res.body as {
          task: { state: string };
          runs: { kind: string; status: string }[];
        };
        if (data.task.state !== "merged") return false;
        return data.runs.some(
          (r) => r.kind === "merge_gate" && r.status === "succeeded",
        );
      },
      90_000,
      250,
    );
    expect(merged).toBe(true);

    const audit = await http(
      env.port,
      "GET",
      `/audit?task_id=${encodeURIComponent(taskId)}&limit=1000`,
    );
    expect(audit.status).toBe(200);
    const rows = audit.body as { action: string }[];
    expect(rows.filter((r) => r.action === "mr.opened").length).toBe(1);

    env.boundary.script.gateFailOnceFor = undefined;
  }, 90_000);

  it("5. manual vs auto merge approvals", async () => {
    // manual scope driven to mr_open stays mr_open
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
        const res = await http(env.port, "GET", `/scopes/${manualScopeId}`);
        const d = res.body as {
          scope: { status: string; plan_json: string | null };
        };
        return d.scope.status === "planning" && !!d.scope.plan_json;
      },
      30_000,
      250,
    );
    const approveManual = await http(
      env.port,
      "POST",
      `/scopes/${manualScopeId}/approve-plan`,
    );
    expect(approveManual.status).toBe(200);

    const manualMrOpen = await waitFor(
      "manual mr_open",
      async () => {
        const res = await http(env.port, "GET", `/scopes/${manualScopeId}`);
        const d = res.body as {
          tasks: { id: string; state: string }[];
        };
        return d.tasks.some((t) => t.state === "mr_open");
      },
      90_000,
      250,
    );
    expect(manualMrOpen).toBe(true);

    // ensure it stays mr_open for a tick (no auto merge)
    await new Promise((r) => setTimeout(r, 800));
    const stillOpen = await http(env.port, "GET", `/scopes/${manualScopeId}`);
    const stillTask = (
      stillOpen.body as { tasks: { id: string; state: string }[] }
    ).tasks.find((t) => t.state === "mr_open");
    expect(stillTask).toBeTruthy();

    const manualTaskId = stillTask!.id;
    const approveMerge = await http(
      env.port,
      "POST",
      `/tasks/${manualTaskId}/approve-merge`,
    );
    expect(approveMerge.status).toBe(200);

    const manualMerged = await waitFor(
      "manual merged",
      async () => {
        const res = await http(env.port, "GET", `/tasks/${manualTaskId}`);
        if (res.status !== 200) return false;
        return (res.body as { task: { state: string } }).task.state === "merged";
      },
      90_000,
      250,
    );
    expect(manualMerged).toBe(true);

    // approve-merge on AUTO scope -> 409 AUTO_MERGE_SCOPE
    const autoCreated = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "auto approvals scope",
        project: { path: "so/console-e2e" },
      },
    });
    expect(autoCreated.status).toBe(201);
    const autoScopeId = (autoCreated.body as { id: string }).id;
    await waitFor(
      "auto planning",
      async () => {
        const res = await http(env.port, "GET", `/scopes/${autoScopeId}`);
        const d = res.body as {
          scope: { status: string; plan_json: string | null };
        };
        return d.scope.status === "planning" && !!d.scope.plan_json;
      },
      30_000,
      250,
    );
    const autoMrOpen = await waitFor(
      "auto mr_open",
      async () => {
        const res = await http(env.port, "GET", `/scopes/${autoScopeId}`);
        const d = res.body as {
          tasks: { id: string; state: string }[];
        };
        return d.tasks.some((t) => t.state === "mr_open");
      },
      90_000,
      250,
    );
    expect(autoMrOpen).toBe(true);
    const autoSnap = await http(env.port, "GET", `/scopes/${autoScopeId}`);
    const autoTask = (
      autoSnap.body as { tasks: { id: string; state: string }[] }
    ).tasks.find((t) => t.state === "mr_open")!;
    const autoApprove = await http(
      env.port,
      "POST",
      `/tasks/${autoTask.id}/approve-merge`,
    );
    expect(autoApprove.status).toBe(409);
    expect(
      (autoApprove.body as { error?: { code?: string } })?.error?.code,
    ).toBe("AUTO_MERGE_SCOPE");

    // approve-merge before mr_open -> 409 NO_OPEN_MR
    const earlyScopeCreated = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "early approve goal",
        project: { path: "so/console-e2e" },
        approvals: "manual",
      },
    });
    expect(earlyScopeCreated.status).toBe(201);
    const earlyScopeId = (earlyScopeCreated.body as { id: string }).id;
    await waitFor(
      "early planning",
      async () => {
        const res = await http(env.port, "GET", `/scopes/${earlyScopeId}`);
        const d = res.body as {
          scope: { status: string; plan_json: string | null };
        };
        return d.scope.status === "planning" && !!d.scope.plan_json;
      },
      30_000,
      250,
    );
    const approveEarlyPlan = await http(
      env.port,
      "POST",
      `/scopes/${earlyScopeId}/approve-plan`,
    );
    expect(approveEarlyPlan.status).toBe(200);
    const earlyTaskId = (
      approveEarlyPlan.body as { tasks: { id: string }[] }
    ).tasks[0]!.id;
    const earlyApprove = await http(
      env.port,
      "POST",
      `/tasks/${earlyTaskId}/approve-merge`,
    );
    expect(earlyApprove.status).toBe(409);
    expect(
      (earlyApprove.body as { error?: { code?: string } })?.error?.code,
    ).toBe("NO_OPEN_MR");
  }, 90_000);

  it("6. abandon", async () => {
    const created = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "abandon goal",
        project: { path: "so/console-e2e" },
      },
    });
    expect(created.status).toBe(201);
    const scopeId = (created.body as { id: string }).id;

    await waitFor(
      "abandon planning",
      async () => {
        const res = await http(env.port, "GET", `/scopes/${scopeId}`);
        const d = res.body as {
          scope: { status: string; plan_json: string | null };
        };
        return d.scope.status === "planning" && !!d.scope.plan_json;
      },
      30_000,
      250,
    );
    const approve = await http(
      env.port,
      "POST",
      `/scopes/${scopeId}/approve-plan`,
    );
    expect(approve.status).toBe(200);

    const abandonRes = await http(
      env.port,
      "POST",
      `/scopes/${scopeId}/abandon`,
    );
    expect(abandonRes.status).toBe(200);
    expect((abandonRes.body as { status: string }).status).toBe("abandoned");

    const after = await http(env.port, "GET", `/scopes/${scopeId}`);
    expect(after.status).toBe(200);
    const afterData = after.body as {
      scope: { status: string };
      tasks: { state: string }[];
    };
    expect(afterData.scope.status).toBe("abandoned");
    for (const t of afterData.tasks) {
      expect(t.state).toBe("canceled");
    }

    const audit = await http(
      env.port,
      "GET",
      `/audit?scope_id=${encodeURIComponent(scopeId)}&limit=1000`,
    );
    expect(audit.status).toBe(200);
    const rows = audit.body as { action: string; detail_json: string }[];
    expect(rows.some((r) => r.action === "scope.transition")).toBe(true);
    // check at least one transition to abandoned
    const abandonedTransition = rows.find(
      (r) => r.action === "scope.transition" && r.detail_json.includes("abandoned"),
    );
    expect(abandonedTransition).toBeTruthy();
  }, 90_000);
});
