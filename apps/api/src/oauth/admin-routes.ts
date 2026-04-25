import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type {
  OAuthCredentialRepository,
  OAuthConnectionMetadata,
} from "@colony/db";
import type { ColonyConfig } from "@colony/config";
import type { ActorId, Capability } from "@colony/domain";
import { evaluate } from "@colony/policy";
import type { PolicyRepository, TaskGraphRepository } from "@colony/db";
import { OAuthSessionManager, OAuthSessionError } from "./session-manager.js";
import type { OAuthDriver } from "./types.js";

interface ActorCheck {
  readonly actor: ActorId;
  readonly capability: Capability;
}

interface ActorCheckDeny {
  readonly reason: string;
  readonly capability: Capability;
}

/**
 * COL-2.14c — admin OAuth flow for Codex / Claude Pro.
 *
 * Endpoints:
 *   GET    /admin/providers                                     list (oauth providers + status)
 *   POST   /admin/providers/:key/oauth/start                    begin a session, return authorize URL
 *   POST   /admin/providers/:key/oauth/submit-code              exchange code → tokens, persist
 *   POST   /admin/providers/:key/oauth/cancel                   abandon a session
 *   DELETE /admin/providers/:key/oauth/connection               revoke an active connection
 *
 * Capability: every mutating route requires `provider.oauth.connect`.
 * Sessions are process-local (OAuthSessionManager) and TTL'd.
 */

const errorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

