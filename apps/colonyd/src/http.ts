import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { createRequire } from "node:module";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { DomainStateError } from "@colony/domain";
import { ArchitectDecompositionV2 as architectDecompositionV2Schema } from "@colony/schemas";
import type { ColonydContext } from "./context.js";
import { createOidcVerifier } from "./oidc.js";
import { abortRuns, abortRunsAndWait } from "./runs/registry.js";

const UI_DIR = dirname(
  createRequire(import.meta.url).resolve("@colony/console/package.json"),
);
const UI_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

type Env = { Variables: { actor: string } };

const createScopeBody = z
  .object({
    goal: z.string().min(1),
    title: z.string().min(1).max(120).optional(),
    approvals: z.enum(["auto", "manual"]).optional(),
    project: z
      .object({
        id: z.string().min(1).optional(),
        path: z.string().min(1).optional(),
      })
      .strict()
      .refine((p) => p.id || p.path, {
        message: "project.id or project.path required",
      }),
  })
  .strict();

const feedbackBody = z
  .object({ feedback: z.string().min(1).max(4000) })
  .strict();

const auditQuery = z.object({
  scope_id: z.string().optional(),
  task_id: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

export function buildApp(ctx: ColonydContext): Hono<Env> {
  const app = new Hono<Env>();

  app.get("/health", (c) => c.json({ ok: true, service: "colonyd" }));

  // Webhook intake — no actor required; secret-checked.
  app.post("/webhook/gitlab", async (c) => {
    const secret = ctx.env.webhookSecret;
    if (!secret) return c.json({ error: { code: "NOT_FOUND" } }, 404);
    const body = await c.req.text();
    const provided = c.req.header("X-Gitlab-Token") ?? "";
    if (!safeEqual(provided, secret)) {
      return c.json({ error: { code: "BAD_SIGNATURE" } }, 401);
    }
    const dedupKey =
      c.req.header("X-Gitlab-Event-UUID") ??
      `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const fresh = ctx.store.recordObservation("webhook", dedupKey, body);
    if (fresh) ctx.requestTick();
    return c.json(fresh ? { accepted: true } : { duplicate: true });
  });

  app.get("/ui/config", (c) =>
    c.json({
      service: "colonyd",
      gitlab_base_url: ctx.env.gitlabBaseUrl,
      review_mode: ctx.config.reviewMode,
      hitl_mode: ctx.config.hitlMode,
      oidc: ctx.env.oidcIssuer
        ? { issuer: ctx.env.oidcIssuer, client_id: ctx.env.oidcClientId }
        : null,
    }),
  );

  app.get("/", (c) => uiResponse("index.html") ?? c.notFound());
  app.get("/ui/*", (c) => {
    const rel = c.req.path.replace(/^\/ui\/?/, "");
    if (!rel || rel === "config") return c.notFound();
    return uiResponse(rel) ?? c.notFound();
  });

  // Actor middleware for every remaining route. With OIDC configured the
  // actor is the verified Keycloak identity; otherwise (local dev, fake
  // provider) the caller self-declares via X-Actor-Id.
  const verifier =
    ctx.oidcVerifier ??
    (ctx.env.oidcIssuer
      ? createOidcVerifier({
          issuer: ctx.env.oidcIssuer,
          clientId: ctx.env.oidcClientId,
          requiredRole: ctx.env.oidcRequiredRole || undefined,
        })
      : undefined);
  app.use(async (c, next) => {
    if (verifier) {
      const auth = c.req.header("Authorization") ?? "";
      if (!auth.startsWith("Bearer ")) {
        return c.json(
          {
            error: {
              code: "UNAUTHORIZED",
              message: "Bearer token required",
            },
          },
          401,
        );
      }
      try {
        const identity = await verifier.verify(auth.slice(7));
        c.set("actor", `human:${identity.username}`);
      } catch (err) {
        return c.json(
          {
            error: {
              code: "UNAUTHORIZED",
              message: err instanceof Error ? err.message : "invalid token",
            },
          },
          401,
        );
      }
      await next();
      return;
    }
    const id = c.req.header("X-Actor-Id");
    if (!id || !id.trim()) {
      return c.json(
        {
          error: {
            code: "MISSING_ACTOR",
            message: "X-Actor-Id header is required",
          },
        },
        400,
      );
    }
    c.set("actor", id.trim());
    await next();
  });

  app.post("/scopes", async (c) => {
    const parsed = createScopeBody.safeParse(await parseBody(c));
    if (!parsed.success) return badBody(c, parsed.error.message);

    const projectRef = parsed.data.project;
    const project = projectRef.id
      ? await ctx.provider.projects.getById(projectRef.id)
      : await ctx.provider.projects.getByPath(projectRef.path!);
    if (!project) {
      return c.json({ error: { code: "PROJECT_NOT_FOUND" } }, 404);
    }
    const scope = ctx.store.createScope({
      goal: parsed.data.goal,
      title: parsed.data.title,
      approvals: parsed.data.approvals,
      provider_project_id: project.id,
      provider_project_path: project.path,
      default_branch: project.default_branch || "main",
    });
    ctx.store.audit(c.get("actor"), "scope.created", {
      scope_id: scope.id,
      detail: { goal: scope.goal, project: project.path },
    });
    ctx.requestTick();
    return c.json(scope, 201);
  });

  app.get("/scopes", (c) => c.json(ctx.store.listScopes()));

  app.get("/scopes/:id", (c) => {
    const scope = ctx.store.getScope(c.req.param("id"));
    if (!scope) return notFound(c, "scope");
    return c.json({
      scope,
      tasks: ctx.store.listTasks(scope.id),
      deps: ctx.store.scopeDeps(scope.id),
      runs: ctx.store.runsForScope(scope.id),
    });
  });

  app.post("/scopes/:id/approve-plan", (c) => {
    const scope = ctx.store.getScope(c.req.param("id"));
    if (!scope) return notFound(c, "scope");
    if (scope.status !== "planning" || !scope.plan_json) {
      return c.json(
        {
          error: {
            code: "NO_PLAN_PENDING",
            message: "scope has no plan awaiting approval",
          },
        },
        409,
      );
    }
    let plan: z.infer<typeof architectDecompositionV2Schema>;
    try {
      plan = architectDecompositionV2Schema.parse(JSON.parse(scope.plan_json));
    } catch (err) {
      return c.json(
        {
          error: {
            code: "INVALID_PLAN",
            message: err instanceof Error ? err.message : String(err),
          },
        },
        409,
      );
    }
    try {
      const tasks = ctx.store.materializePlan(scope.id, plan, c.get("actor"));
      ctx.requestTick();
      return c.json({ scope: ctx.store.getScope(scope.id), tasks }, 200);
    } catch (err) {
      return conflict(c, err);
    }
  });

  // Reject the proposed plan with feedback; the architect re-plans with the
  // feedback in its packet.
  app.post("/scopes/:id/replan", async (c) => {
    const scope = ctx.store.getScope(c.req.param("id"));
    if (!scope) return notFound(c, "scope");
    if (scope.status !== "planning" || !scope.plan_json) {
      return c.json(
        {
          error: {
            code: "NO_PLAN_PENDING",
            message: "scope has no plan awaiting approval",
          },
        },
        409,
      );
    }
    const parsed = feedbackBody.safeParse(await parseBody(c));
    if (!parsed.success) return badBody(c, parsed.error.message);
    const updated = ctx.store.requestReplan(scope.id, parsed.data.feedback);
    ctx.store.audit(c.get("actor"), "plan.replan_requested", {
      scope_id: scope.id,
      detail: { feedback: parsed.data.feedback },
    });
    ctx.requestTick();
    return c.json(updated);
  });

  app.post("/scopes/:id/abandon", async (c) => {
    const scope = ctx.store.getScope(c.req.param("id"));
    if (!scope) return notFound(c, "scope");
    try {
      ctx.store.setScopeStatus(scope.id, "abandoned", c.get("actor"));
    } catch (err) {
      return conflict(c, err);
    }
    // Cancel every nonterminal task and abort their in-process runs.
    const runIds: string[] = [];
    for (const task of ctx.store.listTasks(scope.id)) {
      if (task.state === "merged" || task.state === "canceled") continue;
      ctx.store.transitionTask(
        task.id,
        task.state_version,
        "canceled",
        c.get("actor"),
      );
      for (const run of ctx.store.runsForTask(task.id)) {
        if (run.status === "running") runIds.push(run.id);
      }
    }
    for (const run of ctx.store.activeRuns("architect")) {
      if (run.scope_id === scope.id) runIds.push(run.id);
    }
    await abortRuns(runIds);
    return c.json(ctx.store.getScope(scope.id));
  });

  app.get("/tasks/:id", (c) => {
    const task = ctx.store.getTask(c.req.param("id"));
    if (!task) return notFound(c, "task");
    return c.json({
      task,
      runs: ctx.store.runsForTask(task.id),
      deps: ctx.store.taskDeps(task.id),
    });
  });

  app.post("/tasks/:id/stop", async (c) => {
    const task = ctx.store.getTask(c.req.param("id"));
    if (!task) return notFound(c, "task");
    if (task.state !== "running") {
      return c.json(
        {
          error: {
            code: "NOT_RUNNING",
            message: "only a running task can be stopped and retried",
          },
        },
        409,
      );
    }
    const runIds = ctx.store
      .runsForTask(task.id)
      .filter((run) => run.status === "running")
      .map((run) => run.id);
    if (runIds.length === 0) {
      return c.json(
        {
          error: {
            code: "NO_ACTIVE_RUN",
            message: "task has no active run to stop",
          },
        },
        409,
      );
    }
    const stopped = await abortRunsAndWait(runIds);
    if (!stopped.every(Boolean)) {
      return c.json(
        {
          error: {
            code: "RUN_NOT_LOCAL",
            message: "active run is not owned by this colonyd process",
          },
        },
        409,
      );
    }
    const current = ctx.store.getTask(task.id);
    if (!current || current.state !== "running") {
      return conflict(
        c,
        new Error("task state changed while its active run was stopping"),
      );
    }
    try {
      const updated = ctx.store.transitionTask(
        current.id,
        current.state_version,
        "queued",
        c.get("actor"),
        {
          attempt: task.attempt,
          next_retry_at: null,
          blocked_reason: null,
        },
      );
      ctx.store.audit(c.get("actor"), "task.stop_and_retry", {
        scope_id: task.scope_id,
        task_id: task.id,
        detail: { run_ids: runIds },
      });
      ctx.requestTick();
      return c.json(updated);
    } catch (err) {
      return conflict(c, err);
    }
  });

  app.post("/tasks/:id/cancel", async (c) => {
    const task = ctx.store.getTask(c.req.param("id"));
    if (!task) return notFound(c, "task");
    try {
      ctx.store.transitionTask(
        task.id,
        task.state_version,
        "canceled",
        c.get("actor"),
      );
    } catch (err) {
      return conflict(c, err);
    }
    const runIds = ctx.store
      .runsForTask(task.id)
      .filter((r) => r.status === "running")
      .map((r) => r.id);
    await abortRuns(runIds);
    return c.json(ctx.store.getTask(task.id));
  });

  app.post("/tasks/:id/restore", (c) => {
    const task = ctx.store.getTask(c.req.param("id"));
    if (!task) return notFound(c, "task");
    if (task.state !== "canceled") {
      return c.json(
        {
          error: {
            code: "NOT_CANCELED",
            message: "only a canceled task can be restored",
          },
        },
        409,
      );
    }
    const scope = ctx.store.getScope(task.scope_id);
    if (!scope) return notFound(c, "scope");
    if (scope.status === "abandoned") {
      return c.json(
        {
          error: {
            code: "SCOPE_ABANDONED",
            message: "tasks in an abandoned scope cannot be restored",
          },
        },
        409,
      );
    }
    try {
      const updated = ctx.store.transitionTask(
        task.id,
        task.state_version,
        "queued",
        c.get("actor"),
        {
          attempt: 0,
          next_retry_at: null,
          blocked_reason: null,
        },
      );
      if (scope.status === "done" || scope.status === "blocked") {
        ctx.store.setScopeStatus(scope.id, "active", c.get("actor"), {
          reason: "canceled_task_restored",
          task_id: task.id,
        });
      }
      ctx.store.audit(c.get("actor"), "task.restored", {
        scope_id: task.scope_id,
        task_id: task.id,
      });
      ctx.requestTick();
      return c.json(updated);
    } catch (err) {
      return conflict(c, err);
    }
  });

  app.post("/tasks/:id/unblock", (c) => {
    const task = ctx.store.getTask(c.req.param("id"));
    if (!task) return notFound(c, "task");
    try {
      const updated = ctx.store.transitionTask(
        task.id,
        task.state_version,
        "queued",
        c.get("actor"),
        { attempt: 0, next_retry_at: null },
      );
      ctx.requestTick();
      return c.json(updated);
    } catch (err) {
      return conflict(c, err);
    }
  });

  app.post("/tasks/:id/retry", (c) => {
    const task = ctx.store.getTask(c.req.param("id"));
    if (!task) return notFound(c, "task");
    if (task.state !== "queued") {
      return c.json(
        {
          error: {
            code: "NOT_QUEUED",
            message: "only queued tasks can retry immediately",
          },
        },
        409,
      );
    }
    ctx.store.clearRetryDelay(task.id);
    ctx.store.audit(c.get("actor"), "task.retry", {
      scope_id: task.scope_id,
      task_id: task.id,
    });
    ctx.requestTick();
    return c.json(ctx.store.getTask(task.id));
  });

  // Operator feedback on an open MR: requeue the implementer with the
  // feedback in its packet. The branch and MR stay; the agent continues.
  app.post("/tasks/:id/request-changes", async (c) => {
    const task = ctx.store.getTask(c.req.param("id"));
    if (!task) return notFound(c, "task");
    if (task.state !== "mr_open") {
      return c.json(
        {
          error: {
            code: "NO_OPEN_MR",
            message: "task has no open merge request",
          },
        },
        409,
      );
    }
    const parsed = feedbackBody.safeParse(await parseBody(c));
    if (!parsed.success) return badBody(c, parsed.error.message);
    ctx.store.setTaskFeedback(task.id, parsed.data.feedback);
    try {
      const updated = ctx.store.transitionTask(
        task.id,
        task.state_version,
        "queued",
        c.get("actor"),
        { attempt: task.attempt + 1, next_retry_at: null },
      );
      ctx.store.audit(c.get("actor"), "task.changes_requested", {
        scope_id: task.scope_id,
        task_id: task.id,
        detail: { feedback: parsed.data.feedback },
      });
      ctx.requestTick();
      return c.json(updated);
    } catch (err) {
      return conflict(c, err);
    }
  });

  // Manual-approvals scopes: record human approval to merge at the MR's
  // current head SHA. The tick loop dispatches the gate once the approved
  // SHA matches the head it observes.
  app.post("/tasks/:id/approve-merge", async (c) => {
    const task = ctx.store.getTask(c.req.param("id"));
    if (!task) return notFound(c, "task");
    const scope = ctx.store.getScope(task.scope_id);
    if (!scope) return notFound(c, "scope");
    if (scope.approvals !== "manual") {
      return c.json(
        {
          error: {
            code: "AUTO_MERGE_SCOPE",
            message: "scope merges automatically; nothing to approve",
          },
        },
        409,
      );
    }
    if (task.state !== "mr_open" || !task.mr_iid) {
      return c.json(
        {
          error: {
            code: "NO_OPEN_MR",
            message: "task has no open merge request",
          },
        },
        409,
      );
    }
    let mr;
    try {
      mr = await ctx.provider.mergeRequests.get(
        { id: scope.provider_project_id, path: scope.provider_project_path },
        `${scope.provider_project_id}:${task.mr_iid}`,
      );
    } catch {
      return c.json(
        {
          error: {
            code: "PROVIDER_UNREACHABLE",
            message: "could not read the merge request head",
          },
        },
        502,
      );
    }
    if (!mr.head_commit_sha) {
      return c.json(
        { error: { code: "NO_HEAD_SHA", message: "MR has no head commit" } },
        409,
      );
    }
    const updated = ctx.store.approveMerge(task.id, mr.head_commit_sha);
    ctx.store.audit(c.get("actor"), "merge.approved", {
      scope_id: scope.id,
      task_id: task.id,
      detail: { head_sha: mr.head_commit_sha },
    });
    ctx.requestTick();
    return c.json(updated);
  });

  app.get("/runs/:id/events", (c) => {
    const run = ctx.store.getRun(c.req.param("id"));
    if (!run) return notFound(c, "run");
    return c.json(ctx.store.listRunEvents(run.id));
  });

  app.get("/audit", (c) => {
    const parsed = auditQuery.safeParse({
      scope_id: c.req.query("scope_id"),
      task_id: c.req.query("task_id"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) return badBody(c, parsed.error.message);
    return c.json(ctx.store.listAudit(parsed.data));
  });

  app.onError((err, c) => {
    if (err instanceof DomainStateError) return conflict(c, err);
    ctx.logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "http.error",
    );
    return c.json(
      { error: { code: "INTERNAL", message: "internal error" } },
      500,
    );
  });

  return app;
}

async function parseBody(c: Context<Env>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function badBody(c: Context<Env>, message: string) {
  return c.json({ error: { code: "INVALID_BODY", message } }, 400);
}

function notFound(c: Context<Env>, kind: string) {
  return c.json(
    { error: { code: "NOT_FOUND", message: `${kind} not found` } },
    404,
  );
}

function conflict(c: Context<Env>, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: { code: "CONFLICT", message } }, 409);
}

function uiResponse(relPath: string): Response | null {
  const rel = decodeURIComponent(relPath).replace(/^\/+/, "");
  if (!rel || rel.includes("\0") || rel.split(/[\\/]/).includes("..")) {
    return null;
  }
  const full = normalize(join(UI_DIR, rel));
  const root = normalize(join(UI_DIR, "."));
  if (full !== root && !full.startsWith(root + sep)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  const mime = UI_MIME[extname(full)] ?? "application/octet-stream";
  const cache =
    extname(full) === ".woff2"
      ? "public, max-age=31536000, immutable"
      : "no-cache";
  return new Response(readFileSync(full), {
    headers: {
      "content-type": mime,
      "cache-control": cache,
      "x-content-type-options": "nosniff",
    },
  });
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
