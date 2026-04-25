import { createHash } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type {
  ActorId,
  Capability,
  EventKind,
  ScopeId,
  TaskId,
} from "@colony/domain";
import { DomainStateError } from "@colony/domain";
import { evaluateAction, type TaskGraphAction } from "@colony/policy";
import {
  IdempotencyRepository,
  PolicyRepository,
  RepositoryError,
  TaskGraphRepository,
} from "@colony/db";
import { getPool } from "./db.js";

const scopeIdParam = z
  .string()
  .regex(/^col-[a-z0-9]{4,}$/)
  .openapi({ param: { name: "scopeId", in: "path" } });
const taskIdParam = z
  .string()
  .regex(/^col-[a-z0-9]{4,}\.[0-9]+$/)
  .openapi({ param: { name: "taskId", in: "path" } });

const errorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    retriable: z.boolean().optional(),
  }),
});

type ErrorPayload = {
  error: {
    code: string;
    message: string;
    details?: Readonly<Record<string, unknown>>;
    retriable?: boolean;
  };
};

function jsonError(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
  retriable = false,
): ErrorPayload {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      ...(retriable ? { retriable } : {}),
    },
  };
}

function routeFingerprint(method: string, path: string, body: unknown): string {
  const raw = JSON.stringify({ method, path, body });
  return createHash("sha256").update(raw).digest("hex");
}

function isPostgresUniqueViolation(e: unknown): e is { code: string } {
  return (
    typeof e === "object" && e !== null && "code" in e && e.code === "23505"
  );
}

function isPostgresForeignKeyViolation(e: unknown): e is { code: string } {
  return (
    typeof e === "object" && e !== null && "code" in e && e.code === "23503"
  );
}

export interface TaskGraphDeps {
  readonly repo: TaskGraphRepository;
  readonly policyRepo: PolicyRepository;
  readonly idempotencyRepo: IdempotencyRepository;
}

let singleton: TaskGraphDeps | undefined;

export function getTaskGraphDeps(): TaskGraphDeps {
  if (!singleton) {
    const pool = getPool();
    singleton = {
      repo: new TaskGraphRepository(pool),
      policyRepo: new PolicyRepository(pool),
      idempotencyRepo: new IdempotencyRepository(pool),
    };
  }
  return singleton;
}

async function assertPolicy(
  policyRepo: PolicyRepository,
  actor: ActorId,
  action: TaskGraphAction,
  scopeId: ScopeId | null,
) {
  const effectivePolicy =
    scopeId === null
      ? await policyRepo.getGlobalPolicy()
      : await policyRepo.getEffectivePolicy(scopeId);
  const granted = await policyRepo.getCapabilityGrantsForActor(actor, scopeId);
  const providerIdentity = await policyRepo.getProviderIdentity(actor);
  return evaluateAction(action, {
    granted,
    providerIdentity,
    effectivePolicy,
  });
}

async function auditPolicyDeny(
  repo: TaskGraphRepository,
  actor: ActorId,
  action: string,
  scopeId: ScopeId | undefined,
  cap: Capability,
  reason: string,
  details: Readonly<Record<string, unknown>>,
) {
  try {
    await repo.writeAudit({
      scope_id: scopeId,
      actor,
      action: "policy.deny",
      capability: cap,
      reason,
      evidence: { attempted_action: action, ...details },
    });
  } catch (e) {
    if (!scopeId || !isPostgresForeignKeyViolation(e)) {
      throw e;
    }
    await repo.writeAudit({
      actor,
      action: "policy.deny",
      capability: cap,
      reason,
      evidence: {
        attempted_action: action,
        attempted_scope_id: scopeId,
        ...details,
      },
    });
  }
}

async function requestJsonFingerprintBody(c: Context): Promise<unknown> {
  try {
    return await c.req.raw.clone().json();
  } catch {
    return null;
  }
}

function cachedResponse(
  c: Context,
  hit: { readonly response_json: unknown; readonly status_code: number },
): Response {
  return c.json(hit.response_json, hit.status_code as ContentfulStatusCode);
}