const providerListResponse = z.object({
  providers: z.array(
    z.object({
      key: z.string(),
      api: z.string(),
      subscription: z.string().optional(),
      models: z.array(z.object({ id: z.string(), name: z.string() })),
      connection: z
        .object({
          id: z.string(),
          status: z.enum(["active", "expired", "revoked"]),
          granted_by: z.string(),
          granted_at: z.string(),
          refreshed_at: z.string().nullable(),
          expires_at: z.string().nullable(),
          revoked_at: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
});

const beginRequestSchema = z.object({}).strict();

const beginResponseSchema = z.object({
  session_id: z.string(),
  authorize_url: z.string(),
  instructions: z.string().optional(),
  expires_at: z.string(),
});

const submitRequestSchema = z
  .object({
    session_id: z.string().min(1),
    code: z.string().min(1),
  })
  .strict();

const submitResponseSchema = z.object({
  provider_key: z.string(),
  status: z.literal("active"),
  granted_at: z.string(),
  expires_at: z.string().nullable(),
});

const cancelRequestSchema = z
  .object({ session_id: z.string().min(1) })
  .strict();

const cancelResponseSchema = z.object({ canceled: z.boolean() });

const revokeResponseSchema = z.object({
  provider_key: z.string(),
  status: z.literal("revoked"),
});

export interface OAuthAdminDeps {
  readonly config: ColonyConfig;
  readonly oauthRepo: OAuthCredentialRepository;
  readonly sessionManager: OAuthSessionManager;
  readonly policyRepo: PolicyRepository;
  readonly auditRepo: TaskGraphRepository;
}

export function createOAuthSessionManager(driver: OAuthDriver) {
  return new OAuthSessionManager(driver);
}

export function registerOAuthAdmin(
  app: OpenAPIHono<{ Variables: { actor: string } }>,
  deps: OAuthAdminDeps,
): void {
  const checkOAuthCap = async (
    actorId: string,
  ): Promise<
    { ok: true; check: ActorCheck } | { ok: false; deny: ActorCheckDeny }
  > => {
    const actor = actorId as ActorId;
    const grants = await deps.policyRepo.getCapabilityGrantsForActor(
      actor,
      null,
    );
    const identity = await deps.policyRepo.getProviderIdentity(actor);
    const decision = evaluate({
      action: "task.claim",
      requiredCapability: "provider.oauth.connect",
      granted: grants,
      providerIdentity: identity,
      effectivePolicy: null,
    });
    if (!decision.allowed) {
      await deps.auditRepo.writeAudit({
        actor,
        action: "policy.deny",
        capability: decision.capability,
        reason: decision.reason,
        evidence: { attempted_action: "provider.oauth.connect" },
      });
      return {
        ok: false,
        deny: {
          reason: decision.reason,
          capability: decision.capability,
        },
      };
    }
    return {
      ok: true,
      check: { actor, capability: decision.capability },
    };
  };

  // ---------- GET /admin/providers ----------

  const listRoute = createRoute({
    method: "get",
    path: "/admin/providers",
    summary:
      "List OAuth-capable provider entries with current connection status",
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: providerListResponse } },
      },
      403: {
        description: "Capability denied",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });

  app.openapi(listRoute, async (c) => {
    const cap = await checkOAuthCap(c.get("actor"));
    if (!cap.ok) {
      return c.json(
        {
          error: {
            code: "POLICY_DENY",
            message: cap.deny.reason,
            details: { capability: cap.deny.capability },
          },
        },
        403,
      );
    }
    const connections = await deps.oauthRepo.listConnectionMetadata();
    const byProviderKey = new Map<string, OAuthConnectionMetadata>();
    for (const conn of connections) byProviderKey.set(conn.providerKey, conn);
    const providers = deps.config.oauthProviderKeys.map((key) => {
      const provider = deps.config.getProvider(key);
      const conn = byProviderKey.get(key) ?? null;
      return {
        key,
        api: provider?.api ?? "unknown",
        subscription:
          provider?.auth.kind === "oauth"
            ? provider.auth.subscription
            : undefined,
        models:
          provider?.models?.map((m) => ({ id: m.id, name: m.name })) ?? [],
        connection: conn
          ? {
              id: conn.id,
              status: conn.status,
              granted_by: conn.grantedBy,
              granted_at: conn.grantedAt,
              refreshed_at: conn.refreshedAt,
              expires_at: conn.expiresAt,
              revoked_at: conn.revokedAt,
            }
          : null,
      };
    });
    return c.json({ providers }, 200);
  });

  // ---------- POST /admin/providers/:key/oauth/start ----------

  const beginRoute = createRoute({
    method: "post",
    path: "/admin/providers/{key}/oauth/start",
    summary: "Begin an OAuth session for an oauth-kind provider",
    request: {
      params: z.object({ key: z.string().min(1) }),
      body: {
        content: {
          "application/json": { schema: beginRequestSchema },
        },
      },
    },
    responses: {
      200: {
        description: "Session created",
        content: { "application/json": { schema: beginResponseSchema } },
      },
      400: {
        description: "Invalid provider",
        content: { "application/json": { schema: errorBody } },
      },
      403: {
        description: "Capability denied",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });

  app.openapi(beginRoute, async (c) => {
    const cap = await checkOAuthCap(c.get("actor"));
    if (!cap.ok) {
      return c.json(
        {
          error: {
            code: "POLICY_DENY",
            message: cap.deny.reason,
            details: { capability: cap.deny.capability },
          },
        },
        403,
      );
    }
    const { key } = c.req.valid("param");
    const provider = deps.config.getProvider(key);
    if (!provider || provider.auth.kind !== "oauth") {
      return c.json(
        {
          error: {
            code: "PROVIDER_NOT_OAUTH",
            message: `provider ${key} is not configured as oauth`,
          },
        },
        400,
      );
    }
    try {
      const session = await deps.sessionManager.begin({
        providerKey: key,
        providerApi: provider.api,
        initiator: cap.check.actor,
      });
      await deps.auditRepo.writeAudit({
        actor: cap.check.actor,
        action: "provider.oauth.start",
        capability: cap.check.capability,
        target_kind: "oauth_session",
        target_id: session.sessionId,
        reason: "admin_api",
        evidence: { provider_key: key, expires_at: session.expiresAt },
      });
      return c.json(
        {
          session_id: session.sessionId,
          authorize_url: session.authorizeUrl,
          instructions: session.instructions,
          expires_at: session.expiresAt,
        },
        200,
      );
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return c.json(
        {
          error: { code: "OAUTH_BEGIN_FAILED", message: reason },
        },
        400,
      );
    }
  });

  // ---------- POST /admin/providers/:key/oauth/submit-code ----------

  const submitRoute = createRoute({
    method: "post",
    path: "/admin/providers/{key}/oauth/submit-code",
    summary: "Exchange the operator-supplied code for tokens and persist",
    request: {
      params: z.object({ key: z.string().min(1) }),
      body: {
        content: { "application/json": { schema: submitRequestSchema } },
      },
    },
    responses: {
      200: {
        description: "Connection persisted",
        content: { "application/json": { schema: submitResponseSchema } },
      },
      400: {
        description: "Invalid session or driver failure",
        content: { "application/json": { schema: errorBody } },
      },
      403: {
        description: "Capability denied",
        content: { "application/json": { schema: errorBody } },
      },
      404: {
        description: "Session not found",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });

  app.openapi(submitRoute, async (c) => {
    const cap = await checkOAuthCap(c.get("actor"));
    if (!cap.ok) {
      return c.json(
        {
          error: {
            code: "POLICY_DENY",
            message: cap.deny.reason,
            details: { capability: cap.deny.capability },
          },
        },
        403,
      );
    }
    const { key } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const result = await deps.sessionManager.submit({
        sessionId: body.session_id,
        initiator: cap.check.actor,
        code: body.code,
      });
      if (result.providerKey !== key) {
        return c.json(
          {
            error: {
              code: "PROVIDER_MISMATCH",
              message: `session ${body.session_id} is for provider ${result.providerKey}, not ${key}`,
            },
          },
          400,
        );
      }
      const meta = await deps.oauthRepo.upsertConnection({
        providerKey: result.providerKey,
        providerApi: result.providerApi as never,
        payload: result.credentials,
        grantedBy: cap.check.actor,
        expiresAt: result.credentials.expires
          ? new Date(result.credentials.expires)
          : null,
      });
      await deps.auditRepo.writeAudit({
        actor: cap.check.actor,
        action: "provider.oauth.connected",
        capability: cap.check.capability,
        target_kind: "provider_oauth_connection",
        target_id: meta.id,
        reason: "admin_api",
        evidence: {
          provider_key: meta.providerKey,
          provider_api: meta.providerApi,
          expires_at: meta.expiresAt,
        },
      });
      return c.json(
        {
          provider_key: meta.providerKey,
          status: "active" as const,
          granted_at: meta.grantedAt,
          expires_at: meta.expiresAt,
        },
        200,
      );
    } catch (e) {
      if (e instanceof OAuthSessionError) {
        const status =
          e.code === "NOT_FOUND" ? 404 : e.code === "FORBIDDEN" ? 403 : 400;
        return c.json({ error: { code: e.code, message: e.message } }, status);
      }
      const reason = e instanceof Error ? e.message : String(e);
      return c.json(
        { error: { code: "OAUTH_EXCHANGE_FAILED", message: reason } },
        400,
      );
    }
  });

  // ---------- POST /admin/providers/:key/oauth/cancel ----------

  const cancelRoute = createRoute({
    method: "post",
    path: "/admin/providers/{key}/oauth/cancel",
    summary: "Cancel an in-flight OAuth session",
    request: {
      params: z.object({ key: z.string().min(1) }),
      body: {
        content: { "application/json": { schema: cancelRequestSchema } },
      },
    },
    responses: {
      200: {
        description: "Session canceled (or already gone)",
        content: { "application/json": { schema: cancelResponseSchema } },
      },
      403: {
        description: "Capability denied",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });

  app.openapi(cancelRoute, async (c) => {
    const cap = await checkOAuthCap(c.get("actor"));
    if (!cap.ok) {
      return c.json(
        {
          error: {
            code: "POLICY_DENY",
            message: cap.deny.reason,
            details: { capability: cap.deny.capability },
          },
        },
        403,
      );
    }
    const body = c.req.valid("json");
    try {
      await deps.sessionManager.cancel({
        sessionId: body.session_id,
        initiator: cap.check.actor,
      });
      return c.json({ canceled: true }, 200);
    } catch (e) {
      if (e instanceof OAuthSessionError && e.code === "FORBIDDEN") {
        return c.json(
          { error: { code: "FORBIDDEN", message: e.message } },
          403,
        );
      }
      throw e;
    }
  });

  // ---------- DELETE /admin/providers/:key/oauth/connection ----------

  const revokeRoute = createRoute({
    method: "delete",
    path: "/admin/providers/{key}/oauth/connection",
    summary: "Revoke the active OAuth connection for a provider",
    request: { params: z.object({ key: z.string().min(1) }) },
    responses: {
      200: {
        description: "Connection revoked",
        content: { "application/json": { schema: revokeResponseSchema } },
      },
      403: {
        description: "Capability denied",
        content: { "application/json": { schema: errorBody } },
      },
      404: {
        description: "No connection to revoke",
        content: { "application/json": { schema: errorBody } },
      },
    },
  });

  app.openapi(revokeRoute, async (c) => {
    const cap = await checkOAuthCap(c.get("actor"));
    if (!cap.ok) {
      return c.json(
        {
          error: {
            code: "POLICY_DENY",
            message: cap.deny.reason,
            details: { capability: cap.deny.capability },
          },
        },
        403,
      );
    }
    const { key } = c.req.valid("param");
    const meta = await deps.oauthRepo.revokeConnection(key);
    if (!meta) {
      return c.json(
        {
          error: {
            code: "NO_ACTIVE_CONNECTION",
            message: `no active oauth connection for provider ${key}`,
          },
        },
        404,
      );
    }
    await deps.auditRepo.writeAudit({
      actor: cap.check.actor,
      action: "provider.oauth.revoked",
      capability: cap.check.capability,
      target_kind: "provider_oauth_connection",
      target_id: meta.id,
      reason: "admin_api",
      evidence: {
        provider_key: meta.providerKey,
        revoked_at: meta.revokedAt,
      },
    });
    return c.json(
      { provider_key: meta.providerKey, status: "revoked" as const },
      200,
    );
  });
}

// Re-export so callers can keep capability list in sync.
export const REQUIRED_OAUTH_CAP: Capability = "provider.oauth.connect";
