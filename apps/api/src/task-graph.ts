import { createHash } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type {
  ActorId,
  Capability,
  EventKind,
  ProviderMirror,
  ProviderProjectId,
  Scope,
  ScopeId,
  Task,
  TaskId,
} from "@colony/domain";
import { DomainStateError } from "@colony/domain";
import { evaluateAction, type TaskGraphAction } from "@colony/policy";
import {
  architectDecompositionEnvelopeSchema,
  type ArchitectDecompositionEnvelope,
} from "@colony/schemas";
import {
  IdempotencyRepository,
  PolicyRepository,
  ProviderProjectRepository,
  RepositoryError,
  TaskGraphRepository,
} from "@colony/db";
import { env } from "@colony/config";
import type { ProviderAdapter } from "@colony/provider";
import { GitLabProviderAdapter } from "@colony/provider-gitlab";
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

function sha256Json(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
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

const providerTargetSchema = z.object({
  provider_project_id: z.string().min(1),
  role: z
    .enum(["primary", "frontend", "backend", "data", "infra", "docs", "shared"])
    .default("primary"),
});

const scopeMirrorSchema = z.object({
  provider_project_id: z.string().min(1),
  provider_id: z.string().min(1).optional(),
  freshness_ttl_seconds: z.number().int().positive().optional(),
});

const taskMirrorSchema = z.object({
  provider_project_id: z.string().min(1).optional(),
  provider_id: z.string().min(1).optional(),
  freshness_ttl_seconds: z.number().int().positive().optional(),
});

export interface TaskGraphDeps {
  readonly repo: TaskGraphRepository;
  readonly policyRepo: PolicyRepository;
  readonly idempotencyRepo: IdempotencyRepository;
  readonly providerProjects: ProviderProjectRepository;
  readonly providerAdapter?: ProviderAdapter;
}

let singleton: TaskGraphDeps | undefined;

export function getTaskGraphDeps(): TaskGraphDeps {
  if (!singleton) {
    const pool = getPool();
    singleton = {
      repo: new TaskGraphRepository(pool),
      policyRepo: new PolicyRepository(pool),
      idempotencyRepo: new IdempotencyRepository(pool),
      providerProjects: new ProviderProjectRepository(pool),
      providerAdapter: new GitLabProviderAdapter({
        baseUrl: env().GITLAB_BASE_URL,
        token: env().GITLAB_TOKEN,
      }),
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
    if (!idem || c.req.method !== "POST" || c.req.path.startsWith("/admin/")) {
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

type ProviderTargetInput = z.infer<typeof providerTargetSchema>;
type ScopeMirrorInput = z.infer<typeof scopeMirrorSchema>;
type TaskMirrorInput = z.infer<typeof taskMirrorSchema>;

async function registerScopeTargets(
  deps: TaskGraphDeps,
  scope_id: ScopeId,
  providerTargets: readonly ProviderTargetInput[],
) {
  for (const target of providerTargets) {
    const project = await deps.providerProjects.getProject(
      target.provider_project_id as ProviderProjectId,
    );
    if (!project) {
      throw new RepositoryError("NOT_FOUND", "provider project not found", {
        provider_project_id: target.provider_project_id,
      });
    }
    await deps.providerProjects.linkScopeTarget({
      scope_id,
      provider_project_id: project.id,
      role: target.role,
    });
  }
  return deps.providerProjects.listScopeTargets(scope_id);
}

async function mirrorScopeIfRequested(
  deps: TaskGraphDeps,
  input: {
    readonly scope: Scope;
    readonly providerTargets: readonly ProviderTargetInput[];
    readonly providerMirror?: ScopeMirrorInput;
    readonly actor: ActorId;
    readonly capability: Capability;
  },
): Promise<void> {
  const targets = await registerScopeTargets(
    deps,
    input.scope.id,
    input.providerTargets,
  );
  if (!input.providerMirror) return;

  const project = await deps.providerProjects.getProject(
    input.providerMirror.provider_project_id as ProviderProjectId,
  );
  if (!project) {
    throw new RepositoryError("NOT_FOUND", "provider project not found", {
      provider_project_id: input.providerMirror.provider_project_id,
    });
  }
  if (
    !targets.some(
      (target) =>
        target.provider_project_id === project.id && target.role === "primary",
    )
  ) {
    await deps.providerProjects.linkScopeTarget({
      scope_id: input.scope.id,
      provider_project_id: project.id,
      role: "primary",
    });
  }

  const issue = input.providerMirror.provider_id
    ? undefined
    : await requireProviderAdapter(deps).epics.create(
        { id: project.provider_id, path: project.path },
        {
          title: input.scope.title,
          description: `${input.scope.description}\n\nColony scope: ${input.scope.id}`,
          labels: ["colony:scope", `state:${input.scope.state}`],
        },
      );
  const providerId = input.providerMirror.provider_id ?? issue?.id;
  if (!providerId) {
    throw new Error("missing provider id for scope mirror");
  }
  const mirror = await deps.providerProjects.upsertMirror({
    colony_id: input.scope.id,
    entity_kind: "scope",
    provider: project.provider,
    provider_id: providerId,
    provider_project_id: project.id,
    provider_project_path: project.path,
    source_version: issue?.metadata.version,
    freshness_ttl_seconds: input.providerMirror.freshness_ttl_seconds,
  });
  await deps.repo.writeAudit({
    scope_id: input.scope.id,
    actor: input.actor,
    action: "provider.mirror.scope",
    capability: input.capability,
    target_kind: "provider_mirror",
    target_id: mirror.id,
    reason: "api",
    evidence: { mirror },
  });
}

async function projectScopeStateIfMirrored(
  deps: TaskGraphDeps,
  input: {
    readonly scope: Scope;
    readonly actor: ActorId;
    readonly capability: Capability;
  },
): Promise<void> {
  const mirrors = await deps.providerProjects.listMirrorsForColony({
    colony_id: input.scope.id,
    entity_kind: "scope",
  });
  if (mirrors.length === 0) return;
  const adapter = requireProviderAdapter(deps);
  for (const mirror of mirrors) {
    if (!mirror.provider_project_id) continue;
    const project = await deps.providerProjects.getProject(
      mirror.provider_project_id,
    );
    if (!project || project.provider !== adapter.provider) continue;
    const projectRef = { id: project.provider_id, path: project.path };
    const issue = await adapter.issues.get(projectRef, mirror.provider_id);
    const labels = [
      ...issue.labels.filter((label) => !label.startsWith("state:")),
      `state:${input.scope.state}`,
    ];
    const projected =
      input.scope.state === "closed"
        ? await adapter.issues.close(projectRef, mirror.provider_id)
        : await adapter.issues.update(projectRef, mirror.provider_id, {
            labels,
          });
    await deps.providerProjects.upsertMirror({
      colony_id: input.scope.id,
      entity_kind: "scope",
      provider: project.provider,
      provider_id: mirror.provider_id,
      provider_project_id: project.id,
      provider_project_path: project.path,
      source_version: projected.metadata.version,
      freshness_ttl_seconds: mirror.freshness_ttl_seconds,
    });
    await deps.repo.writeAudit({
      scope_id: input.scope.id,
      actor: input.actor,
      action: "provider.project.scope_state",
      capability: input.capability,
      target_kind: "provider_mirror",
      target_id: mirror.id,
      reason: "scope_transition",
      evidence: {
        provider: project.provider,
        provider_id: mirror.provider_id,
        state: input.scope.state,
        labels,
      },
    });
  }
}

async function requestArchitectDecomposition(
  deps: TaskGraphDeps,
  input: {
    readonly scope: Scope;
    readonly providerTargets: readonly ProviderTargetInput[];
    readonly actor: ActorId;
    readonly capability: Capability;
    readonly reason?: string;
  },
) {
  if (input.scope.state !== "draft") {
    return {
      ok: false as const,
      status: 409 as const,
      body: jsonError(
        "INVALID_SCOPE_STATE",
        "architect decomposition can only be requested for a draft scope",
        {
          scope_id: input.scope.id,
          state: input.scope.state,
        },
      ),
    };
  }
  const targets = await registerScopeTargets(
    deps,
    input.scope.id,
    input.providerTargets,
  );
  if (targets.length === 0) {
    return {
      ok: false as const,
      status: 400 as const,
      body: jsonError(
        "MISSING_PROVIDER_TARGET",
        "architect decomposition requires at least one provider target",
        { scope_id: input.scope.id },
      ),
    };
  }
  const evidence = {
    state: input.scope.state,
    state_version: input.scope.state_version,
    provider_targets: targets.map((target) => ({
      provider_project_id: target.provider_project_id,
      role: target.role,
    })),
  };
  const audit_id = await deps.repo.writeAudit({
    scope_id: input.scope.id,
    actor: input.actor,
    action: "scope.decomposition_request",
    capability: input.capability,
    target_kind: "scope",
    target_id: input.scope.id,
    reason: input.reason ?? "api",
    evidence,
  });
  const event = await deps.repo.recordEvent({
    scope_id: input.scope.id,
    kind: "architect_decomposition_requested",
    actor: input.actor,
    payload: evidence,
  });
  return {
    ok: true as const,
    body: {
      requested: true,
      scope_id: input.scope.id,
      state: input.scope.state,
      state_version: input.scope.state_version,
      provider_targets: evidence.provider_targets,
      audit_id,
      event_id: event.id,
    },
  };
}

async function mirrorTaskIfRequested(
  deps: TaskGraphDeps,
  input: {
    readonly task: Task;
    readonly providerProjectId?: string;
    readonly providerMirror?: TaskMirrorInput;
    readonly actor: ActorId;
    readonly capability: Capability;
  },
): Promise<void> {
  const providerProjectId =
    input.providerMirror?.provider_project_id ??
    input.providerProjectId ??
    (await deps.providerProjects.getPrimaryScopeTarget(input.task.scope_id))
      ?.provider_project_id;
  if (!providerProjectId) return;

  const project = await deps.providerProjects.getProject(
    providerProjectId as ProviderProjectId,
  );
  if (!project) {
    throw new RepositoryError("NOT_FOUND", "provider project not found", {
      provider_project_id: providerProjectId,
    });
  }

  await deps.providerProjects.linkTaskTarget({
    task_id: input.task.id,
    provider_project_id: project.id,
    role: "primary",
  });

  const issue = input.providerMirror?.provider_id
    ? undefined
    : await requireProviderAdapter(deps).issues.create(
        { id: project.provider_id, path: project.path },
        taskIssueInput(input.task),
      );
  const providerId = input.providerMirror?.provider_id ?? issue?.id;
  if (!providerId) {
    throw new Error("missing provider id for task mirror");
  }
  const mirror = await deps.providerProjects.upsertMirror({
    colony_id: input.task.id,
    entity_kind: "task",
    provider: project.provider,
    provider_id: providerId,
    provider_project_id: project.id,
    provider_project_path: project.path,
    source_version: issue?.metadata.version,
    freshness_ttl_seconds: input.providerMirror?.freshness_ttl_seconds,
  });
  await deps.repo.writeAudit({
    scope_id: input.task.scope_id,
    task_id: input.task.id,
    actor: input.actor,
    action: "provider.mirror.task",
    capability: input.capability,
    target_kind: "provider_mirror",
    target_id: mirror.id,
    reason: "api",
    evidence: { mirror },
  });
}

function requireProviderAdapter(deps: TaskGraphDeps): ProviderAdapter {
  if (!deps.providerAdapter) {
    throw new Error("provider adapter is not configured");
  }
  return deps.providerAdapter;
}

function taskIssueInput(
  task: Task,
): Parameters<ProviderAdapter["issues"]["create"]>[1] {
  return {
    title: task.title,
    description: [
      task.description,
      "",
      `Colony task: ${task.id}`,
      `Colony scope: ${task.scope_id}`,
      "",
      ...task.acceptance_criteria.map((criterion) => `- [ ] ${criterion}`),
    ].join("\n"),
    labels: ["colony:task", `state:${task.state}`],
  };
}

type ProviderSyncStatus = "synced" | "pending" | "drifted";

interface ProviderSyncItem {
  readonly colony_id: string;
  readonly entity_kind: "scope" | "task";
  readonly status: ProviderSyncStatus;
  readonly mirrors: readonly (ProviderMirror & {
    readonly status: ProviderSyncStatus;
    readonly provider_url?: string;
  })[];
}

function mirrorStatus(mirror: ProviderMirror | undefined, now = Date.now()) {
  if (!mirror?.projected_at) return "pending" as const;
  const ttl = (mirror.freshness_ttl_seconds ?? 900) * 1000;
  const projectedAt = Date.parse(mirror.projected_at);
  if (Number.isFinite(projectedAt) && now - projectedAt > ttl) {
    return "drifted" as const;
  }
  return "synced" as const;
}

function providerWebBase(provider: string): string | null {
  if (provider === "gitlab") {
    return env()
      .GITLAB_BASE_URL.replace(/\/api\/v4\/?$/, "")
      .replace(/\/+$/, "");
  }
  if (provider === "fake") return "fake://provider";
  return null;
}

function issueIidFromProviderId(provider_id: string): string {
  const separator = provider_id.lastIndexOf(":");
  return separator === -1 ? provider_id : provider_id.slice(separator + 1);
}

function providerIssueUrl(mirror: ProviderMirror): string | undefined {
  const base = providerWebBase(mirror.provider);
  if (!base || !mirror.provider_project_path) return undefined;
  const iid = issueIidFromProviderId(mirror.provider_id);
  if (mirror.provider === "fake") {
    return `${base}/${mirror.provider_project_path}/${iid}`;
  }
  return `${base}/${mirror.provider_project_path}/-/issues/${encodeURIComponent(iid)}`;
}

async function providerSyncItem(
  deps: TaskGraphDeps,
  input: {
    readonly colony_id: string;
    readonly entity_kind: "scope" | "task";
  },
): Promise<ProviderSyncItem> {
  const now = Date.now();
  const mirrors = await deps.providerProjects.listMirrorsForColony(input);
  const decorated = mirrors.map((mirror) => ({
    ...mirror,
    status: mirrorStatus(mirror, now),
    provider_url: providerIssueUrl(mirror),
  }));
  return {
    ...input,
    status: decorated.length === 0 ? "pending" : decorated[0].status,
    mirrors: decorated,
  };
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
const targetProjectMappingSchema = z.record(z.string(), z.string().min(1));
const decompositionReviewResultSchema = z.enum([
  "approved",
  "changes_requested",
  "blocked",
  "escalate",
]);

function proposalTasks(
  envelope: ArchitectDecompositionEnvelope,
): Parameters<
  TaskGraphRepository["submitDecompositionProposal"]
>[0]["proposed_tasks"] {
  return envelope.role_specific.proposed_tasks.map((task) => ({
    proposed_task_id: task.proposed_task_id as TaskId,
    title: task.title,
    description: task.description,
    acceptance_criteria: task.acceptance_criteria,
    non_goals: task.non_goals,
    suggested_role: task.suggested_role,
    suggested_capabilities: task.suggested_capabilities,
    estimated_effort_minutes: task.estimated_effort_minutes,
  }));
}

function proposalDependencies(
  envelope: ArchitectDecompositionEnvelope,
): Parameters<
  TaskGraphRepository["submitDecompositionProposal"]
>[0]["proposed_dependencies"] {
  return envelope.role_specific.proposed_dependencies.map((dep) => ({
    from_task_id: dep.from_task_id as TaskId,
    to_task_id: dep.to_task_id as TaskId,
    kind: dep.kind,
  }));
}

function repositoryErrorStatus(e: RepositoryError): 400 | 404 | 409 {
  if (e.code === "NOT_FOUND") return 404;
  if (
    e.code === "STATE_VERSION_MISMATCH" ||
    e.code === "STALE_DECOMPOSITION_ENVELOPE" ||
    e.code === "DAG_ALREADY_COMMITTED"
  ) {
    return 409;
  }
  return 400;
}

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
              provider_targets: z.array(providerTargetSchema).optional(),
              provider_mirror: scopeMirrorSchema.optional(),
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
      404: {
        description: "Provider project not found",
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
      await mirrorScopeIfRequested(deps, {
        scope,
        providerTargets: body.provider_targets ?? [],
        providerMirror: body.provider_mirror,
        actor,
        capability: r.capability,
      });
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
      if (e instanceof RepositoryError && e.code === "NOT_FOUND") {
        return c.json(jsonError("NOT_FOUND", e.message, e.details), 404);
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

  const patchScopeState = createRoute({
    method: "post",
    path: "/scopes/{scopeId}/state",
    request: {
      params: z.object({ scopeId: scopeIdParam }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              expected_state_version: z.number().int().nonnegative(),
              state: scopeStateSchema,
              reason: z.string().min(1).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: z.unknown() } },
      },
      400: {
        description: "Invalid transition",
        content: { "application/json": { schema: errorBody } },
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
        description: "Version conflict",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });
  app.openapi(patchScopeState, async (c) => {
    const { scopeId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = c.get("actor") as ActorId;
    const scope_id = scopeId as ScopeId;
    const r = await assertPolicy(
      deps.policyRepo,
      actor,
      "scope.transition",
      scope_id,
    );
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "scope.transition",
        scope_id,
        r.capability,
        r.reason,
        { next_state: body.state },
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    try {
      const scope = await deps.repo.updateScopeState(
        scope_id,
        body.expected_state_version,
        body.state,
        {
          actor,
          capability: r.capability,
          reason: body.reason ?? "api",
        },
      );
      await projectScopeStateIfMirrored(deps, {
        scope,
        actor,
        capability: r.capability,
      });
      return c.json(scope, 200);
    } catch (e) {
      if (e instanceof RepositoryError) {
        return c.json(
          jsonError(
            e.code,
            e.message,
            e.details,
            e.code === "STATE_VERSION_MISMATCH",
          ),
          e.code === "NOT_FOUND"
            ? 404
            : e.code === "STATE_VERSION_MISMATCH"
              ? 409
              : 400,
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

  const requestDecompositionRoute = createRoute({
    method: "post",
    path: "/scopes/{scopeId}/decomposition-request",
    request: {
      params: z.object({ scopeId: scopeIdParam }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              provider_targets: z.array(providerTargetSchema).optional(),
              reason: z.string().min(1).optional(),
            }),
          },
        },
      },
    },
    responses: {
      202: {
        description: "Accepted",
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
        description: "Scope or provider project not found",
        content: { "application/json": { schema: errorBody } },
      },
      409: {
        description: "Scope is not intake-ready",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });
  app.openapi(requestDecompositionRoute, async (c) => {
    const { scopeId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = c.get("actor") as ActorId;
    const scope_id = scopeId as ScopeId;
    const r = await assertPolicy(
      deps.policyRepo,
      actor,
      "scope.decomposition_request",
      scope_id,
    );
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "scope.decomposition_request",
        scope_id,
        r.capability,
        r.reason,
        {},
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    const scope = await deps.repo.getScope(scope_id);
    if (!scope) {
      return c.json(jsonError("NOT_FOUND", `scope not found: ${scopeId}`), 404);
    }
    try {
      const result = await requestArchitectDecomposition(deps, {
        scope,
        providerTargets: body.provider_targets ?? [],
        actor,
        capability: r.capability,
        reason: body.reason,
      });
      if (!result.ok) {
        return c.json(result.body, result.status);
      }
      return c.json(result.body, 202);
    } catch (e) {
      if (e instanceof RepositoryError && e.code === "NOT_FOUND") {
        return c.json(jsonError("NOT_FOUND", e.message, e.details), 404);
      }
      if (e instanceof RepositoryError && e.code === "UNIQUE_VIOLATION") {
        return c.json(jsonError("CONFLICT", e.message, e.details), 409);
      }
      throw e;
    }
  });

  const submitDecompositionProposalRoute = createRoute({
    method: "post",
    path: "/scopes/{scopeId}/decomposition-proposals",
    request: {
      params: z.object({ scopeId: scopeIdParam }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              expected_scope_state_version: z.number().int().nonnegative(),
              scope_brief_version: z.string().min(1).default("brief:v1"),
              packet_hash: z.string().min(1),
              envelope: z.record(z.string(), z.unknown()),
              target_project_mapping: targetProjectMappingSchema.optional(),
              reason: z.string().min(1).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Decomposition proposed",
        content: { "application/json": { schema: z.unknown() } },
      },
      400: {
        description: "Invalid decomposition",
        content: { "application/json": { schema: errorBody } },
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
        description: "Version or stale-envelope conflict",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });
  app.openapi(submitDecompositionProposalRoute, async (c) => {
    const { scopeId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = c.get("actor") as ActorId;
    const scope_id = scopeId as ScopeId;
    const r = await assertPolicy(
      deps.policyRepo,
      actor,
      "scope.decomposition_submit",
      scope_id,
    );
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "scope.decomposition_submit",
        scope_id,
        r.capability,
        r.reason,
        {},
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    const parsed = architectDecompositionEnvelopeSchema.safeParse(
      body.envelope,
    );
    if (!parsed.success) {
      return c.json(
        jsonError("INVALID_DECOMPOSITION_ENVELOPE", parsed.error.message),
        400,
      );
    }
    if (parsed.data.scope_id !== scope_id) {
      return c.json(
        jsonError("SCOPE_MISMATCH", "decomposition envelope scope mismatch", {
          scope_id,
          envelope_scope_id: parsed.data.scope_id,
        }),
        400,
      );
    }
    try {
      const proposal = await deps.repo.submitDecompositionProposal(
        {
          scope_id,
          scope_state_version: body.expected_scope_state_version,
          scope_brief_version: body.scope_brief_version,
          proposed_tasks: proposalTasks(parsed.data),
          proposed_dependencies: proposalDependencies(parsed.data),
          target_project_mapping: body.target_project_mapping,
          assumptions: parsed.data.role_specific.assumptions,
          open_questions: parsed.data.role_specific.open_questions,
          packet_hash: body.packet_hash,
          envelope_hash: sha256Json(parsed.data),
          envelope: parsed.data,
        },
        {
          actor,
          capability: r.capability,
          reason: body.reason ?? "architect_envelope",
        },
      );
      const scope = await deps.repo.getScope(scope_id);
      await projectScopeStateIfMirrored(deps, {
        scope: scope!,
        actor,
        capability: r.capability,
      });
      return c.json({ proposal, scope }, 201);
    } catch (e) {
      if (e instanceof RepositoryError) {
        return c.json(
          jsonError(
            e.code,
            e.message,
            e.details,
            e.code === "STATE_VERSION_MISMATCH",
          ),
          repositoryErrorStatus(e),
        );
      }
      if (isPostgresUniqueViolation(e)) {
        return c.json(
          jsonError("CONFLICT", "decomposition already exists"),
          409,
        );
      }
      throw e;
    }
  });

  const reviewDecompositionProposalRoute = createRoute({
    method: "post",
    path: "/scopes/{scopeId}/decomposition-proposals/{proposalId}/review",
    request: {
      params: z.object({
        scopeId: scopeIdParam,
        proposalId: z.string().min(1),
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              envelope_hash: z.string().min(1),
              reviewer: z.string().min(1),
              result: decompositionReviewResultSchema,
              reason: z.string().min(1).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Review recorded",
        content: { "application/json": { schema: z.unknown() } },
      },
      400: {
        description: "Invalid review",
        content: { "application/json": { schema: errorBody } },
      },
      403: {
        description: "Policy denied",
        content: { "application/json": { schema: errorBody } },
      },
      404: {
        description: "Proposal not found",
        content: { "application/json": { schema: errorBody } },
      },
      409: {
        description: "Stale proposal",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });
  app.openapi(reviewDecompositionProposalRoute, async (c) => {
    const { scopeId, proposalId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = c.get("actor") as ActorId;
    const scope_id = scopeId as ScopeId;
    const r = await assertPolicy(
      deps.policyRepo,
      actor,
      "scope.decomposition_review",
      scope_id,
    );
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "scope.decomposition_review",
        scope_id,
        r.capability,
        r.reason,
        { proposal_id: proposalId },
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    try {
      const proposal = await deps.repo.recordDecompositionReview(
        {
          scope_id,
          proposal_id: proposalId,
          envelope_hash: body.envelope_hash,
          reviewer: body.reviewer as ActorId,
          result: body.result,
        },
        {
          actor,
          capability: r.capability,
          reason: body.reason ?? "spec_dag_review",
        },
      );
      const scope = await deps.repo.getScope(scope_id);
      if (scope) {
        await projectScopeStateIfMirrored(deps, {
          scope,
          actor,
          capability: r.capability,
        });
      }
      return c.json({ proposal, scope }, 200);
    } catch (e) {
      if (e instanceof RepositoryError) {
        return c.json(
          jsonError(
            e.code,
            e.message,
            e.details,
            e.code === "STALE_DECOMPOSITION_ENVELOPE",
          ),
          repositoryErrorStatus(e),
        );
      }
      throw e;
    }
  });

  const approveDecompositionProposalRoute = createRoute({
    method: "post",
    path: "/scopes/{scopeId}/decomposition-proposals/{proposalId}/approve",
    request: {
      params: z.object({
        scopeId: scopeIdParam,
        proposalId: z.string().min(1),
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              expected_scope_state_version: z.number().int().nonnegative(),
              envelope_hash: z.string().min(1),
              reason: z.string().min(1).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Approved",
        content: { "application/json": { schema: z.unknown() } },
      },
      400: {
        description: "Invalid approval",
        content: { "application/json": { schema: errorBody } },
      },
      403: {
        description: "Policy denied",
        content: { "application/json": { schema: errorBody } },
      },
      404: {
        description: "Proposal not found",
        content: { "application/json": { schema: errorBody } },
      },
      409: {
        description: "Version or stale-envelope conflict",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });
  app.openapi(approveDecompositionProposalRoute, async (c) => {
    const { scopeId, proposalId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = c.get("actor") as ActorId;
    const scope_id = scopeId as ScopeId;
    const r = await assertPolicy(
      deps.policyRepo,
      actor,
      "scope.decomposition_approve",
      scope_id,
    );
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "scope.decomposition_approve",
        scope_id,
        r.capability,
        r.reason,
        { proposal_id: proposalId },
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    try {
      const result = await deps.repo.approveDecompositionProposal(
        {
          scope_id,
          proposal_id: proposalId,
          expected_scope_state_version: body.expected_scope_state_version,
          envelope_hash: body.envelope_hash,
        },
        {
          actor,
          capability: r.capability,
          reason: body.reason ?? "human_spec_dag_approval",
        },
      );
      await projectScopeStateIfMirrored(deps, {
        scope: result.scope,
        actor,
        capability: r.capability,
      });
      return c.json(result, 200);
    } catch (e) {
      if (e instanceof RepositoryError) {
        return c.json(
          jsonError(
            e.code,
            e.message,
            e.details,
            e.code === "STATE_VERSION_MISMATCH",
          ),
          repositoryErrorStatus(e),
        );
      }
      throw e;
    }
  });

  const commitDecompositionProposalRoute = createRoute({
    method: "post",
    path: "/scopes/{scopeId}/decomposition-proposals/{proposalId}/commit",
    request: {
      params: z.object({
        scopeId: scopeIdParam,
        proposalId: z.string().min(1),
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              expected_scope_state_version: z.number().int().nonnegative(),
              envelope_hash: z.string().min(1),
              reason: z.string().min(1).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Committed",
        content: { "application/json": { schema: z.unknown() } },
      },
      400: {
        description: "Invalid commit",
        content: { "application/json": { schema: errorBody } },
      },
      403: {
        description: "Policy denied",
        content: { "application/json": { schema: errorBody } },
      },
      404: {
        description: "Proposal not found",
        content: { "application/json": { schema: errorBody } },
      },
      409: {
        description: "Version or stale-envelope conflict",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });
  app.openapi(commitDecompositionProposalRoute, async (c) => {
    const { scopeId, proposalId } = c.req.valid("param");
    const body = c.req.valid("json");
    const actor = c.get("actor") as ActorId;
    const scope_id = scopeId as ScopeId;
    const r = await assertPolicy(
      deps.policyRepo,
      actor,
      "scope.decomposition_commit",
      scope_id,
    );
    if (!r.allowed) {
      await auditPolicyDeny(
        deps.repo,
        actor,
        "scope.decomposition_commit",
        scope_id,
        r.capability,
        r.reason,
        { proposal_id: proposalId },
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }
    try {
      const result = await deps.repo.commitDecompositionProposal(
        {
          scope_id,
          proposal_id: proposalId,
          expected_scope_state_version: body.expected_scope_state_version,
          envelope_hash: body.envelope_hash,
        },
        {
          actor,
          capability: r.capability,
          reason: body.reason ?? "decomposition_commit",
        },
      );
      for (const task of result.tasks) {
        await mirrorTaskIfRequested(deps, {
          task,
          actor,
          capability: r.capability,
        });
      }
      await projectScopeStateIfMirrored(deps, {
        scope: result.scope,
        actor,
        capability: r.capability,
      });
      return c.json(result, 200);
    } catch (e) {
      if (e instanceof RepositoryError) {
        return c.json(
          jsonError(
            e.code,
            e.message,
            e.details,
            e.code === "STATE_VERSION_MISMATCH",
          ),
          repositoryErrorStatus(e),
        );
      }
      if (isPostgresUniqueViolation(e)) {
        return c.json(
          jsonError("CONFLICT", "DAG commit conflicts with existing rows"),
          409,
        );
      }
      throw e;
    }
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
              provider_project_id: z.string().min(1).optional(),
              provider_mirror: taskMirrorSchema.optional(),
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
      await mirrorTaskIfRequested(deps, {
        task: t,
        providerProjectId: body.provider_project_id,
        providerMirror: body.provider_mirror,
        actor,
        capability: r.capability,
      });
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
      if (e instanceof RepositoryError && e.code === "NOT_FOUND") {
        return c.json(jsonError("NOT_FOUND", e.message, e.details), 404);
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

  const scopeProviderSync = createRoute({
    method: "get",
    path: "/scopes/{scopeId}/provider-sync",
    request: { params: z.object({ scopeId: scopeIdParam }) },
    responses: {
      200: {
        description: "Provider mirror status for a scope and its tasks",
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
  app.openapi(scopeProviderSync, async (c) => {
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
        { subresource: "provider-sync" },
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
    const tasks = await deps.repo.listTasks(scopeId as ScopeId);
    const [scopeSync, ...taskSync] = await Promise.all([
      providerSyncItem(deps, {
        colony_id: scopeId,
        entity_kind: "scope",
      }),
      ...tasks.map((task) =>
        providerSyncItem(deps, {
          colony_id: task.id,
          entity_kind: "task",
        }),
      ),
    ]);
    return c.json({ scope: scopeSync, tasks: taskSync }, 200);
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

  const taskProviderSync = createRoute({
    method: "get",
    path: "/tasks/{taskId}/provider-sync",
    request: { params: z.object({ taskId: taskIdParam }) },
    responses: {
      200: {
        description: "Provider mirror status for one task",
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
  app.openapi(taskProviderSync, async (c) => {
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
        { taskId, subresource: "provider-sync" },
      );
      return c.json(
        jsonError("POLICY_DENY", r.reason, { capability: r.capability }),
        403,
      );
    }

    const item = await providerSyncItem(deps, {
      colony_id: taskId,
      entity_kind: "task",
    });
    return c.json(item, 200);
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
