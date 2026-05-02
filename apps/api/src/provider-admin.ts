import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createHash } from "node:crypto";
import type {
  ActorId,
  Capability,
  ProviderIdentity,
  Role,
} from "@colony/domain";
import {
  PolicyRepository,
  ProviderProjectRepository,
  TaskGraphRepository,
} from "@colony/db";
import { env } from "@colony/config";
import { evaluateAction } from "@colony/policy";
import {
  redactBootstrapResult,
  type ProviderAdapter,
  type ProviderBootstrapSpec,
} from "@colony/provider";
import { GitLabProviderAdapter } from "@colony/provider-gitlab";
import { getPool } from "./db.js";

const errorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

const botSpec = z.object({
  username: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  scopes: z.array(z.string().min(1)).min(1),
  role: z.string().optional(),
});

const bootstrapSpecSchema = z.object({
  provider: z.literal("gitlab").default("gitlab"),
  environment: z.string().min(1),
  base_url: z.string().url(),
  group: z.object({
    name: z.string().min(1),
    path: z.string().min(1),
    parent_id: z.string().optional(),
    visibility: z.enum(["private", "internal", "public"]).optional(),
  }),
  project: z.object({
    name: z.string().min(1),
    path: z.string().min(1),
    description: z.string().optional(),
    visibility: z.enum(["private", "internal", "public"]).optional(),
  }),
  bots: z.union([z.record(z.string(), botSpec), z.array(botSpec)]).optional(),
  oauth_application: z.object({
    name: z.string().min(1),
    redirect_uris: z.array(z.string().url()).min(1),
    scopes: z.array(z.string().min(1)).min(1),
    confidential: z.boolean().optional(),
  }),
  webhook: z.object({
    url: z.string().url(),
    secret: z.string().min(1).optional(),
    events: z.array(z.string().min(1)).optional(),
    enable_ssl_verification: z.boolean().optional(),
  }),
  rotate_tokens: z.boolean().optional(),
});

const registerExistingProjectSchema = z.object({
  provider: z.literal("gitlab").default("gitlab"),
  provider_id: z.string().min(1).optional(),
  path: z.string().min(1),
  default_branch: z.string().min(1).optional(),
  visibility: z.enum(["private", "internal", "public"]).optional(),
});

export interface ProviderAdminDeps {
  readonly repo: TaskGraphRepository;
  readonly providerProjects?: ProviderProjectRepository;
  readonly policyRepo: PolicyRepository;
  readonly adapter: ProviderAdapter;
}

let singleton: ProviderAdminDeps | undefined;

export function getProviderAdminDeps(): ProviderAdminDeps {
  if (!singleton) {
    const pool = getPool();
    singleton = {
      repo: new TaskGraphRepository(pool),
      providerProjects: new ProviderProjectRepository(pool),
      policyRepo: new PolicyRepository(pool),
      adapter: new GitLabProviderAdapter({
        baseUrl: env().GITLAB_BASE_URL,
        token: env().GITLAB_TOKEN,
      }),
    };
  }
  return singleton;
}