function registerIdempotencyMiddleware(
  app: OpenAPIHono<{ Variables: { actor: string } }>,
  deps: TaskGraphDeps,
): void {
  app.use(async (c, next) => {
    const idem = c.req.header("Idempotency-Key");
    if (!idem || c.req.method !== "POST") {
      await next();
      return;
    }

    const actor = c.get("actor") as ActorId;
    const fp = routeFingerprint(
      c.req.method,
      c.req.path,
      await requestJsonFingerprintBody(c),
    );

    await deps.idempotencyRepo.withActorKeyLock(actor, idem, async () => {
      const hit = await deps.idempotencyRepo.getCached(actor, idem);
      if (hit) {
        if (hit.route_fingerprint !== fp) {
          c.res = c.json(
            jsonError(
              "IDEMPOTENCY_KEY_REUSED",
              "Idempotency-Key was already used with a different request",
            ),
            409,
          );
          return;
        }
        c.res = cachedResponse(c, hit);
        return;
      }

      await next();
      if (c.res.status < 200 || c.res.status >= 300) {
        return;
      }
      const data = await c.res.clone().json();
      try {
        await deps.idempotencyRepo.store(actor, idem, fp, c.res.status, data);
      } catch (e) {
        if (isPostgresUniqueViolation(e)) {
          const again = await deps.idempotencyRepo.getCached(actor, idem);
          if (again) {
            c.res =
              again.route_fingerprint === fp
                ? cachedResponse(c, again)
                : c.json(
                    jsonError(
                      "IDEMPOTENCY_KEY_REUSED",
                      "Idempotency-Key was already used with a different request",
                    ),
                    409,
                  );
            return;
          }
        }
        throw e;
      }
    });
  });
}

const scopeStateSchema = z.enum([
  "draft",
  "decomposition_proposed",
  "decomposition_approved",
  "active",
  "scope_review_requested",
  "scope_review_approved",
  "closed",
  "blocked",
  "conflict",
  "canceled",
]);
const taskStateSchema = z.enum([
  "created",
  "ready",
  "claimed",
  "in_progress",
  "review_requested",
  "changes_requested",
  "merge_ready",
  "merged",
  "closed",
  "blocked",
  "conflict",
  "failed",
  "canceled",
  "pending_sync",
]);
const eventKindSchema = z.string().min(1);

