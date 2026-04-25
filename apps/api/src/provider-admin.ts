import { createHash } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ActorId } from "@colony/domain";
import { PolicyRepository, TaskGraphRepository } from "@colony/db";
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
  bots: z
    .object({
      engine: botSpec.optional(),
      reviewer: botSpec.optional(),
    })
    .optional(),
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

export interface ProviderAdminDeps {
  readonly repo: TaskGraphRepository;
  readonly policyRepo: PolicyRepository;
  readonly adapter: ProviderAdapter;
}

let singleton: ProviderAdminDeps | undefined;

export function getProviderAdminDeps(): ProviderAdminDeps {
  if (!singleton) {
    const pool = getPool();
    singleton = {
      repo: new TaskGraphRepository(pool),
      policyRepo: new PolicyRepository(pool),
      adapter: new GitLabProviderAdapter({ baseUrl: env().GITLAB_BASE_URL }),
    };
  }
  return singleton;
}

export function registerProviderAdmin(
  app: OpenAPIHono<{ Variables: { actor: string } }>,
  deps: ProviderAdminDeps = getProviderAdminDeps(),
): void {
  const route = createRoute({
    method: "post",
    path: "/admin/provider/bootstrap",
    summary: "Provision or reconcile the GitLab provider environment",
    request: {
      headers: z.object({
        "X-Admin-Token": z.string().min(1),
      }),
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
    const adminToken = c.req.header("X-Admin-Token");
    if (!adminToken?.trim()) {
      return c.json(
        {
          error: {
            code: "MISSING_ADMIN_CREDENTIAL",
            message: "X-Admin-Token header is required",
          },
        },
        400,
      );
    }

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

    const admin_credential_hash = createHash("sha256")
      .update(adminToken)
      .digest("hex");
    try {
      const result = await deps.adapter.bootstrap(body, {
        kind: "admin_pat",
        token: adminToken,
      });
      const redacted = redactBootstrapResult(result);
      await deps.repo.withTransaction(async (tx) => {
        for (const action of redacted.actions) {
          await tx.writeAudit({
            actor,
            action: "provider.bootstrap.action",
            capability: decision.capability,
            target_kind: action.resource,
            target_id: action.provider_id,
            reason: "api",
            evidence: {
              admin_credential_hash,
              action,
              result: redacted,
            },
          });
        }
        await tx.writeAudit({
          actor,
          action: "provider.bootstrap",
          capability: decision.capability,
          target_kind: "provider_environment",
          target_id: `${body.provider}:${body.environment}`,
          reason: "api",
          evidence: {
            admin_credential_hash,
            result: redacted,
          },
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
          admin_credential_hash,
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
