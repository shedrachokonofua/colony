import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { http, httpRaw, waitFor } from "../e2e/client.js";
import { bootFake, type BootFakeHandle } from "../e2e/boot-fake.js";

async function waitForTaskState(
  port: number,
  scopeId: string,
  state: string,
  budgetMs: number,
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
    budgetMs,
    250,
  );
  return found;
}

describe("api e2e control — 1. replan + replacement plan", () => {
  let env: BootFakeHandle;

  beforeAll(async () => {
    env = await bootFake();
  }, 90_000);

  afterAll(async () => {
    if (env) await env.cleanup();
  });

  it("creates revised plan, audits feedback, validates error branches", async () => {
    const created = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "replan control goal",
        title: "replan control goal",
        repo: { path: "so/console-e2e" },
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
      30_000,
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
    // Stall architect to make the intermediate null observable
    (
      env.boundary.script as unknown as { architectStall?: boolean }
    ).architectStall = true;
    const replanRes = await http(
      env.port,
      "POST",
      `/scopes/${scopeId}/replan`,
      {
        body: { feedback },
      },
    );
    expect(replanRes.status).toBe(200);
    expect(
      (replanRes.body as { plan_json: string | null }).plan_json,
    ).toBeNull();
    expect((replanRes.body as { status: string }).status).toBe("planning");

    const afterReplanSnap = await http(env.port, "GET", `/scopes/${scopeId}`);
    expect(
      (afterReplanSnap.body as { scope: { status: string } }).scope.status,
    ).toBe("planning");
    expect(
      (afterReplanSnap.body as { scope: { plan_json: string | null } }).scope
        .plan_json,
    ).toBeNull();
    // release architect to produce revised plan
    (
      env.boundary.script as unknown as { architectStall?: boolean }
    ).architectStall = false;

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
      30_000,
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
    const rows = (
      audit.body as {
        events: { action: string; detail_json: string }[];
      }
    ).events;
    const replanRow = rows.find((r) => r.action === "plan.replan_requested");
    expect(replanRow).toBeDefined();
    const detail = JSON.parse(replanRow!.detail_json) as { feedback?: string };
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

describe("api e2e control — 2. task transitions", () => {
  let env: BootFakeHandle;

  beforeAll(async () => {
    env = await bootFake();
  }, 90_000);

  afterAll(async () => {
    if (env) await env.cleanup();
    // ensure any lingering stall is released for next suite
    if (env?.boundary?.script) {
      (
        env.boundary.script as unknown as { implementerStall?: boolean }
      ).implementerStall = false;
    }
  });

  it("stop / cancel / restore / unblock / retry / amend-spec / request-changes", async () => {
    // --- 2a stop with active run ---
    (
      env.boundary.script as unknown as { implementerStall?: boolean }
    ).implementerStall = true;
    const stopScope = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "task transitions stop goal",
        title: "task transitions stop goal",
        repo: { path: "so/console-e2e" },
        approvals: "auto",
      },
    });
    expect(stopScope.status).toBe(201);
    const stopScopeId = (stopScope.body as { id: string }).id;

    await waitFor(
      "stopScope active",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${stopScopeId}`);
        const d = r.body as { scope: { status: string }; tasks: unknown[] };
        return (
          d.scope.status === "active" && (d.tasks as unknown[]).length >= 1
        );
      },
      30_000,
      250,
    );

    let runningTaskId: string | undefined;
    let runningAttempt: number | undefined;
    const foundRunning = await waitFor(
      "running task",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${stopScopeId}`);
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
      30_000,
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
    expect(stopped.attempt).toBe(runningAttempt!);
    expect(stopped.next_retry_at).toBeNull();

    const auditStop = await http(
      env.port,
      "GET",
      `/audit?task_id=${encodeURIComponent(runningTaskId!)}&limit=1000`,
    );
    expect(auditStop.status).toBe(200);
    expect(
      (auditStop.body as { events: { action: string }[] }).events.some(
        (r) => r.action === "task.stop_and_retry",
      ),
    ).toBe(true);

    // --- NO_ACTIVE_RUN: use isolated scope with stall disabled so tick does not
    //     reconcile the synthetic running state before /stop. Earlier /stop called
    //     requestTick(); under stall the tick re-dispatches queued tasks and can
    //     make the subsequent transitionTask fail or race.
    const store = (env.handle as unknown as { ctx: { store: unknown } }).ctx
      .store as {
      listTasks: (
        scopeId: string,
      ) => { id: string; state: string; state_version: number }[];
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
    // Isolate NO_ACTIVE_RUN from tick races: .2 depends on .1 so dispatch
    // never picks it while .1 is pending, making it quiescent. Still, the
    // reconciler (expireLeases) requeues a synthetic running task on its
    // next 250ms tick before /stop arrives. Retry once if we lose that race.
    // NO_ACTIVE_RUN — deterministic via isolated abandoned scope (no dispatch/reconcile race).
    // Abandon before synthetic running transition: transitionTask does not check scope status,
    // dispatchImplementers/advanceMrOpenTasks skip non-active scopes, and expireLeases has no runs to expire.
    (env.boundary.script as unknown as { singleTask?: boolean }).singleTask =
      true;
    (
      env.boundary.script as unknown as { implementerStall?: boolean }
    ).implementerStall = true;
    const noRunScopeRes = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "no active run deterministic goal",
        title: "no active run deterministic goal",
        repo: { path: "so/console-e2e" },
        approvals: "manual",
      },
    });
    expect(noRunScopeRes.status).toBe(201);
    const noRunScopeId = (noRunScopeRes.body as { id: string }).id;
    await waitFor(
      "noRun planning",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${noRunScopeId}`);
        const d = r.body as {
          scope: { status: string; plan_json: string | null };
        };
        return d.scope.status === "planning" && !!d.scope.plan_json;
      },
      30_000,
      250,
    );
    await http(env.port, "POST", `/scopes/${noRunScopeId}/approve-plan`);
    await waitFor(
      "noRun queued",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${noRunScopeId}`);
        const d = r.body as { tasks: { id: string }[] };
        return d.tasks.some((t) => t.id === `${noRunScopeId}.1`);
      },
      10_000,
      250,
    );
    await http(env.port, "POST", `/scopes/${noRunScopeId}/abandon`);
    const noRunTaskId = `${noRunScopeId}.1`;
    // Contract under test: stop on a task in 'running' with no active run
    // rows is 409 NO_ACTIVE_RUN. That state is transient BY DESIGN - the tick
    // reconciler requeues exactly such tasks every tick - so manufacture it
    // and race the stop against the reconciler with bounded retries: if the
    // reconciler wins (stop sees a requeued task), re-force and try again.
    // The assertion on the observed 409 path stays strict.
    let noRunRes: Awaited<ReturnType<typeof http>> | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      store.db
        .prepare(
          "UPDATE tasks SET state='running', state_version=state_version+1, updated_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), noRunTaskId);
      noRunRes = await http(env.port, "POST", `/tasks/${noRunTaskId}/stop`);
      if (noRunRes.status === 409) break;
    }
    expect(noRunRes?.status).toBe(409);
    expect((noRunRes?.body as { error?: { code?: string } })?.error?.code).toBe(
      "NO_ACTIVE_RUN",
    );
    // Restore to canceled via SQL for clean abandoned scope (no effect on dispatch as scope abandoned)
    store.db
      .prepare(
        "UPDATE tasks SET state='canceled', state_version=state_version+1, updated_at=? WHERE id=?",
      )
      .run(new Date().toISOString(), noRunTaskId);
    (env.boundary.script as unknown as { singleTask?: boolean }).singleTask =
      false;
    (
      env.boundary.script as unknown as { implementerStall?: boolean }
    ).implementerStall = true;

    // --- NOT_RUNNING: stop a queued task ---
    const snapForNotRunning = await http(
      env.port,
      "GET",
      `/scopes/${stopScopeId}`,
    );
    const queuedTask = (
      snapForNotRunning.body as { tasks: { id: string; state: string }[] }
    ).tasks.find((t) => t.state === "queued");
    expect(queuedTask).toBeDefined();
    const notRunningRes = await http(
      env.port,
      "POST",
      `/tasks/${queuedTask!.id}/stop`,
    );
    expect(notRunningRes.status).toBe(409);
    expect(
      (notRunningRes.body as { error?: { code?: string } })?.error?.code,
    ).toBe("NOT_RUNNING");

    // cleanup stall and abandon this scope so it does not leak
    (
      env.boundary.script as unknown as { implementerStall?: boolean }
    ).implementerStall = false;
    await http(env.port, "POST", `/scopes/${stopScopeId}/abandon`);

    // --- 2b cancel / restore / unblock / retry / abandoned interactions ---
    // Stall implementer so queued tasks stay queued for deterministic checks
    (
      env.boundary.script as unknown as { implementerStall?: boolean }
    ).implementerStall = true;
    const base = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "task transitions cancel restore goal",
        title: "task transitions cancel restore goal",
        repo: { path: "so/console-e2e" },
        approvals: "manual",
      },
    });
    expect(base.status).toBe(201);
    const baseId = (base.body as { id: string }).id;
    await waitFor(
      "base planning",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${baseId}`);
        const d = r.body as {
          scope: { status: string; plan_json: string | null };
        };
        return d.scope.status === "planning" && !!d.scope.plan_json;
      },
      30_000,
      250,
    );
    await http(env.port, "POST", `/scopes/${baseId}/approve-plan`);
    await waitFor(
      "base queued",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${baseId}`);
        const d = r.body as { tasks: { state: string }[] };
        return d.tasks.some((t) => t.state === "queued");
      },
      15_000,
      250,
    );
    const snap = await http(env.port, "GET", `/scopes/${baseId}`);
    const tasks = (snap.body as { tasks: { id: string; state: string }[] })
      .tasks;
    const toCancel = tasks.find((t) => t.state === "queued");
    expect(toCancel).toBeDefined();
    const cancelRes = await http(
      env.port,
      "POST",
      `/tasks/${toCancel!.id}/cancel`,
    );
    expect(cancelRes.status).toBe(200);
    expect((cancelRes.body as { state: string }).state).toBe("canceled");
    const canceledIdForLater = toCancel!.id;

    const restoreRes = await http(
      env.port,
      "POST",
      `/tasks/${canceledIdForLater}/restore`,
    );
    expect(restoreRes.status).toBe(200);
    expect((restoreRes.body as { state: string }).state).toBe("queued");
    expect((restoreRes.body as { attempt: number }).attempt).toBe(0);

    await http(env.port, "POST", `/tasks/${canceledIdForLater}/cancel`);

    // unblock: dedicated scope — force a task to blocked via SQL
    (
      env.boundary.script as unknown as { implementerStall?: boolean }
    ).implementerStall = false;
    const unblockScope = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "unblock goal",
        title: "unblock goal",
        repo: { path: "so/console-e2e" },
        approvals: "manual",
      },
    });
    expect(unblockScope.status).toBe(201);
    const unblockScopeId = (unblockScope.body as { id: string }).id;
    await waitFor(
      "unblock planning",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${unblockScopeId}`);
        const d = r.body as {
          scope: { status: string; plan_json: string | null };
        };
        return d.scope.status === "planning" && !!d.scope.plan_json;
      },
      30_000,
      250,
    );
    // prevent dispatch from racing away queued
    (
      env.boundary.script as unknown as { implementerStall?: boolean }
    ).implementerStall = true;
    await http(env.port, "POST", `/scopes/${unblockScopeId}/approve-plan`);
    // task id deterministic for single default plan; pick first task
    const unblockTaskId = `${unblockScopeId}.1`;
    await waitFor(
      "unblock task exists",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${unblockScopeId}`);
        const d = r.body as { tasks: { id: string }[] };
        return d.tasks.some((t) => t.id === unblockTaskId);
      },
      10_000,
      250,
    );
    store.db
      .prepare(
        "UPDATE tasks SET state = 'blocked', blocked_reason = ?, state_version = state_version + 1, updated_at = ? WHERE id = ?",
      )
      .run("test block", new Date().toISOString(), unblockTaskId);
    const toBlock = { id: unblockTaskId } as { id: string };
    const unblockRes = await http(
      env.port,
      "POST",
      `/tasks/${toBlock.id}/unblock`,
    );
    expect(unblockRes.status).toBe(200);
    expect((unblockRes.body as { state: string }).state).toBe("queued");
    (
      env.boundary.script as unknown as { implementerStall?: boolean }
    ).implementerStall = false;
    await http(env.port, "POST", `/scopes/${unblockScopeId}/abandon`);

    // retry: queued task with future next_retry_at, then clear — use a fresh scope
    (
      env.boundary.script as unknown as { implementerStall?: boolean }
    ).implementerStall = true;
    const retryScope = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "retry goal",
        title: "retry goal",
        repo: { path: "so/console-e2e" },
        approvals: "manual",
      },
    });
    expect(retryScope.status).toBe(201);
    const retryScopeId = (retryScope.body as { id: string }).id;
    await waitFor(
      "retry planning",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${retryScopeId}`);
        const d = r.body as {
          scope: { status: string; plan_json: string | null };
        };
        return d.scope.status === "planning" && !!d.scope.plan_json;
      },
      30_000,
      250,
    );
    await http(env.port, "POST", `/scopes/${retryScopeId}/approve-plan`);
    const retryTaskId = `${retryScopeId}.1`;
    await waitFor(
      "retry task exists",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${retryScopeId}`);
        const d = r.body as { tasks: { id: string }[] };
        return d.tasks.some((t) => t.id === retryTaskId);
      },
      10_000,
      250,
    );
    // ensure task is queued and has future backoff
    store.db
      .prepare(
        "UPDATE tasks SET state='queued', state_version=state_version+1, updated_at=? WHERE id=?",
      )
      .run(new Date().toISOString(), retryTaskId);
    const toRetry = { id: retryTaskId } as { id: string };
    const future = new Date(Date.now() + 60_000).toISOString();
    store.db
      .prepare(
        "UPDATE tasks SET next_retry_at = ?, state_version = state_version + 1, updated_at = ? WHERE id = ?",
      )
      .run(future, new Date().toISOString(), toRetry.id);
    const retryRes = await http(env.port, "POST", `/tasks/${toRetry.id}/retry`);
    expect(retryRes.status).toBe(200);
    expect(
      (retryRes.body as { next_retry_at: string | null }).next_retry_at,
    ).toBeNull();
    (
      env.boundary.script as unknown as { implementerStall?: boolean }
    ).implementerStall = false;
    await http(env.port, "POST", `/scopes/${retryScopeId}/abandon`);

    // retry non-queued → 409 NOT_QUEUED
    const badRetry = await http(
      env.port,
      "POST",
      `/tasks/${canceledIdForLater}/retry`,
    );
    expect(badRetry.status).toBe(409);
    expect((badRetry.body as { error?: { code?: string } })?.error?.code).toBe(
      "NOT_QUEUED",
    );

    // scope reactivation via restore when blocked
    store.db
      .prepare(
        "UPDATE scopes SET status = 'blocked', updated_at = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), baseId);
    const reactivateRestore = await http(
      env.port,
      "POST",
      `/tasks/${canceledIdForLater}/restore`,
    );
    expect(reactivateRestore.status).toBe(200);
    expect((reactivateRestore.body as { state: string }).state).toBe("queued");
    const afterReactivate = await http(env.port, "GET", `/scopes/${baseId}`);
    expect(
      (afterReactivate.body as { scope: { status: string } }).scope.status,
    ).toBe("active");

    // abandoned-scope restore/cancel branches
    (
      env.boundary.script as unknown as { implementerStall?: boolean }
    ).implementerStall = false;
    await http(env.port, "POST", `/scopes/${baseId}/abandon`);
    const afterAbandonSnap = await http(env.port, "GET", `/scopes/${baseId}`);
    const afterTasks = (
      afterAbandonSnap.body as { tasks: { id: string; state: string }[] }
    ).tasks;
    // give background task (queued -> running) a chance to settle via abandon
    const canceledInAbandoned = afterTasks.find((t) => t.state === "canceled");
    expect(canceledInAbandoned).toBeDefined();
    const restoreAbandoned = await http(
      env.port,
      "POST",
      `/tasks/${canceledInAbandoned!.id}/restore`,
    );
    expect(restoreAbandoned.status).toBe(409);
    expect(
      (restoreAbandoned.body as { error?: { code?: string } })?.error?.code,
    ).toBe("SCOPE_ABANDONED");
    const cancelAbandoned = await http(
      env.port,
      "POST",
      `/tasks/${canceledInAbandoned!.id}/cancel`,
    );
    expect(cancelAbandoned.status).toBe(409);
    expect(
      (cancelAbandoned.body as { error?: { code?: string } })?.error?.code,
    ).toBe("SCOPE_ABANDONED");

    // --- 2c amend-spec and request-changes (manual to keep mr_open stable) ---
    const amScope = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "amend and request changes goal",
        title: "amend and request changes goal",
        repo: { path: "so/console-e2e" },
        approvals: "manual",
      },
    });
    expect(amScope.status).toBe(201);
    const amScopeId = (amScope.body as { id: string }).id;
    await waitFor(
      "am planning",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${amScopeId}`);
        const d = r.body as {
          scope: { status: string; plan_json: string | null };
        };
        return d.scope.status === "planning" && !!d.scope.plan_json;
      },
      30_000,
      250,
    );
    await http(env.port, "POST", `/scopes/${amScopeId}/approve-plan`);

    const mrOpenId = await waitForTaskState(
      env.port,
      amScopeId,
      "mr_open",
      45_000,
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
    expect((taskGet.body as { task: { spec: string } }).task.spec).toContain(
      amendment,
    );

    const mrOpen2 = await waitForTaskState(
      env.port,
      amScopeId,
      "mr_open",
      45_000,
    );
    expect(mrOpen2).toBeDefined();
    const before = await http(env.port, "GET", `/tasks/${mrOpen2!}`);
    const beforeAttempt = (before.body as { task: { attempt: number } }).task
      .attempt;
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
    expect((rcRes.body as { attempt: number }).attempt).toBe(beforeAttempt + 1);
    const auditRc = await http(
      env.port,
      "GET",
      `/audit?task_id=${encodeURIComponent(mrOpen2!)}&limit=1000`,
    );
    expect(auditRc.status).toBe(200);
    expect(
      (auditRc.body as { events: { action: string }[] }).events.some(
        (r) => r.action === "task.changes_requested",
      ),
    ).toBe(true);

    // NO_OPEN_MR: use a fresh manual scope with guaranteed queued task
    const noOpenScope = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "no open mr goal",
        title: "no open mr goal",
        repo: { path: "so/console-e2e" },
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
      30_000,
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
      15_000,
      250,
    );
    const noOpenSnap = await http(env.port, "GET", `/scopes/${noOpenScopeId}`);
    const noOpenTask = (
      noOpenSnap.body as { tasks: { id: string; state: string }[] }
    ).tasks.find((t) => t.state === "queued");
    expect(noOpenTask).toBeDefined();
    const badRc = await http(
      env.port,
      "POST",
      `/tasks/${noOpenTask!.id}/request-changes`,
      {
        body: { feedback: "again" },
      },
    );
    expect(badRc.status).toBe(409);
    expect((badRc.body as { error?: { code?: string } })?.error?.code).toBe(
      "NO_OPEN_MR",
    );

    // drive amScope to done so it does not leak
    // amend-spec on mr_open above may have left a running implement after stalling; ensure stalled flag stable
    (
      env.boundary.script as unknown as { implementerStall?: boolean }
    ).implementerStall = false;
    const amDone = await waitFor(
      "am done",
      async () => {
        try {
          const snap2 = await http(env.port, "GET", `/scopes/${amScopeId}`);
          if (snap2.status === 200) {
            const s2 = snap2.body as {
              scope: { approvals: string };
              tasks: { id: string; state: string }[];
            };
            for (const t of s2.tasks) {
              if (t.state === "mr_open")
                await http(env.port, "POST", `/tasks/${t.id}/approve-merge`);
              // clear retry backoffs that block dispatch
              if (t.state === "queued") {
                const tr = await http(env.port, "GET", `/tasks/${t.id}`);
                const next = (
                  tr.body as { task: { next_retry_at: string | null } }
                ).task?.next_retry_at;
                if (next && Date.parse(next) > Date.now())
                  await http(env.port, "POST", `/tasks/${t.id}/retry`);
              }
            }
          }
        } catch {
          // ignore
        }
        const r = await http(env.port, "GET", `/scopes/${amScopeId}`);
        const d = r.body as { scope: { status: string } };
        return d.scope.status === "done";
      },
      45_000,
      250,
    );
    expect(amDone).toBe(true);
    const doneSnap = await http(env.port, "GET", `/scopes/${amScopeId}`);
    const doneTasks = (
      doneSnap.body as { tasks: { id: string; state: string }[] }
    ).tasks;
    const merged = doneTasks.find((t) => t.state === "merged");
    expect(merged).toBeDefined();
    const amendMerged = await http(
      env.port,
      "POST",
      `/tasks/${merged!.id}/amend-spec`,
      {
        body: { feedback: "late amend" },
      },
    );
    expect(amendMerged.status).toBe(409);
    expect(
      (amendMerged.body as { error?: { code?: string } })?.error?.code,
    ).toBe("TASK_FINISHED");

    // amend-spec on canceled → 409 TASK_FINISHED
    const cancelScope = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "cancel amend goal",
        title: "cancel amend goal",
        repo: { path: "so/console-e2e" },
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
      30_000,
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
      15_000,
      250,
    );
    const csSnap = await http(env.port, "GET", `/scopes/${cancelScopeId}`);
    const csTask = (
      csSnap.body as { tasks: { id: string; state: string }[] }
    ).tasks.find((t) => t.state === "queued");
    expect(csTask).toBeDefined();
    await http(env.port, "POST", `/tasks/${csTask!.id}/cancel`);
    const amendCanceled = await http(
      env.port,
      "POST",
      `/tasks/${csTask!.id}/amend-spec`,
      {
        body: { feedback: "should fail" },
      },
    );
    expect(amendCanceled.status).toBe(409);
    expect(
      (amendCanceled.body as { error?: { code?: string } })?.error?.code,
    ).toBe("TASK_FINISHED");
    // Outer timeout must exceed the sum of inner waitFor budgets (~390s);
    // condition polls return early on healthy runs.
  }, 420_000);
});

describe("api e2e control — 3. review loop", () => {
  it("reviewerRejectFirst then approve merges on one MR with reuse", async () => {
    const reviewEnv = await bootFake({ reviewMode: "required" });
    try {
      const origGet = reviewEnv.boundary.provider.mergeRequests.get.bind(
        reviewEnv.boundary.provider.mergeRequests,
      );
      reviewEnv.boundary.provider.mergeRequests.get = async (repo, id) => {
        const mr = await origGet(repo, id);
        if (!mr.source_branch) return mr;
        try {
          const head = await reviewEnv.boundary.provider.commits.get(
            repo,
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
      (
        reviewEnv.boundary.script as unknown as { singleTask?: boolean }
      ).singleTask = true;

      const created = await http(reviewEnv.port, "POST", "/scopes", {
        body: {
          goal: "review loop goal",
          title: "review loop goal",
          repo: { path: "so/console-e2e" },
        },
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
        30_000,
        250,
      );
      await http(reviewEnv.port, "POST", `/scopes/${scopeId}/approve-plan`);

      const done = await waitFor(
        "review done",
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
                  if (due > Date.now())
                    await http(reviewEnv.port, "POST", `/tasks/${t.id}/retry`);
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
        60_000,
        250,
      );
      expect(done).toBe(true);

      const snap = await http(reviewEnv.port, "GET", `/scopes/${scopeId}`);
      const tasks = (snap.body as { tasks: { id: string; state: string }[] })
        .tasks;
      expect(tasks.length).toBe(1);
      const firstTask = tasks[0]!.id;
      const audit = await http(
        reviewEnv.port,
        "GET",
        `/audit?task_id=${encodeURIComponent(firstTask)}&limit=1000`,
      );
      expect(audit.status).toBe(200);
      const rows = (audit.body as { events: { action: string }[] }).events;
      expect(
        rows.filter((r) => r.action === "review.changes_requested").length,
      ).toBe(1);

      const scopeAudit = await http(
        reviewEnv.port,
        "GET",
        `/audit?scope_id=${encodeURIComponent(scopeId)}&limit=1000`,
      );
      expect(scopeAudit.status).toBe(200);
      const sRows = (scopeAudit.body as { events: { action: string }[] })
        .events;
      expect(sRows.some((r) => r.action === "mr.reused")).toBe(true);

      const taskAudit = await http(
        reviewEnv.port,
        "GET",
        `/audit?task_id=${encodeURIComponent(firstTask)}&limit=1000`,
      );
      const taskRows = (taskAudit.body as { events: { action: string }[] })
        .events;
      expect(taskRows.filter((r) => r.action === "mr.opened").length).toBe(1);
      expect(taskRows.filter((r) => r.action === "mr.reused").length).toBe(1);
    } finally {
      await reviewEnv.cleanup();
    }
  }, 90_000);
});

describe("api e2e control — 4. merge gate fail-then-pass", () => {
  let env: BootFakeHandle;

  beforeAll(async () => {
    env = await bootFake();
  }, 90_000);

  afterAll(async () => {
    if (env) await env.cleanup();
  });

  it("gate fails once then passes without duplicate MR", async () => {
    const created = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "gate fail goal",
        title: "gate fail goal",
        repo: { path: "so/console-e2e" },
      },
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
      30_000,
      250,
    );
    // set before approve so the gate sees it (task id deterministic)
    const targetTask = `${scopeId}.1`;
    (
      env.boundary.script as unknown as { gateFailOnceFor?: string }
    ).gateFailOnceFor = targetTask;
    (env.boundary.script as unknown as { singleTask?: boolean }).singleTask =
      true;
    await http(env.port, "POST", `/scopes/${scopeId}/approve-plan`);

    // Stall implementer so the gate-failure requeue stays observed as queued
    (
      env.boundary.script as unknown as { implementerStall?: boolean }
    ).implementerStall = true;

    const failed = await waitFor(
      "gate failed requeued",
      async () => {
        const r = await http(env.port, "GET", `/tasks/${targetTask}`);
        if (r.status !== 200) return false;
        const data = r.body as {
          task: {
            state: string;
            attempt: number;
            next_retry_at: string | null;
          };
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
        return (
          hasFailedGate &&
          data.task.state === "queued" &&
          data.task.attempt >= 1
        );
      },
      60_000,
      100,
    );
    expect(failed).toBe(true);

    // clear the gate backoff deterministically under stall before unstalling
    const afterFail = await http(env.port, "GET", `/tasks/${targetTask}`);
    expect(
      (afterFail.body as { task: { attempt: number; state: string } }).task
        .state,
    ).toBe("queued");
    expect(
      (afterFail.body as { task: { attempt: number } }).task.attempt,
    ).toBeGreaterThanOrEqual(1);
    await http(env.port, "POST", `/tasks/${targetTask}/retry`);
    // Verify retry cleared backoff under stall before letting implementer run
    const clearCheck = await http(env.port, "GET", `/tasks/${targetTask}`);
    expect(
      (clearCheck.body as { task: { next_retry_at: string | null } }).task
        .next_retry_at,
    ).toBeNull();
    (
      env.boundary.script as unknown as { implementerStall?: boolean }
    ).implementerStall = false;

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
      45_000,
      250,
    );
    expect(merged).toBe(true);

    const audit = await http(
      env.port,
      "GET",
      `/audit?task_id=${encodeURIComponent(targetTask)}&limit=1000`,
    );
    expect(audit.status).toBe(200);
    expect(
      (audit.body as { events: { action: string }[] }).events.filter(
        (r) => r.action === "mr.opened",
      ).length,
    ).toBe(1);

    (
      env.boundary.script as unknown as { gateFailOnceFor?: string }
    ).gateFailOnceFor = undefined;
    (env.boundary.script as unknown as { singleTask?: boolean }).singleTask =
      false;
    // Inner waitFor budgets sum to 135s (30+60+45); the outer timeout must
    // not undercut them. Condition polls return early on healthy runs.
  }, 180_000);
});

describe("api e2e control — 5. manual vs auto merge approvals", () => {
  let env: BootFakeHandle;

  beforeAll(async () => {
    env = await bootFake();
  }, 90_000);

  afterAll(async () => {
    if (env) await env.cleanup();
  });

  it("manual stays mr_open until approve-merge, auto merges, error branches", async () => {
    const manualCreated = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "manual approvals goal",
        title: "manual approvals goal",
        repo: { path: "so/console-e2e" },
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
      30_000,
      250,
    );
    await http(env.port, "POST", `/scopes/${manualScopeId}/approve-plan`);

    const mrOpen = await waitForTaskState(
      env.port,
      manualScopeId,
      "mr_open",
      30_000,
    );
    expect(mrOpen).toBeDefined();
    const mrTask = await http(env.port, "GET", `/tasks/${mrOpen!}`);
    expect((mrTask.body as { task: { state: string } }).task.state).toBe(
      "mr_open",
    );

    // poll, never sleep: verify task stays mr_open across several polls and no merge.approved appears
    const stillMrOpen = await waitFor(
      "still mr_open poll",
      async () => {
        const r = await http(env.port, "GET", `/tasks/${mrOpen!}`);
        return (r.body as { task: { state: string } }).task.state === "mr_open";
      },
      1_500,
      250,
    );
    expect(stillMrOpen).toBe(true);
    for (let i = 0; i < 3; i++) {
      const r = await http(env.port, "GET", `/tasks/${mrOpen!}`);
      expect((r.body as { task: { state: string } }).task.state).toBe(
        "mr_open",
      );
      await waitFor(`poll gap ${i}`, async () => true, 250, 250);
    }
    const beforeAudit = await http(
      env.port,
      "GET",
      `/audit?task_id=${encodeURIComponent(mrOpen!)}&limit=1000`,
    );
    expect(
      (beforeAudit.body as { events: { action: string }[] }).events.some(
        (row) => row.action === "merge.approved",
      ),
    ).toBe(false);

    // An approval names a head; a stale one is refused, never silently
    // re-targeted at whatever the MR points to now.
    const stale = await http(
      env.port,
      "POST",
      `/tasks/${mrOpen!}/approve-merge`,
      { body: { sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" } },
    );
    expect(stale.status).toBe(409);
    expect((stale.body as { error: { code: string } }).error.code).toBe(
      "HEAD_MOVED",
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
        return (r.body as { task: { state: string } }).task.state === "merged";
      },
      30_000,
      250,
    );
    expect(afterApprove).toBe(true);

    // AUTO_MERGE_SCOPE branch: auto scope, any task will be rejected as AUTO_MERGE_SCOPE even without mr_open
    const autoCreated = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "auto approvals goal",
        title: "auto approvals goal",
        repo: { path: "so/console-e2e" },
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
      30_000,
      250,
    );
    await http(env.port, "POST", `/scopes/${autoScopeId}/approve-plan`);
    // ensure at least one task exists (queued or running) then try approve-merge
    const autoSnap = await waitFor(
      "auto tasks spawned",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${autoScopeId}`);
        const d = r.body as { tasks: { id: string; state: string }[] };
        return d.tasks.length >= 1;
      },
      15_000,
      250,
    );
    expect(autoSnap).toBe(true);
    const autoTasks = (await http(env.port, "GET", `/scopes/${autoScopeId}`))
      .body as {
      tasks: { id: string; state: string }[];
    };
    const autoTask = autoTasks.tasks[0]!;
    expect(autoTask).toBeDefined();
    const badApprove = await http(
      env.port,
      "POST",
      `/tasks/${autoTask.id}/approve-merge`,
    );
    expect(badApprove.status).toBe(409);
    expect(
      (badApprove.body as { error?: { code?: string } })?.error?.code,
    ).toBe("AUTO_MERGE_SCOPE");

    // NO_OPEN_MR branch: manual scope with queued task
    const fresh = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "fresh manual goal",
        title: "fresh manual goal",
        repo: { path: "so/console-e2e" },
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
      30_000,
      250,
    );
    await http(env.port, "POST", `/scopes/${freshId}/approve-plan`);
    await waitFor(
      "fresh queued",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${freshId}`);
        const d = r.body as { tasks: { state: string }[] };
        return d.tasks.some((t) => t.state === "queued");
      },
      15_000,
      250,
    );
    const snap = await http(env.port, "GET", `/scopes/${freshId}`);
    const queued = (
      snap.body as { tasks: { id: string; state: string }[] }
    ).tasks.find((t) => t.state === "queued");
    expect(queued).toBeDefined();
    const early = await http(
      env.port,
      "POST",
      `/tasks/${queued!.id}/approve-merge`,
    );
    expect(early.status).toBe(409);
    expect((early.body as { error?: { code?: string } })?.error?.code).toBe(
      "NO_OPEN_MR",
    );
    // Outer timeout must exceed the sum of inner waitFor budgets (~152s).
  }, 180_000);
});

describe("api e2e control — 6. abandon", () => {
  let env: BootFakeHandle;

  beforeAll(async () => {
    env = await bootFake();
  }, 90_000);

  afterAll(async () => {
    if (env) await env.cleanup();
  });

  it("abandon cancels nonterminal tasks and audits", async () => {
    const created = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "abandon goal",
        title: "abandon goal",
        repo: { path: "so/console-e2e" },
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
      30_000,
      250,
    );
    await http(env.port, "POST", `/scopes/${scopeId}/approve-plan`);
    await waitFor(
      "abandon queued",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${scopeId}`);
        const d = r.body as { tasks: { state: string }[] };
        return d.tasks.some((t) => t.state === "queued");
      },
      15_000,
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
    const rows = (
      audit.body as {
        events: { action: string; detail_json: string }[];
      }
    ).events;
    expect(
      rows.some(
        (r) =>
          r.action === "scope.transition" &&
          JSON.parse(r.detail_json).to === "abandoned",
      ),
    ).toBe(true);

    const taskList = (after.body as { tasks: { id: string; state: string }[] })
      .tasks;
    const canceled = taskList.find((t) => t.state === "canceled");
    expect(canceled).toBeDefined();
    const restoreAbandoned = await http(
      env.port,
      "POST",
      `/tasks/${canceled!.id}/restore`,
    );
    expect(restoreAbandoned.status).toBe(409);
    expect(
      (restoreAbandoned.body as { error?: { code?: string } })?.error?.code,
    ).toBe("SCOPE_ABANDONED");
    const cancelAgain = await http(
      env.port,
      "POST",
      `/tasks/${canceled!.id}/cancel`,
    );
    expect(cancelAgain.status).toBe(409);
    expect(
      (cancelAgain.body as { error?: { code?: string } })?.error?.code,
    ).toBe("SCOPE_ABANDONED");
  }, 90_000);
});