export function registerProviderAdmin(
  app: OpenAPIHono<{ Variables: { actor: string } }>,
  deps: ProviderAdminDeps = getProviderAdminDeps(),
): void {
  const listProjectsRoute = createRoute({
    method: "get",
    path: "/admin/provider/projects",
    summary: "List registered provider projects",
    responses: {
      200: {
        description: "Registered provider projects",
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

  app.openapi(listProjectsRoute, async (c) => {
    const actor = c.get("actor") as ActorId;
    const policy = await deps.policyRepo.getGlobalPolicy();
    const grants = await deps.policyRepo.getCapabilityGrantsForActor(
      actor,
      null,
    );
    const providerIdentity = await deps.policyRepo.getProviderIdentity(actor);
    const decision = evaluateAction("provider.bootstrap", {
      granted: grants,
      providerIdentity,
      effectivePolicy: policy,
    });
    if (!decision.allowed) {
      return c.json(
        {
          error: {
            code: "POLICY_DENY",
            message: decision.reason,
            details: { capability: decision.capability },
          },
        },
        403,
      );
    }
    return c.json(
      { items: await requireProviderProjectRepo(deps).listProjects() },
      200,
    );
  });

  const registerProjectRoute = createRoute({
    method: "post",
    path: "/admin/provider/projects",
    summary: "Register an existing provider project",
    request: {
      body: {
        content: {
          "application/json": {
            schema: registerExistingProjectSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Project registered",
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
        description: "Provider project not found",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });

  app.openapi(registerProjectRoute, async (c) => {
    const actor = c.get("actor") as ActorId;
    const body = c.req.valid("json");
    const policy = await deps.policyRepo.getGlobalPolicy();
    const grants = await deps.policyRepo.getCapabilityGrantsForActor(
      actor,
      null,
    );
    const providerIdentity = await deps.policyRepo.getProviderIdentity(actor);
    const decision = evaluateAction("provider.bootstrap", {
      granted: grants,
      providerIdentity,
      effectivePolicy: policy,
    });
    if (!decision.allowed) {
      return c.json(
        {
          error: {
            code: "POLICY_DENY",
            message: decision.reason,
            details: { capability: decision.capability },
          },
        },
        403,
      );
    }

    const providerProject =
      body.provider_id !== undefined
        ? await deps.adapter.projects.getById(body.provider_id)
        : await deps.adapter.projects.getByPath(body.path);
    if (!providerProject) {
      return c.json(
        {
          error: {
            code: "PROVIDER_PROJECT_NOT_FOUND",
            message: `provider project not found: ${body.provider_id ?? body.path}`,
          },
        },
        404,
      );
    }
    const project = await requireProviderProjectRepo(deps).upsertProject({
      provider: deps.adapter.provider,
      provider_id: providerProject.id,
      path: providerProject.path,
      default_branch: body.default_branch ?? providerProject.default_branch,
      visibility: body.visibility ?? providerProject.visibility,
      metadata: providerProject.metadata.raw ?? {},
    });
    await deps.repo.writeAudit({
      actor,
      action: "provider.project.register",
      capability: decision.capability,
      target_kind: "provider_project",
      target_id: project.id,
      reason: "api",
      evidence: {
        provider: project.provider,
        provider_id: project.provider_id,
        path: project.path,
      },
    });
    return c.json({ project }, 200);
  });

  const route = createRoute({
    method: "post",
    path: "/admin/provider/bootstrap",
    summary: "Provision or reconcile the GitLab provider environment",
    request: {
      body: {
        content: {
          "application/json": {
            schema: bootstrapSpecSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Bootstrap completed. Secrets are redacted in audit.",
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
      502: {
        description: "Provider error",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });

  app.openapi(route, async (c) => {
    const actor = c.get("actor") as ActorId;
    const body = c.req.valid("json") as ProviderBootstrapSpec;

    const policy = await deps.policyRepo.getGlobalPolicy();
    const grants = await deps.policyRepo.getCapabilityGrantsForActor(
      actor,
      null,
    );
    const providerIdentity = await deps.policyRepo.getProviderIdentity(actor);
    const decision = evaluateAction("provider.bootstrap", {
      granted: grants,
      providerIdentity,
      effectivePolicy: policy,
    });
    if (!decision.allowed) {
      await deps.repo.writeAudit({
        actor,
        action: "policy.deny",
        capability: decision.capability,
        reason: decision.reason,
        evidence: {
          attempted_action: "provider.bootstrap",
          provider: body.provider,
          environment: body.environment,
        },
      });
      return c.json(
        {
          error: {
            code: "POLICY_DENY",
            message: decision.reason,
            details: { capability: decision.capability },
          },
        },
        403,
      );
    }

    try {
      const result = await deps.adapter.bootstrap(body);
      const redacted = redactBootstrapResult(result);
      const identityWrites: ProviderIdentity[] = [];
      for (const [botKey, user] of Object.entries(result.bot_users)) {
        const role = botRole(botKey);
        const botActor = `bot:${botKey}` as ActorId;
        const identity = await deps.policyRepo.upsertProviderIdentity({
          actor: botActor,
          provider: result.provider,
          provider_user_id: user.id,
          provider_username: user.username,
          role,
          is_bot: true,
          token_fingerprint: fingerprint(result.bot_tokens[botKey] ?? ""),
          allowed_namespaces: [],
        });
        await deps.policyRepo.grantCapabilitiesForActor({
          actor: botActor,
          role,
          capabilities: botCapabilities(botKey),
          granted_by: actor,
        });
        identityWrites.push(identity);
      }
      await deps.repo.withTransaction(async (tx) => {
        for (const action of redacted.actions) {
          await tx.writeAudit({
            actor,
            action: "provider.bootstrap.action",
            capability: decision.capability,
            target_kind: action.resource,
            target_id: action.provider_id,
            reason: "api",
            evidence: { action, result: redacted },
          });
        }
        for (const identity of identityWrites) {
          await tx.writeAudit({
            actor,
            action: "provider.bootstrap.identity",
            capability: decision.capability,
            target_kind: "provider_identity",
            target_id: `${identity.provider}:${identity.actor}`,
            reason: "api",
            evidence: { identity },
          });
        }
        await tx.writeAudit({
          actor,
          action: "provider.bootstrap",
          capability: decision.capability,
          target_kind: "provider_environment",
          target_id: `${body.provider}:${body.environment}`,
          reason: "api",
          evidence: { result: redacted },
        });
      });
      return c.json(redacted, 200);
    } catch (e) {
      await deps.repo.writeAudit({
        actor,
        action: "provider.bootstrap_failed",
        capability: decision.capability,
        target_kind: "provider_environment",
        target_id: `${body.provider}:${body.environment}`,
        reason: "api",
        evidence: {
          error: e instanceof Error ? e.message : String(e),
        },
      });
      return c.json(
        {
          error: {
            code: "PROVIDER_BOOTSTRAP_FAILED",
            message: e instanceof Error ? e.message : String(e),
          },
        },
        502,
      );
    }
  });
}

function requireProviderProjectRepo(
  deps: ProviderAdminDeps,
): ProviderProjectRepository {
  if (!deps.providerProjects) {
    throw new Error("provider project repository is not configured");
  }
  return deps.providerProjects;
}

function fingerprint(token: string): string {
  if (!token) return "";
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function botRole(botKey: string): Role {
  if (botKey === "engine") return "developer";
  if (botKey === "reviewer") return "reviewer";
  if (botKey === "architect") return "architect";
  if (botKey === "integrator") return "integrator";
  if (botKey === "memory_consolidator") return "memory_consolidator";
  if (botKey === "supervisor") return "supervisor";
  return "developer";
}

function botCapabilities(botKey: string): Capability[] {
  switch (botKey) {
    case "engine":
      return [
        "provider.issues.create",
        "provider.issues.update",
        "provider.issues.comment",
        "provider.mr.open",
        "provider.branches.push",
        "provider.commits.read",
      ];
    case "reviewer":
      return [
        "provider.issues.comment",
        "provider.mr.approve",
        "provider.mr.comment",
        "provider.mr.review_thread",
      ];
    case "architect":
      return [
        "graph.write",
        "provider.issues.create",
        "provider.epics.create",
        "provider.epics.update",
        "provider.epics.close",
      ];
    case "integrator":
      return [
        "provider.mr.merge",
        "provider.branches.protect",
        "provider.pipelines.read",
        "provider.pipelines.trigger",
      ];
    case "memory_consolidator":
      return [
        "provider.issues.update",
        "provider.issues.addLabel",
        "provider.issues.removeLabel",
      ];
    case "supervisor":
      return ["graph.write", "audit.write"];
    default:
      return [];
  }
}
