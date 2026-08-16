import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { DomainStateError } from "@colony/domain";
import { ArchitectDecompositionV2 as architectDecompositionV2Schema } from "@colony/schemas";
import type { ColonydContext } from "./context.js";
import { abortRuns } from "./runs/registry.js";

const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
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
    }),
  );

  app.get("/", (c) => uiResponse("index.html") ?? c.notFound());
  app.get("/ui/*", (c) => {
    const rel = c.req.path.replace(/^\/ui\/?/, "");
    if (!rel || rel === "config") return c.notFound();
    return uiResponse(rel) ?? c.notFound();
  });

  // Actor middleware for every remaining route.
  app.use(async (c, next) => {
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
