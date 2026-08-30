import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, extname, join, normalize, sep } from "node:path";
import { createRequire } from "node:module";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { DomainStateError } from "@colony/domain";
import {
  isTracingEnabled,
  normalizeRoute,
  startHttpServerSpan,
  startWebhookSpan,
} from "@colony/observability";
import { ArchitectDecompositionV2 as architectDecompositionV2Schema } from "@colony/schemas";
import type { Store } from "@colony/core";
import type { ColonydContext } from "./context.js";
import { createOidcVerifier } from "./oidc.js";
import { abortRuns, abortRunsAndWait } from "./runs/registry.js";
import { runValidation } from "./runs/validate.js";

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

/** Compressed variants of UI text assets, keyed by absolute file path;
 *  each entry records the (mtimeMs, size) it was compressed from so an
 *  edited file recompresses instead of serving stale bytes. */
export const uiGzipCache = new Map<
  string,
  { mtimeMs: number; size: number; compressed: Buffer }
>();

const GZIPPABLE_UI_EXTS: Record<string, true> = {
  ".js": true,
  ".css": true,
  ".html": true,
  ".svg": true,
};

type Env = { Variables: { actor: string } };

const createScopeBody = z
  .object({
    goal: z.string().min(1),
    title: z.string().min(1).max(120).optional(),
    /** Name of the (created-on-demand) Colony project this scope belongs to. */
    project: z.string().min(1).max(120).optional(),
    approvals: z.enum(["auto", "manual"]).optional(),
    repo: z
      .object({
        id: z.string().min(1).optional(),
        path: z.string().min(1).optional(),
      })
      .strict()
      .refine((r) => r.id || r.path, {
        message: "repo.id or repo.path required",
      }),
  })
  .strict();

const feedbackBody = z
  .object({ feedback: z.string().min(1).max(4000) })
  .strict();

