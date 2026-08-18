import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { http, httpRaw, waitFor } from "../e2e/client.js";
import { bootFake, type BootFakeHandle } from "../e2e/boot-fake.js";

let env: BootFakeHandle;
let scopeId: string;

describe("api e2e lifecycle", () => {
  beforeAll(async () => {
    env = await bootFake();
  }, 90_000);

  afterAll(async () => {
    if (env) await env.cleanup();
  });

  it("POST /scopes happy → 201 and errors", async () => {
    // invalid JSON
    const bad = await httpRaw(env.port, "POST", "/scopes", "{not json", {
      "content-type": "application/json",
      "X-Actor-Id": "human:e2e",
    });
    expect(bad.status).toBe(400);
    expect((bad.body as { error?: { code?: string } })?.error?.code).toBe(
      "INVALID_BODY",
    );

    // missing actor
    const missingActor = await httpRaw(
      env.port,
      "POST",
      "/scopes",
      JSON.stringify({ goal: "hello", project: { path: "so/console-e2e" } }),
      { "content-type": "application/json" },
    );
    expect(missingActor.status).toBe(400);
    expect(
      (missingActor.body as { error?: { code?: string } })?.error?.code,
    ).toBe("MISSING_ACTOR");

    // unknown project
    const unknown = await http(env.port, "POST", "/scopes", {
      body: { goal: "hello", project: { path: "so/unknown" } },
    });
    expect(unknown.status).toBe(404);
    expect((unknown.body as { error?: { code?: string } })?.error?.code).toBe(
      "PROJECT_NOT_FOUND",
    );

    // happy
    const created = await http(env.port, "POST", "/scopes", {
      body: { goal: "e2e lifecycle goal", project: { path: "so/console-e2e" } },
    });
    expect(created.status).toBe(201);
    const body = created.body as {
      id: string;
      status: string;
      provider_project_path: string;
    };
    expect(body.id).toMatch(/^col-/);
    expect(["planning", "draft"]).toContain(body.status);
    expect(body.provider_project_path).toBe("so/console-e2e");
    scopeId = body.id;
  }, 90_000);

  it("Planning: scope becomes planning with plan_json and architect run", async () => {
    const ok = await waitFor(
      "planning",
      async () => {
        const res = await http(env.port, "GET", `/scopes/${scopeId}`);
        if (res.status !== 200) return false;
        const data = res.body as {
          scope: { status: string; plan_json: string | null };
          runs: { kind: string }[];
        };
        return (
          data.scope.status === "planning" &&
          !!data.scope.plan_json &&
          data.runs.some((r) => r.kind === "architect")
        );
      },
      90_000,
      250,
    );
    expect(ok).toBe(true);
  }, 90_000);

  it("POST /scopes/:id/approve-plan → 200 with tasks, second → 409", async () => {
    // poll until materializable if needed but plan should be ready
    const first = await http(
      env.port,
      "POST",
      `/scopes/${scopeId}/approve-plan`,
    );
    // If yolo auto-materialized, approve will be 409; handle both paths
    if (first.status === 409) {
      // fetch deps to validate wiring still
      const fetched = await http(env.port, "GET", `/scopes/${scopeId}`);
      expect(fetched.status).toBe(200);
      const data = fetched.body as {
        deps: { task_id: string; depends_on_task_id: string }[];
        tasks: { id: string; state: string }[];
      };
      expect(data.tasks.length).toBeGreaterThanOrEqual(2);
      // task B depends on A
      const taskA = data.tasks[0]!.id;
      const taskB = data.tasks[1]!.id;
      const bDeps = data.deps
        .filter((d) => d.task_id === taskB)
        .map((d) => d.depends_on_task_id);
      expect(bDeps).toContain(taskA);
      // second approve should also be 409
      const second = await http(
        env.port,
        "POST",
        `/scopes/${scopeId}/approve-plan`,
      );
      expect(second.status).toBe(409);
      expect((second.body as { error?: { code?: string } })?.error?.code).toBe(
        "NO_PLAN_PENDING",
      );
      return;
    }
    expect(first.status).toBe(200);
    const tasks = (first.body as { tasks: { id: string; state: string }[] })
      .tasks;
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    const depsRes = await http(env.port, "GET", `/scopes/${scopeId}`);
    const deps = (
      depsRes.body as {
        deps: { task_id: string; depends_on_task_id: string }[];
      }
    ).deps;
    const taskA = tasks[0]!.id;
    const taskB = tasks[1]!.id;
    const bDeps2 = deps
      .filter((d) => d.task_id === taskB)
      .map((d) => d.depends_on_task_id);
    expect(bDeps2).toContain(taskA);

    const second = await http(
      env.port,
      "POST",
      `/scopes/${scopeId}/approve-plan`,
    );
    expect(second.status).toBe(409);
    expect((second.body as { error?: { code?: string } })?.error?.code).toBe(
      "NO_PLAN_PENDING",
    );
  }, 90_000);

  it("Happy path to done with audit chain and merged MRs", async () => {
    const ok = await waitFor(
      "done",
      async () => {
        const res = await http(env.port, "GET", `/scopes/${scopeId}`);
        if (res.status !== 200) return false;
        const data = res.body as { scope: { status: string } };
        return data.scope.status === "done";
      },
      90_000,
      250,
    );
    expect(ok).toBe(true);
    const res = await http(env.port, "GET", `/scopes/${scopeId}`);
    expect(res.status).toBe(200);
    const data = res.body as {
      scope: { status: string };
      tasks: { id: string; state: string; mr_iid: number | null }[];
    };
    expect(data.scope.status).toBe("done");
    for (const t of data.tasks) expect(t.state).toBe("merged");

    // audit chain queued->running->mr_open->merged
    for (const t of data.tasks) {
      const audit = await http(
        env.port,
        "GET",
        `/audit?task_id=${encodeURIComponent(t.id)}&limit=1000`,
      );
      expect(audit.status).toBe(200);
      const rows = audit.body as {
        action: string;
        detail_json: string;
      }[];
      const hops = rows
        .filter((r) => r.action === "task.transition")
        .map((r) => JSON.parse(r.detail_json) as { from: string; to: string })
        .reverse();
      // We reverse because default order is DESC; restore ascending by id implicitly by reverse
      const chain = hops.map((h) => `${h.from}->${h.to}`);
      expect(chain).toEqual([
        "queued->running",
        "running->mr_open",
        "mr_open->merged",
      ]);
    }

    // MRs merged in fake provider
    for (const t of data.tasks) {
      const mr = await env.boundary.provider.mergeRequests.get(
        { id: env.projectId },
        `${env.projectId}:${t.mr_iid}`,
      );
      expect(mr.state).toBe("merged");
    }
  }, 90_000);

  it("Validation retry: parks in validating then revalidate → done", async () => {
    // Create a fresh scope to test validation retry
    const created = await http(env.port, "POST", "/scopes", {
      body: {
        goal: "validation retry goal",
        project: { path: "so/console-e2e" },
      },
    });
    expect(created.status).toBe(201);
    const newScopeId = (created.body as { id: string }).id;

    // Mark this scope to fail first validate
    env.boundary.script.validateFailFirstFor.add(newScopeId);

    // If yolo, need to allow planning → active automatically; otherwise approve
    await waitFor(
      "new planning",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${newScopeId}`);
        const d = r.body as {
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
      `/scopes/${newScopeId}/approve-plan`,
    );
    if (approve.status === 200) {
      // ok
    } else {
      // might have auto-materialized if yolo; ignore 409
      expect([200, 409]).toContain(approve.status);
    }

    const validating = await waitFor(
      "validating",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${newScopeId}`);
        const d = r.body as {
          scope: { status: string };
          runs: {
            kind: string;
            status: string;
            evidence_json: string | null;
          }[];
        };
        const hasFailedValidate = d.runs.some(
          (run) =>
            run.kind === "validate" &&
            run.status === "failed" &&
            (() => {
              try {
                return JSON.parse(run.evidence_json ?? "{}").passed === false;
              } catch {
                return false;
              }
            })(),
        );
        return d.scope.status === "validating" && hasFailedValidate;
      },
      90_000,
      250,
    );
    expect(validating).toBe(true);

    // Trigger revalidate
    const revalidate = await http(
      env.port,
      "POST",
      `/scopes/${newScopeId}/revalidate`,
    );
    expect(revalidate.status).toBe(200);
    expect((revalidate.body as { status: string }).status).toBe("validating");

    const done = await waitFor(
      "revalidated done",
      async () => {
        const r = await http(env.port, "GET", `/scopes/${newScopeId}`);
        const d = r.body as {
          scope: { status: string };
          runs: {
            kind: string;
            status: string;
            evidence_json: string | null;
          }[];
        };
        const hasPassed = d.runs.some((run) => {
          if (run.kind !== "validate" || run.status !== "succeeded")
            return false;
          try {
            return JSON.parse(run.evidence_json ?? "{}").passed === true;
          } catch {
            return false;
          }
        });
        return d.scope.status === "done" && hasPassed;
      },
      90_000,
      250,
    );
    expect(done).toBe(true);
  }, 90_000);

  it("Webhook with GITLAB_WEBHOOK_SECRET", async () => {
    // Need separate boot with secret set to test webhook
    const whEnv = await bootFake({ webhookSecret: "s3cret" });
    try {
      // no token -> 401
      const noToken = await httpRaw(
        whEnv.port,
        "POST",
        "/webhook/gitlab",
        JSON.stringify({ hello: "world" }),
        { "content-type": "application/json" },
      );
      expect(noToken.status).toBe(401);
      expect((noToken.body as { error?: { code?: string } })?.error?.code).toBe(
        "BAD_SIGNATURE",
      );

      const wrong = await httpRaw(
        whEnv.port,
        "POST",
        "/webhook/gitlab",
        JSON.stringify({ hello: "world" }),
        {
          "content-type": "application/json",
          "X-Gitlab-Token": "wrong",
        },
      );
      expect(wrong.status).toBe(401);

      const body = JSON.stringify({ hello: "world", id: 1 });
      const ok = await httpRaw(whEnv.port, "POST", "/webhook/gitlab", body, {
        "content-type": "application/json",
        "X-Gitlab-Token": "s3cret",
        "X-Gitlab-Event-UUID": "test-uuid-123",
      });
      expect(ok.status).toBe(200);
      expect((ok.body as { accepted?: boolean })?.accepted).toBe(true);

      const dup = await httpRaw(whEnv.port, "POST", "/webhook/gitlab", body, {
        "content-type": "application/json",
        "X-Gitlab-Token": "s3cret",
        "X-Gitlab-Event-UUID": "test-uuid-123",
      });
      expect(dup.status).toBe(200);
      expect((dup.body as { duplicate?: boolean })?.duplicate).toBe(true);
    } finally {
      await whEnv.cleanup();
    }
  }, 90_000);
});
