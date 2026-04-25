import { timingSafeEqual } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Connection, Client as TemporalClient } from "@temporalio/client";
import { env } from "@colony/config";
import { createPool, IdempotencyRepository, type Pool } from "@colony/db";
import { isScopeId, isTaskId } from "@colony/domain";
import {
  supervisorWorkflowId,
  type ProviderEventSignal,
  type ScopeId,
} from "@colony/workflows";

const WEBHOOK_DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60;

const healthResponse = z.object({
  ok: z.literal(true),
  service: z.literal("colony-webhook-dispatcher"),
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

const webhookAckResponse = z.object({
  accepted: z.boolean(),
  duplicate: z.boolean().optional(),
  classified_as: z.string().optional(),
  event_kind: z.string().optional(),
  event_uuid: z.string().optional(),
  workflow_id: z.string().optional(),
});

const webhookErrorResponse = z.object({
  accepted: z.literal(false),
  error: z.string(),
});

const gitlabWebhookRoute = createRoute({
  method: "post",
  path: "/webhook/gitlab",
  summary: "GitLab webhook ingress",
  responses: {
    200: {
      description: "Accepted.",
      content: { "application/json": { schema: webhookAckResponse } },
    },
    400: {
      description: "Malformed or unclassifiable webhook.",
      content: { "application/json": { schema: webhookErrorResponse } },
    },
    401: {
      description: "Missing or invalid X-Gitlab-Token.",
      content: { "application/json": { schema: webhookErrorResponse } },
    },
  },
});

export interface SignatureVerificationInput {
  readonly provider: "gitlab";
  readonly headers: Headers;
  readonly raw_body: string;
}

export interface WebhookSignatureVerifier {
  readonly verify: (
    input: SignatureVerificationInput,
  ) => boolean | Promise<boolean>;
}

export interface WebhookDedupStore {
  readonly tryClaimWebhookEvent: (input: {
    readonly provider: string;
    readonly event_id: string;
    readonly object_id: string;
    readonly ttl_seconds: number;
  }) => Promise<boolean>;
}

export interface SupervisorSignalDispatcher {
  readonly signalProviderEvent: (
    scope_id: ScopeId,
    signal: ProviderEventSignal,
  ) => Promise<{ readonly workflow_id: string }>;
}

export interface WebhookDispatcherDeps {
  readonly verifier: WebhookSignatureVerifier;
  readonly dedup: WebhookDedupStore;
  readonly supervisor: SupervisorSignalDispatcher;
}

interface GitLabWebhookBody {
  readonly scope_id?: unknown;
  readonly task_id?: unknown;
  readonly event_id?: unknown;
  readonly event_type?: unknown;
  readonly object_kind?: unknown;
  readonly object_id?: unknown;
  readonly actor?: unknown;
  readonly occurred_at?: unknown;
  readonly attributes?: unknown;
  readonly object_attributes?: unknown;
  readonly user?: unknown;
  readonly project?: unknown;
  readonly project_id?: unknown;
}

export type ClassifiedGitLabWebhook =
  | {
      readonly kind: "provider_event";
      readonly scope_id: ScopeId;
      readonly event_id: string;
      readonly object_id: string;
      readonly signal: ProviderEventSignal;
    }
  | {
      readonly kind: "noop";
      readonly reason: string;
      readonly event_id: string;
      readonly object_id: string;
    };

class GitLabTokenVerifier implements WebhookSignatureVerifier {
  constructor(private readonly expectedToken: string) {}

  verify(input: SignatureVerificationInput): boolean {
    const provided = input.headers.get("X-Gitlab-Token") ?? undefined;
    return tokenMatches(provided, this.expectedToken);
  }
}

class TemporalSupervisorSignalDispatcher implements SupervisorSignalDispatcher {
  private client: TemporalClient | undefined;

  async signalProviderEvent(
    scope_id: ScopeId,
    signal: ProviderEventSignal,
  ): Promise<{ readonly workflow_id: string }> {
    const cfg = env();
    if (!this.client) {
      const connection = await Connection.connect({
        address: cfg.TEMPORAL_ADDRESS,
      });
      this.client = new TemporalClient({
        connection,
        namespace: cfg.TEMPORAL_NAMESPACE,
      });
    }

    const workflow_id = supervisorWorkflowId(scope_id);
    await this.client.workflow.signalWithStart("scopeSupervisorWorkflow", {
      workflowId: workflow_id,
      taskQueue: cfg.TEMPORAL_TASK_QUEUE,
      args: [scope_id],
      signal: "providerEvent",
      signalArgs: [signal],
    });
    return { workflow_id };
  }
}

let pool: Pool | undefined;
let deps: WebhookDispatcherDeps | undefined;

function getDefaultDeps(): WebhookDispatcherDeps {
  if (!deps) {
    const cfg = env();
    pool = createPool({
      connectionString: cfg.DATABASE_URL,
      role: "colony_writer",
    });
    deps = {
      verifier: new GitLabTokenVerifier(cfg.GITLAB_WEBHOOK_SECRET),
      dedup: new IdempotencyRepository(pool),
      supervisor: new TemporalSupervisorSignalDispatcher(),
    };
  }
  return deps;
}

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const s = asString(value);
    if (s) return s;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function scalarAttributes(
  ...records: Array<Record<string, unknown> | undefined>
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const record of records) {
    if (!record) continue;
    for (const [key, value] of Object.entries(record)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        out[key] = value;
      }
    }
  }
  return out;
}

