import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import type { ActorId, Capability, ProviderIdentity } from "@colony/domain";

const healthResponse = z.object({
  ok: z.literal(true),
  service: z.literal("colony-tool-gateway"),
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  summary: "Liveness",
  responses: {
    200: {
      description: "Service healthy.",
      content: { "application/json": { schema: healthResponse } },
    },
  },
});

const providerCredentialRequest = z.object({
  actor: z.string().min(1),
  capability: z.string().min(1),
  provider: z.string().default("gitlab"),
  project: z
    .object({
      id: z.string().min(1),
      path: z.string().min(1).optional(),
    })
    .optional(),
});

const providerCredentialResponse = z.object({
  provider: z.string(),
  bot_actor: z.string(),
  provider_user_id: z.string(),
  provider_username: z.string().optional(),
  token: z.string(),
});

export interface ToolGatewayDeps {
  readonly resolveIdentity: (
    actor: ActorId,
    provider: string,
  ) => Promise<ProviderIdentity | null>;
  readonly tokenForRole: (role: string) => string | undefined;
}

export function buildApp(deps?: ToolGatewayDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(healthRoute, (c) =>
    c.json({ ok: true as const, service: "colony-tool-gateway" as const }),
  );

  const credentialRoute = createRoute({
    method: "post",
    path: "/internal/provider/credential",
    summary:
      "Resolve the provider bot credential for a capability-checked call",
    request: {
      body: {
        content: { "application/json": { schema: providerCredentialRequest } },
      },
    },
    responses: {
      200: {
        description: "Provider credential selected.",
        content: { "application/json": { schema: providerCredentialResponse } },
      },
      403: {
        description: "Capability or namespace denied.",
        content: { "application/json": { schema: z.unknown() } },
      },
      404: {
        description: "No provider identity or token found.",
        content: { "application/json": { schema: z.unknown() } },
      },
    },
  });

  app.openapi(credentialRoute, async (c) => {
    if (!deps) {
      return c.json({ error: { code: "NOT_CONFIGURED" } }, 404);
    }
    const input = c.req.valid("json");
    const identity = await deps.resolveIdentity(
      input.actor as ActorId,
      input.provider,
    );
    const resolved = resolveProviderCredential({
      identity,
      capability: input.capability as Capability,
      projectPath: input.project?.path,
      tokenForRole: deps.tokenForRole,
    });
    if (!resolved.allowed) {
      return c.json(
        { error: { code: resolved.reason, message: resolved.reason } },
        resolved.reason === "missing_identity" ||
          resolved.reason === "missing_token"
          ? 404
          : 403,
      );
    }
    return c.json(resolved.credential, 200);
  });

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Colony Tool Gateway", version: "0.0.0" },
  });

  app.get(
    "/docs",
    Scalar({ url: "/openapi.json", pageTitle: "Colony Tool Gateway" }),
  );

  return app;
}

export type ProviderCredentialResolution =
  | {
      readonly allowed: true;
      readonly credential: {
        readonly provider: string;
        readonly bot_actor: string;
        readonly provider_user_id: string;
        readonly provider_username?: string;
        readonly token: string;
      };
    }
  | {
      readonly allowed: false;
      readonly reason:
        | "missing_identity"
        | "missing_capability"
        | "namespace_denied"
        | "missing_token";
    };

export function resolveProviderCredential(input: {
  readonly identity: ProviderIdentity | null;
  readonly capability: Capability;
  readonly projectPath?: string;
  readonly tokenForRole: (role: string) => string | undefined;
}): ProviderCredentialResolution {
  if (!input.identity || input.identity.disabled_at) {
    return { allowed: false, reason: "missing_identity" };
  }
  if (!roleAllowsCapability(input.identity.role, input.capability)) {
    return { allowed: false, reason: "missing_capability" };
  }
  const projectPath = input.projectPath;
  if (
    projectPath &&
    input.identity.allowed_namespaces.length > 0 &&
    !input.identity.allowed_namespaces.some(
      (ns) => projectPath === ns || projectPath.startsWith(`${ns}/`),
    )
  ) {
    return { allowed: false, reason: "namespace_denied" };
  }
  const roleKey = input.identity.actor.startsWith("bot:")
    ? input.identity.actor.slice("bot:".length)
    : input.identity.role;
  const token = input.tokenForRole(roleKey);
  if (!token) return { allowed: false, reason: "missing_token" };
  return {
    allowed: true,
    credential: {
      provider: input.identity.provider,
      bot_actor: input.identity.actor,
      provider_user_id: input.identity.provider_user_id,
      provider_username: input.identity.provider_username,
      token,
    },
  };
}

function roleAllowsCapability(role: string, capability: Capability): boolean {
  if (role === "integrator") {
    return [
      "provider.mr.merge",
      "provider.branches.protect",
      "provider.pipelines.read",
      "provider.pipelines.trigger",
    ].includes(capability);
  }
  if (role === "reviewer") {
    return [
      "provider.issues.comment",
      "provider.mr.approve",
      "provider.mr.comment",
      "provider.mr.review_thread",
    ].includes(capability);
  }
  if (role === "developer") {
    return [
      "provider.issues.create",
      "provider.issues.update",
      "provider.issues.comment",
      "provider.mr.open",
      "provider.branches.push",
      "provider.commits.read",
    ].includes(capability);
  }
  if (role === "architect") {
    return [
      "graph.write",
      "provider.issues.create",
      "provider.epics.create",
      "provider.epics.update",
      "provider.epics.close",
    ].includes(capability);
  }
  if (role === "memory_consolidator") {
    return [
      "provider.issues.update",
      "provider.issues.addLabel",
      "provider.issues.removeLabel",
    ].includes(capability);
  }
  if (role === "supervisor") {
    return capability === "graph.write" || capability === "audit.write";
  }
  return false;
}