export function registerTaskGraph(
  app: OpenAPIHono<{ Variables: { actor: string } }>,
  deps: TaskGraphDeps = getTaskGraphDeps(),
) {
  registerIdempotencyMiddleware(app, deps);

  const listScopesRoute = createRoute({
    method: "get",
    path: "/scopes",
    summary: "List task graph scopes",
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": {
            schema: z.object({ items: z.array(z.unknown()) }),
          },
        },
      },
      403: {
        description: "Policy denied",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });

  const postScope = createRoute({
    method: "post",
    path: "/scopes",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              id: z.string().regex(/^col-[a-z0-9]{4,}$/),
              title: z.string().min(1),
              description: z.string(),
              state: scopeStateSchema.optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: z.unknown() } },
      },
      400: {
        description: "Error",
        content: { "application/json": { schema: errorBody } },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: errorBody } },
      },
      409: {
        description: "Conflict",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });

  app.openapi(listScopesRoute, async (c) => {
    const actor = c.get("actor") as ActorId;
    const r = await assertPolicy(deps.policyRepo, actor, "scope.list", null);
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "scope.list",
        undefined,
        r.capability,
        r.reason,
        {},
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    const items = await deps.repo.listScopes();
    return c.json({ items: [...items] }, 200);
  });

  app.openapi(postScope, async (c) => {
    const actor = c.get("actor") as ActorId;
    const body = c.req.valid("json");
    const r = await assertPolicy(deps.policyRepo, actor, "scope.create", null);
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "scope.create",
        undefined,
        r.capability,
        r.reason,
        { body_id: body.id },
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    try {
      const scope = await deps.repo.createScope(
        {
          id: body.id as ScopeId,
          title: body.title,
          description: body.description,
          state: body.state,
        },
        { actor, capability: r.capability, reason: "api" },
      );
      return c.json(scope, 201);
    } catch (e) {
      if (isPostgresUniqueViolation(e)) {
        return c.json(
          jsonError("CONFLICT", `scope already exists: ${body.id}`, {
            scope_id: body.id,
          }),
          409,
        );
      }
      throw e;
    }
  });

  // GET /scopes/:scopeId
  const getScope = createRoute({
    method: "get",
    path: "/scopes/{scopeId}",
    request: { params: z.object({ scopeId: scopeIdParam }) },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: z.unknown() } },
      },
      403: {
        description: "Policy denied",
        content: { "application/json": { schema: errorBody } },
      },
      404: {
        description: "Scope not found",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });
  app.openapi(getScope, async (c) => {
    const { scopeId } = c.req.valid("param");
    const actor = c.get("actor") as ActorId;
    const r = await assertPolicy(
      deps.policyRepo,
      actor,
      "scope.read",
      scopeId as ScopeId,
    );
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "scope.read",
        scopeId as ScopeId,
        r.capability,
        r.reason,
        { scopeId },
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    const s = await deps.repo.getScope(scopeId as ScopeId);
    if (!s) {
      return c.json(jsonError("NOT_FOUND", `scope not found: ${scopeId}`), 404);
    }
    return c.json(s, 200);
  });

  // GET/POST /scopes/:id/tasks
  const listTasks = createRoute({
    method: "get",
    path: "/scopes/{scopeId}/tasks",
    request: {
      params: z.object({ scopeId: scopeIdParam }),
      query: z.object({ state: taskStateSchema.optional() }),
    },
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": {
            schema: z.object({ items: z.array(z.unknown()) }),
          },
        },
      },
      403: {
        description: "Policy denied",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });
  app.openapi(listTasks, async (c) => {
    const { scopeId } = c.req.valid("param");
    const { state } = c.req.valid("query");
    const actor = c.get("actor") as ActorId;
    const r = await assertPolicy(
      deps.policyRepo,
      actor,
      "task.list",
      scopeId as ScopeId,
    );
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "task.list",
        scopeId as ScopeId,
        r.capability,
        r.reason,
        {},
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    const items = await deps.repo.listTasks(scopeId as ScopeId, { state });
    return c.json({ items }, 200);
  });

  const postTask = createRoute({
    method: "post",
    path: "/scopes/{scopeId}/tasks",
    request: {
      params: z.object({ scopeId: scopeIdParam }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              id: z.string().regex(/^col-[a-z0-9]{4,}\.[0-9]+$/),
              title: z.string().min(1),
              description: z.string(),
              acceptance_criteria: z.array(z.string()).optional(),
              non_goals: z.array(z.string()).optional(),
              state: taskStateSchema.optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: z.unknown() } },
      },
      403: {
        description: "Policy denied",
        content: { "application/json": { schema: errorBody } },
      },
      404: {
        description: "Scope not found",
        content: { "application/json": { schema: errorBody } },
      },
      409: {
        description: "Conflict",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });
  app.openapi(postTask, async (c) => {
    const { scopeId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = c.get("actor") as ActorId;
    const r = await assertPolicy(
      deps.policyRepo,
      actor,
      "task.create",
      scopeId as ScopeId,
    );
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "task.create",
        scopeId as ScopeId,
        r.capability,
        r.reason,
        { task_id: body.id },
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    const scope = await deps.repo.getScope(scopeId as ScopeId);
    if (!scope) {
      return c.json(jsonError("NOT_FOUND", `scope not found: ${scopeId}`), 404);
    }
    try {
      const t = await deps.repo.createTask(
        {
          id: body.id as TaskId,
          scope_id: scopeId as ScopeId,
          title: body.title,
          description: body.description,
          acceptance_criteria: body.acceptance_criteria,
          non_goals: body.non_goals,
          state: body.state,
        },
        { actor, capability: r.capability, reason: "api" },
      );
      return c.json(t, 201);
    } catch (e) {
      if (isPostgresUniqueViolation(e)) {
        return c.json(
          jsonError("CONFLICT", `task already exists: ${body.id}`, {
            task_id: body.id,
          }),
          409,
        );
      }
      if (isPostgresForeignKeyViolation(e)) {
        return c.json(
          jsonError("NOT_FOUND", `scope not found: ${scopeId}`),
          404,
        );
      }
      throw e;
    }
  });

  // ready tasks
  const ready = createRoute({
    method: "get",
    path: "/scopes/{scopeId}/ready-tasks",
    request: { params: z.object({ scopeId: scopeIdParam }) },
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": {
            schema: z.object({ items: z.array(z.unknown()) }),
          },
        },
      },
      403: {
        description: "Policy denied",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });
  app.openapi(ready, async (c) => {
    const { scopeId } = c.req.valid("param");
    const actor = c.get("actor") as ActorId;
    const r = await assertPolicy(
      deps.policyRepo,
      actor,
      "ready.read",
      scopeId as ScopeId,
    );
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "ready.read",
        scopeId as ScopeId,
        r.capability,
        r.reason,
        {},
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    const items = await deps.repo.readyTasks(scopeId as ScopeId);
    return c.json({ items }, 200);
  });

  // audit
  const audit = createRoute({
    method: "get",
    path: "/scopes/{scopeId}/audit",
    request: {
      params: z.object({ scopeId: scopeIdParam }),
      query: z.object({
        task_id: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
    },
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": {
            schema: z.object({ items: z.array(z.unknown()) }),
          },
        },
      },
      403: {
        description: "Policy denied",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });
  app.openapi(audit, async (c) => {
    const { scopeId } = c.req.valid("param");
    const { task_id, limit } = c.req.valid("query");
    const actor = c.get("actor") as ActorId;
    const r = await assertPolicy(
      deps.policyRepo,
      actor,
      "audit.read",
      scopeId as ScopeId,
    );
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "audit.read",
        scopeId as ScopeId,
        r.capability,
        r.reason,
        {},
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    const items = await deps.repo.listAuditForScope(scopeId as ScopeId, {
      task_id: task_id as TaskId | undefined,
      limit,
    });
    return c.json({ items: [...items] }, 200);
  });

  // GET /tasks/{taskId}
  const getTask = createRoute({
    method: "get",
    path: "/tasks/{taskId}",
    request: { params: z.object({ taskId: taskIdParam }) },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: z.unknown() } },
      },
      403: {
        description: "Policy denied",
        content: { "application/json": { schema: errorBody } },
      },
      404: {
        description: "Task not found",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });
  app.openapi(getTask, async (c) => {
    const { taskId } = c.req.valid("param");
    const actor = c.get("actor") as ActorId;
    const task = await deps.repo.getTask(taskId as TaskId);
    if (!task) {
      return c.json(jsonError("NOT_FOUND", `task not found: ${taskId}`), 404);
    }
    const r = await assertPolicy(
      deps.policyRepo,
      actor,
      "task.read",
      task.scope_id,
    );
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "task.read",
        task.scope_id,
        r.capability,
        r.reason,
        { taskId },
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    return c.json(task, 200);
  });

  // GET /tasks/{taskId}/dependencies
  const getTaskDeps = createRoute({
    method: "get",
    path: "/tasks/{taskId}/dependencies",
    request: { params: z.object({ taskId: taskIdParam }) },
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": {
            schema: z.object({
              blocked_by: z.array(z.string()),
              blocks: z.array(z.string()),
            }),
          },
        },
      },
      403: {
        description: "Policy denied",
        content: { "application/json": { schema: errorBody } },
      },
      404: {
        description: "Task not found",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });
  app.openapi(getTaskDeps, async (c) => {
    const { taskId } = c.req.valid("param");
    const actor = c.get("actor") as ActorId;
    const task = await deps.repo.getTask(taskId as TaskId);
    if (!task) {
      return c.json(jsonError("NOT_FOUND", `task not found: ${taskId}`), 404);
    }
    const r = await assertPolicy(
      deps.policyRepo,
      actor,
      "task.read",
      task.scope_id,
    );
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "task.read",
        task.scope_id,
        r.capability,
        r.reason,
        { taskId, subresource: "dependencies" },
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    const { blocked_by, blocks } = await deps.repo.getTaskDependencies(
      taskId as TaskId,
    );
    return c.json({ blocked_by: [...blocked_by], blocks: [...blocks] }, 200);
  });

  // POST claim
  const claim = createRoute({
    method: "post",
    path: "/tasks/{taskId}/claim",
    request: {
      params: z.object({ taskId: taskIdParam }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              expected_state_version: z.coerce.number().int(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Claimed",
        content: { "application/json": { schema: z.unknown() } },
      },
      400: {
        description: "Invalid request",
        content: { "application/json": { schema: errorBody } },
      },
      403: {
        description: "Policy denied",
        content: { "application/json": { schema: errorBody } },
      },
      404: {
        description: "Task not found",
        content: { "application/json": { schema: errorBody } },
      },
      409: {
        description: "Claim conflict",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });
  app.openapi(claim, async (c) => {
    const { taskId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = c.get("actor") as ActorId;
    const t = await deps.repo.getTask(taskId as TaskId);
    if (!t) {
      return c.json(jsonError("NOT_FOUND", `task not found: ${taskId}`), 404);
    }
    const r = await assertPolicy(
      deps.policyRepo,
      actor,
      "task.claim",
      t.scope_id,
    );
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "task.claim",
        t.scope_id,
        r.capability,
        r.reason,
        { taskId },
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    try {
      const updated = await deps.repo.claimTask(
        taskId as TaskId,
        actor,
        body.expected_state_version,
        { actor, capability: r.capability, reason: "api" },
      );
      if (!updated) {
        return c.json(
          jsonError(
            "CLAIM_LOST",
            "claim did not win (concurrent or stale state_version)",
            { taskId },
          ),
          409,
        );
      }
      return c.json(updated, 200);
    } catch (e) {
      if (e instanceof RepositoryError) {
        return c.json(
          jsonError(
            e.code,
            e.message,
            e.details,
            e.code === "STATE_VERSION_MISMATCH",
          ),
          e.code === "NOT_FOUND" ? 404 : 400,
        );
      }
      if (e instanceof DomainStateError) {
        return c.json(
          {
            error: {
              code: e.code,
              message: e.message,
              details: e.details,
              retriable: e.retriable,
            },
          },
          400,
        );
      }
      throw e;
    }
  });

  // POST /events
  const recordEvent = createRoute({
    method: "post",
    path: "/events",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              scope_id: z.string().optional(),
              task_id: z.string().optional(),
              kind: eventKindSchema,
              actor: z.string().optional(),
              payload: z.record(z.string(), z.unknown()).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: z.unknown() } },
      },
      400: {
        description: "Invalid request",
        content: { "application/json": { schema: errorBody } },
      },
      403: {
        description: "Policy denied",
        content: { "application/json": { schema: errorBody } },
      },
      404: {
        description: "Scope or task not found",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });
  app.openapi(recordEvent, async (c) => {
    const body = c.req.valid("json");
    const actor = c.get("actor") as ActorId;
    const scopeRe = /^(col-[a-z0-9]{4,})$/;
    const taskRe = /^(col-[a-z0-9]{4,}\.[0-9]+)$/;
    if (body.scope_id && !scopeRe.test(body.scope_id)) {
      return c.json(
        jsonError("VALIDATION", "scope_id must match col-... pattern", {
          scope_id: body.scope_id,
        }),
        400,
      );
    }
    if (body.task_id && !taskRe.test(body.task_id)) {
      return c.json(
        jsonError("VALIDATION", "task_id must match col-....N pattern", {
          task_id: body.task_id,
        }),
        400,
      );
    }
    const resolvedScope: ScopeId | null =
      (body.scope_id as ScopeId | undefined) ??
      (body.task_id
        ? (await deps.repo.getTask(body.task_id as TaskId))?.scope_id
        : null) ??
      null;
    if (!resolvedScope) {
      return c.json(
        jsonError(
          "INVALID_REQUEST",
          "scope_id, or task_id that resolves to a task, is required",
        ),
        400,
      );
    }
    if (body.scope_id && !(await deps.repo.getScope(resolvedScope))) {
      return c.json(
        jsonError("NOT_FOUND", `scope not found: ${body.scope_id}`),
        404,
      );
    }
    const r = await assertPolicy(
      deps.policyRepo,
      actor,
      "event.record",
      resolvedScope,
    );
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "event.record",
        resolvedScope,
        r.capability,
        r.reason,
        { body },
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    const e = await deps.repo.withTransaction(async (tx) => {
      const ev = await tx.recordEvent({
        scope_id: resolvedScope,
        task_id: body.task_id as TaskId | undefined,
        kind: body.kind as EventKind,
        actor: (body.actor as ActorId | undefined) ?? actor,
        payload: body.payload,
      });
      await tx.writeAudit({
        scope_id: resolvedScope,
        task_id: body.task_id as TaskId | undefined,
        actor,
        action: "event.record",
        capability: r.capability,
        target_kind: "event",
        target_id: ev.id,
        reason: "api",
        evidence: { kind: body.kind },
      });
      return ev;
    });
    return c.json(e, 201);
  });
}