export function classifyGitLabWebhook(input: {
  readonly headers: Headers;
  readonly body: GitLabWebhookBody;
}): ClassifiedGitLabWebhook {
  const eventKind =
    input.headers.get("X-Gitlab-Event") ?? "unknown-gitlab-event";
  const eventId = firstString(
    input.headers.get("X-Gitlab-Event-UUID"),
    input.body.event_id,
  );
  const objectAttributes = asRecord(input.body.object_attributes);
  const project = asRecord(input.body.project);
  const attributes = asRecord(input.body.attributes);
  const user = asRecord(input.body.user);
  const objectKind = firstString(
    input.body.object_kind,
    objectAttributes?.object_kind,
    eventKind,
  );
  const objectId = firstString(
    input.body.object_id,
    objectAttributes?.id,
    objectAttributes?.iid,
    input.body.project_id,
    project?.id,
    eventId,
  );

  if (!eventId || !objectId) {
    return {
      kind: "noop",
      reason: "missing_event_or_object_id",
      event_id: eventId ?? "missing",
      object_id: objectId ?? "missing",
    };
  }

  const scopeId = firstString(
    input.body.scope_id,
    objectAttributes?.scope_id,
    objectAttributes?.colony_scope_id,
  );
  if (!scopeId || !isScopeId(scopeId)) {
    return {
      kind: "noop",
      reason: "missing_scope_id",
      event_id: eventId,
      object_id: objectId,
    };
  }

  const taskId = firstString(input.body.task_id, objectAttributes?.task_id);
  const actor = firstString(input.body.actor, user?.username, user?.name);
  const occurredAt = firstString(
    input.body.occurred_at,
    objectAttributes?.updated_at,
    objectAttributes?.created_at,
  );
  const signal: ProviderEventSignal = {
    provider: "gitlab",
    event_type: firstString(input.body.event_type, eventKind) ?? eventKind,
    event_id: eventId,
    object_kind: objectKind ?? "unknown",
    object_id: objectId,
    ...(taskId && isTaskId(taskId) ? { task_id: taskId } : {}),
    ...(actor ? { actor } : {}),
    ...(occurredAt ? { occurred_at: occurredAt } : {}),
    reference: {
      provider: "gitlab",
      object_kind: objectKind,
      object_id: objectId,
      event_id: eventId,
      uri: firstString(
        objectAttributes?.url,
        objectAttributes?.web_url,
        project?.web_url,
      ),
    },
    attributes: scalarAttributes(attributes, objectAttributes),
  };

  return {
    kind: "provider_event",
    scope_id: scopeId,
    event_id: eventId,
    object_id: objectId,
    signal,
  };
}

export function buildApp(
  overrides: Partial<WebhookDispatcherDeps> = {},
): OpenAPIHono {
  const app = new OpenAPIHono();
  const runtimeDeps = (): WebhookDispatcherDeps => {
    if (overrides.verifier && overrides.dedup && overrides.supervisor) {
      return overrides as WebhookDispatcherDeps;
    }
    const defaults = getDefaultDeps();
    return {
      verifier: overrides.verifier ?? defaults.verifier,
      dedup: overrides.dedup ?? defaults.dedup,
      supervisor: overrides.supervisor ?? defaults.supervisor,
    };
  };

  app.openapi(healthRoute, (c) =>
    c.json({
      ok: true as const,
      service: "colony-webhook-dispatcher" as const,
    }),
  );

  app.openapi(gitlabWebhookRoute, async (c) => {
    const rawBody = await c.req.raw.clone().text();
    const depsForRequest = runtimeDeps();
    const verified = await depsForRequest.verifier.verify({
      provider: "gitlab",
      headers: c.req.raw.headers,
      raw_body: rawBody,
    });

    if (!verified) {
      return c.json(
        {
          accepted: false as const,
          error: "invalid or missing X-Gitlab-Token",
        },
        401,
      );
    }

    let body: GitLabWebhookBody;
    try {
      body = JSON.parse(rawBody || "{}") as GitLabWebhookBody;
    } catch {
      return c.json(
        {
          accepted: false as const,
          error: "invalid_json",
        },
        400,
      );
    }
    const classified = classifyGitLabWebhook({
      headers: c.req.raw.headers,
      body,
    });

    if (classified.kind === "noop") {
      return c.json(
        {
          accepted: false as const,
          error: classified.reason,
        },
        400,
      );
    }

    const claimed = await depsForRequest.dedup.tryClaimWebhookEvent({
      provider: "gitlab",
      event_id: classified.event_id,
      object_id: classified.object_id,
      ttl_seconds: WEBHOOK_DEDUP_TTL_SECONDS,
    });
    if (!claimed) {
      return c.json(
        {
          accepted: true,
          duplicate: true,
          classified_as: classified.kind,
          event_kind: classified.signal.event_type,
          event_uuid: classified.event_id,
        },
        200,
      );
    }

    const signalResult = await depsForRequest.supervisor.signalProviderEvent(
      classified.scope_id,
      classified.signal,
    );

    return c.json(
      {
        accepted: true,
        duplicate: false,
        classified_as: classified.kind,
        event_kind: classified.signal.event_type,
        event_uuid: classified.event_id,
        workflow_id: signalResult.workflow_id,
      },
      200,
    );
  });

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Colony Webhook Dispatcher", version: "0.0.0" },
  });

  return app;
}