const acceptanceBody = z
  .object({
    acceptance: z
      .array(
        z
          .object({
            description: z.string().min(1).max(2000),
            command: z.string().min(1).max(4000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

const auditQuery = z.object({
  scope_id: z.string().optional(),
  task_id: z.string().optional(),
  run_id: z.string().optional(),
  before_id: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const runEventsQuery = z.object({
  before_id: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const runArtifactsQuery = z.object({
  limit: z.coerce.number().int().positive().max(1000).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const scopesQuery = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  project: z.string().min(1).max(120).optional(),
});

const projectsQuery = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

/** Operator-authored background; `null` clears it. Strict: no extra keys. */
const contextBody = z
  .object({ context_doc: z.string().max(100_000).nullable() })
  .strict();

// ---------------------------------------------------------------------------
// Project file validation constants
// ---------------------------------------------------------------------------

const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/;
const RESERVED_NAMES = ["packet.json", ".colony", ".git", ".env"];
const MAX_FILE_BYTES = 262144;
const MAX_PROJECT_FILE_BYTES = 2097152;

/** Validate a file name against path-name and reserved-name rules. Returns an error message or null. */
function validateFilename(name: string): string | null {
  if (!FILENAME_RE.test(name)) return `filename invalid: ${name}`;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return `filename invalid: ${name}`;
  }
  if (name === "." || name === "..") return `filename invalid: ${name}`;
  const lower = name.toLowerCase();
  if (RESERVED_NAMES.some((r) => r === lower)) {
    return `filename invalid: ${name}`;
  }
  return null;
}

/** Validate UTF-8: reject content that round-trips to a different string. */
function isValidUtf8(content: string): boolean {
  const decoded = Buffer.from(content, "utf8").toString("utf8");
  if (decoded !== content) return false;
  // Lone surrogates survive the Buffer round-trip but not TextEncoder's
  // replacement policy; reject any content whose encoded length differs.
  const encoded = new TextEncoder().encode(content);
  return Buffer.byteLength(content, "utf8") === encoded.length;
}

/** Total bytes of a project's reference files (0 when none). */
function totalProjectFileBytes(store: Store, projectName: string): number {
  const row = store.db
    .prepare(
      `SELECT COALESCE(SUM(byte_size),0) AS bytes FROM project_files WHERE project_name = ?`,
    )
    .get(projectName) as { bytes: number };
  return row.bytes;
}

/** Schema for project file creation/update body. */
const createFileBody = z
  .object({
    filename: z.string(),
    media_type: z.enum(["text/plain", "text/markdown"]),
    content: z.string(),
  })
  .strict();

const updateFileBody = z
  .object({
    media_type: z.enum(["text/plain", "text/markdown"]),
    content: z.string(),
  })
  .strict();

const fileListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export function buildApp(ctx: ColonydContext): Hono<Env> {
  const app = new Hono<Env>();

  // Control-plane tracing: one server span per request. /health and static
  // /ui/* assets are the only exclusions — everything else, including /
  // (console shell), /ui/config, the webhook route and all API routes, is
  // traced. Registered first so no handler runs outside a span.
  app.use(async (c, next) => {
    if (!isTracingEnabled() || isExcludedFromHttpSpans(c.req.path)) {
      await next();
      return;
    }
    const endSpan = startHttpServerSpan(
      c.req.method,
      normalizeRoute(c.req.path),
    );
    if (!endSpan) {
      // Unreachable while isTracingEnabled() holds; keeps narrowing honest.
      await next();
      return;
    }
    try {
      await next();
      endSpan(c.res.status);
    } catch (err) {
      endSpan(500);
      throw err;
    }
  });

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
    // Always sampled by the observability sampler; ended even on duplicate
    // intake so every webhook delivery is recorded.
    const endWebhookSpan = startWebhookSpan(
      c.req.header("X-Gitlab-Event") ?? "",
    );
    try {
      const dedupKey =
        c.req.header("X-Gitlab-Event-UUID") ??
        `sha256:${createHash("sha256").update(body).digest("hex")}`;
      const fresh = ctx.store.recordObservation("webhook", dedupKey, body);
      if (fresh) ctx.requestTick();
      return c.json(fresh ? { accepted: true } : { duplicate: true });
    } finally {
      endWebhookSpan();
    }
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
      trace_ui_base_url: ctx.env.traceUiBaseUrl || null,
    }),
  );

  app.get("/", (c) => uiResponse("index.html", acceptsGzip(c)) ?? c.notFound());
  app.get("/ui/*", (c) => {
    const rel = c.req.path.replace(/^\/ui\/?/, "");
    if (!rel || rel === "config") return c.notFound();
    return uiResponse(rel, acceptsGzip(c)) ?? c.notFound();
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
        // Keycloak service accounts get preferred_username
        // "service-account-<client_id>"; ledger them as svc:, not human:.
        c.set(
          "actor",
          identity.username.startsWith("service-account-")
            ? `svc:${identity.username.slice("service-account-".length)}`
            : `human:${identity.username}`,
        );
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

    const repoRef = parsed.data.repo;
    const repo = repoRef.id
      ? await ctx.provider.repos.getById(repoRef.id)
      : await ctx.provider.repos.getByPath(repoRef.path!);
    if (!repo) {
      return c.json({ error: { code: "REPO_NOT_FOUND" } }, 404);
    }
    const scope = ctx.store.createScope({
      goal: parsed.data.goal,
      title: parsed.data.title,
      project: parsed.data.project,
      approvals: parsed.data.approvals,
      provider_repo_id: repo.id,
      provider_repo_path: repo.path,
      default_branch: repo.default_branch || "main",
    });
    ctx.store.audit(c.get("actor"), "scope.created", {
      scope_id: scope.id,
      detail: {
        goal: scope.goal,
        repo: repo.path,
        project: parsed.data.project ?? null,
      },
    });
    ctx.requestTick();
    return c.json(scope, 201);
  });

  app.get("/scopes", (c) => {
    const parsed = scopesQuery.safeParse(c.req.query());
    if (!parsed.success) return badBody(c, parsed.error.message);
    const limit = parsed.data.limit ?? 25;
    const offset = parsed.data.offset ?? 0;
    const { scopes, total, projects } = ctx.store.pageScopes(
      limit,
      offset,
      parsed.data.project,
    );
    return c.json({ scopes, total, limit, offset, projects });
  });

  app.get("/projects", (c) => {
    const parsed = projectsQuery.safeParse(c.req.query());
    if (!parsed.success) return badBody(c, parsed.error.message);
    const limit = parsed.data.limit ?? 25;
    const offset = parsed.data.offset ?? 0;
    const { projects, total } = ctx.store.pageProjects(limit, offset);
    return c.json({ projects, total, limit, offset });
  });

  app.post("/projects", async (c) => {
    const parsed = z
      .object({
        name: z.string().min(1).max(120),
        context_doc: z.string().max(100_000).nullable().optional(),
      })
      .strict()
      .safeParse(await parseBody(c));
    if (!parsed.success) return badBody(c, parsed.error.message);
    try {
      const project = ctx.store.createProject({
        name: parsed.data.name,
        context_doc: parsed.data.context_doc ?? null,
      });
      ctx.store.audit(c.get("actor"), "project.created", {
        detail: { project: parsed.data.name },
      });
      return c.json({ project }, 201);
    } catch (err) {
      return conflict(c, err);
    }
  });

  app.get("/projects/:name", (c) => {
    const project = ctx.store.getProject(c.req.param("name"));
    if (!project) return notFound(c, "project");
    return c.json({ project });
  });

  app.get("/projects/:name/context", (c) => {
    const project = ctx.store.getProject(c.req.param("name"));
    if (!project) return notFound(c, "project");
    return c.json({ context_doc: project.context_doc });
  });

  // Writing context for an unknown project creates that project (same
  // auto-create rule as scope creation), so operators can pre-seed
  // background before opening scopes. Every write lands an audit row.
  app.put("/projects/:name/context", async (c) => {
    const name = c.req.param("name");
    const parsed = contextBody.safeParse(await parseBody(c));
    if (!parsed.success) return badBody(c, parsed.error.message);
    ctx.store.ensureProject(name);
    const project = ctx.store.setProjectContext(name, parsed.data.context_doc);
    ctx.store.audit(c.get("actor"), "project.context_updated", {
      detail: {
        name,
        bytes:
          project.context_doc === null
            ? 0
            : Buffer.byteLength(project.context_doc),
      },
    });
    return c.json({ project });
  });

  // -------------------------------------------------------------------
  // Project reference files
  // -------------------------------------------------------------------

  app.get("/projects/:name/files", (c) => {
    const parsed = fileListQuery.safeParse(c.req.query());
    if (!parsed.success) return badBody(c, parsed.error.message);
    const project = ctx.store.getProject(c.req.param("name"));
    if (!project) return notFound(c, "project");
    const { files, total } = ctx.store.pageProjectFiles(
      project.name,
      parsed.data.limit,
      parsed.data.offset,
    );
    return c.json({
      files,
      total,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
  });

  app.post("/projects/:name/files", async (c) => {
    const name = c.req.param("name");
    const parsed = createFileBody.safeParse(await parseBody(c));
    if (!parsed.success) return badBody(c, parsed.error.message);
    const project = ctx.store.getProject(name);
    if (!project) return notFound(c, "project");
    const filenameError = validateFilename(parsed.data.filename);
    if (filenameError) return badBody(c, filenameError);
    if (!isValidUtf8(parsed.data.content)) {
      return badBody(c, "content is not valid UTF-8");
    }
    const contentBytes = Buffer.byteLength(parsed.data.content);
    if (contentBytes > MAX_FILE_BYTES) {
      return badBody(c, `content exceeds ${MAX_FILE_BYTES} bytes`);
    }
    const existing = totalProjectFileBytes(ctx.store, name);
    if (existing + contentBytes > MAX_PROJECT_FILE_BYTES) {
      return badBody(
        c,
        `project files exceed ${MAX_PROJECT_FILE_BYTES} bytes in total`,
      );
    }
    try {
      const file = ctx.store.createProjectFile({
        project_name: name,
        filename: parsed.data.filename,
        media_type: parsed.data.media_type,
        content: parsed.data.content,
      });
      ctx.store.audit(c.get("actor"), "project.file_created", {
        detail: {
          project: name,
          filename: file.filename,
          byte_size: file.byte_size,
          sha256: file.sha256,
        },
      });
      return c.json(file, 201);
    } catch (err) {
      return conflict(c, err);
    }
  });

  app.put("/projects/:name/files/:id", async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const parsed = updateFileBody.safeParse(await parseBody(c));
    if (!parsed.success) return badBody(c, parsed.error.message);
    const project = ctx.store.getProject(name);
    if (!project) return notFound(c, "project");
    if (!isValidUtf8(parsed.data.content)) {
      return badBody(c, "content is not valid UTF-8");
    }
    const contentBytes = Buffer.byteLength(parsed.data.content);
    if (contentBytes > MAX_FILE_BYTES) {
      return badBody(c, `content exceeds ${MAX_FILE_BYTES} bytes`);
    }
    const existing = ctx.store.db
      .prepare(
        `SELECT byte_size FROM project_files WHERE id = ? AND project_name = ?`,
      )
      .get(id, name) as { byte_size: number } | undefined;
    if (!existing) return notFound(c, "file");
    const otherBytes =
      totalProjectFileBytes(ctx.store, name) - existing.byte_size;
    if (otherBytes + contentBytes > MAX_PROJECT_FILE_BYTES) {
      return badBody(
        c,
        `project files exceed ${MAX_PROJECT_FILE_BYTES} bytes in total`,
      );
    }
    const file = ctx.store.replaceProjectFile(name, id, {
      media_type: parsed.data.media_type,
      content: parsed.data.content,
    });
    if (!file) return notFound(c, "file");
    ctx.store.audit(c.get("actor"), "project.file_replaced", {
      detail: {
        project: name,
        filename: file.filename,
        byte_size: file.byte_size,
        sha256: file.sha256,
      },
    });
    return c.json(file);
  });

  app.delete("/projects/:name/files/:id", (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const project = ctx.store.getProject(name);
    if (!project) return notFound(c, "project");
    const file = ctx.store.db
      .prepare(`SELECT * FROM project_files WHERE id = ? AND project_name = ?`)
      .get(id, name) as
      | {
          id: string;
          filename: string;
          byte_size: number;
          sha256: string;
        }
      | undefined;
    if (!file) return notFound(c, "file");
    ctx.store.deleteProjectFile(name, id);
    ctx.store.audit(c.get("actor"), "project.file_deleted", {
      detail: {
        project: name,
        filename: file.filename,
        byte_size: file.byte_size,
        sha256: file.sha256,
      },
    });
    return c.json({ ok: true });
  });

  app.get("/scopes/:id", (c) => {
    const scope = ctx.store.getScope(c.req.param("id"));
    if (!scope) return notFound(c, "scope");
    return c.json({
      scope,
      project: scope.project_name
        ? (ctx.store.getProject(scope.project_name) ?? null)
        : null,
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

  // Operator acceptance amendment: the criteria were authored at scope
  // creation and the factory may migrate the world underneath them (runtime
  // swaps, substrate changes). Editing them must be an audited API action,
  // never DB surgery. Allowed while the scope can still be validated.
  app.patch("/scopes/:id/acceptance", async (c) => {
    const scope = ctx.store.getScope(c.req.param("id"));
    if (!scope) return notFound(c, "scope");
    if (["done", "abandoned"].includes(scope.status)) {
      return c.json(
        {
          error: {
            code: "SCOPE_FINISHED",
            message: "cannot amend acceptance on a finished scope",
          },
        },
        409,
      );
    }
    const parsed = acceptanceBody.safeParse(await parseBody(c));
    if (!parsed.success) return badBody(c, parsed.error.message);
    const updated = ctx.store.setScopeAcceptance(
      scope.id,
      parsed.data.acceptance,
    );
    ctx.store.audit(c.get("actor"), "scope.acceptance_amended", {
      scope_id: scope.id,
      detail: { criteria_count: parsed.data.acceptance.length },
    });
    return c.json({ scope: updated });
  });

  app.post("/scopes/:id/revalidate", (c) => {
    const scope = ctx.store.getScope(c.req.param("id"));
    if (!scope) return notFound(c, "scope");
    if (scope.status !== "validating") {
      return c.json(
        {
          error: {
            code: "NOT_VALIDATING",
            message: "scope is not awaiting validation",
          },
        },
        409,
      );
    }
    const actor = c.get("actor");
    ctx.store.audit(actor, "scope.revalidate_requested", {
      scope_id: scope.id,
      detail: { actor },
    });
    // Operator's path to retry validation: only dispatch when no validate run
    // is currently active so two validations never race in one scope.
    const runningValidate = ctx.store
      .activeRuns("validate")
      .some((r) => r.scope_id === scope.id);
    if (!runningValidate) {
      void runValidation(ctx, ctx.store.getScope(scope.id)!);
    }
    ctx.requestTick();
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
    const scope = ctx.store.getScope(task.scope_id);
    if (scope?.status === "abandoned") {
      return c.json(
        {
          error: {
            code: "SCOPE_ABANDONED",
            message: "tasks in an abandoned scope cannot be canceled",
          },
        },
        409,
      );
    }
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
      if (
        scope.status === "done" ||
        scope.status === "blocked" ||
        scope.status === "validating"
      ) {
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
      // Unblocking the last blocked task reactivates a scope that parked
      // itself on "no runnable tasks".
      const scope = ctx.store.getScope(task.scope_id);
      if (
        scope?.status === "blocked" &&
        !ctx.store.listTasks(scope.id).some((t) => t.state === "blocked")
      ) {
        ctx.store.setScopeStatus(scope.id, "active", c.get("actor"), {
          note: "last blocked task unblocked",
        });
      }
      ctx.requestTick();
      return c.json(updated);
    } catch (err) {
      return conflict(c, err);
    }
  });

  // Operator spec amendment: appended to the shared task spec so every role
  // (implementer, reviewer) reads the same authoritative requirements. An
  // open MR is requeued so the implementer acts on the amendment.
  app.post("/tasks/:id/amend-spec", async (c) => {
    const task = ctx.store.getTask(c.req.param("id"));
    if (!task) return notFound(c, "task");
    if (["merged", "canceled"].includes(task.state)) {
      return c.json(
        {
          error: {
            code: "TASK_FINISHED",
            message: "cannot amend a merged or canceled task",
          },
        },
        409,
      );
    }
    const parsed = feedbackBody.safeParse(await parseBody(c));
    if (!parsed.success) return badBody(c, parsed.error.message);
    let updated = ctx.store.amendTaskSpec(task.id, parsed.data.feedback);
    if (updated.state === "mr_open") {
      try {
        updated = ctx.store.transitionTask(
          updated.id,
          updated.state_version,
          "queued",
          c.get("actor"),
          { attempt: updated.attempt + 1, next_retry_at: null },
        );
      } catch (err) {
        return conflict(c, err);
      }
    }
    ctx.store.audit(c.get("actor"), "task.spec_amended", {
      scope_id: task.scope_id,
      task_id: task.id,
      detail: { amendment: parsed.data.feedback },
    });
    ctx.requestTick();
    return c.json(updated);
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
        { id: scope.provider_repo_id, path: scope.provider_repo_path },
        `${scope.provider_repo_id}:${task.mr_iid}`,
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

  app.get("/runs/:id", (c) => {
    const run = ctx.store.getRun(c.req.param("id"));
    if (!run) return notFound(c, "run");
    return c.json(run);
  });

  app.get("/runs/:id/events", (c) => {
    const run = ctx.store.getRun(c.req.param("id"));
    if (!run) return notFound(c, "run");
    const parsed = runEventsQuery.safeParse({
      before_id: c.req.query("before_id"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) return badBody(c, parsed.error.message);
    return c.json(ctx.store.listRunEvents(run.id, parsed.data));
  });

  app.get("/runs/:id/artifacts", (c) => {
    const run = ctx.store.getRun(c.req.param("id"));
    if (!run) return notFound(c, "run");
    const parsed = runArtifactsQuery.safeParse({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });
    if (!parsed.success) return badBody(c, parsed.error.message);
    return c.json(ctx.store.listRunArtifacts(run.id, parsed.data));
  });

  // Local backend: stream the stored bytes with their content type. Remote
  // backends answer ARTIFACT_REMOTE with the ref — no proxying/presigning.
  app.get("/runs/:id/artifacts/:artifact_id", async (c) => {
    const run = ctx.store.getRun(c.req.param("id"));
    if (!run) return notFound(c, "run");
    const row = ctx.store.getRunArtifact(run.id, c.req.param("artifact_id"));
    if (!row) return notFound(c, "artifact");
    const url = ctx.artifacts.getUrl(row.ref);
    if (url === undefined) {
      const bytes = await ctx.artifacts.get(row.ref);
      if (bytes === undefined) return notFound(c, "artifact");
      return new Response(bytes, {
        headers: {
          "content-type": row.content_type ?? "application/octet-stream",
          "content-length": String(bytes.byteLength),
          "x-content-type-options": "nosniff",
        },
      });
    }
    return c.json(
      {
        error: {
          code: "ARTIFACT_REMOTE",
          message: `artifact bytes live on the remote artifact backend; fetch the ref directly`,
          ref: url,
        },
      },
      200,
    );
  });

  app.get("/audit", (c) => {
    const parsed = auditQuery.safeParse({
      scope_id: c.req.query("scope_id"),
      task_id: c.req.query("task_id"),
      run_id: c.req.query("run_id"),
      before_id: c.req.query("before_id"),
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

/** Whether the request's Accept-Encoding header includes gzip. */
function acceptsGzip(c: Context<Env>): boolean {
  return (c.req.header("accept-encoding") ?? "").includes("gzip");
}

function uiResponse(relPath: string, acceptsGzip = false): Response | null {
  const rel = decodeURIComponent(relPath).replace(/^\/+/, "");
  const full = resolveStaticUiPath(rel);
  if (!full) return null;
  const mime = UI_MIME[extname(full)] ?? "application/octet-stream";
  const gzippable = GZIPPABLE_UI_EXTS[extname(full)] === true;
  const cache =
    extname(full) === ".woff2"
      ? "public, max-age=31536000, immutable"
      : "no-cache";
  const headers: Record<string, string> = {
    "content-type": mime,
    "cache-control": cache,
    "x-content-type-options": "nosniff",
  };
  if (gzippable) headers["vary"] = "accept-encoding";
  if (gzippable && acceptsGzip) {
    const st = statSync(full);
    let entry = uiGzipCache.get(full);
    if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
      entry = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        compressed: gzipSync(readFileSync(full)),
      };
      uiGzipCache.set(full, entry);
    }
    headers["content-encoding"] = "gzip";
    return new Response(entry.compressed, { headers });
  }
  return new Response(readFileSync(full), { headers });
}

function staticUiAsset(requestPath: string): string | null {
  if (requestPath !== "/ui" && !requestPath.startsWith("/ui/")) return null;
  const rel = decodeURIComponent(requestPath.replace(/^\/ui\/?/, "")).replace(
    /^\/+/,
    "",
  );
  return resolveStaticUiPath(rel);
}

function resolveStaticUiPath(rel: string): string | null {
  if (!rel || rel.includes("\0") || rel.split(/[\\/]/).includes("..")) {
    return null;
  }
  const full = normalize(join(UI_DIR, rel));
  const root = normalize(join(UI_DIR, "."));
  if (full !== root && !full.startsWith(root + sep)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Requests that never produce an HTTP server span. */
function isExcludedFromHttpSpans(path: string): boolean {
  return path === "/health" || staticUiAsset(path) !== null;
}
