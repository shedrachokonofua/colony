import { timingSafeEqual } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Connection, Client as TemporalClient } from "@temporalio/client";
import { env } from "@colony/config";
import { createPool, IdempotencyRepository, type Pool } from "@colony/db";
import { isScopeId, isTaskId } from "@colony/domain";
import {
  parseProviderCommand,
  type ProviderCommand,
  type ProviderCommandParseResult,
  type ProviderCommandSource,
} from "@colony/provider";
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

export type GitLabWebhookClassification =
  | "valid_command"
  | "context_update"
  | "review_feedback"
  | "approval"
  | "conflict"
  | "noop"
  | "needs_clarification";

export type ClassifiedGitLabWebhook =
  | {
      readonly kind: Exclude<GitLabWebhookClassification, "noop">;
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
      const tls =
        cfg.TEMPORAL_TLS_SERVER_NAME !== undefined
          ? { serverNameOverride: cfg.TEMPORAL_TLS_SERVER_NAME }
          : cfg.TEMPORAL_TLS;
      const connection = await Connection.connect({
        address: cfg.TEMPORAL_ADDRESS,
        tls,
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

function lower(s: string | undefined): string {
  return s?.toLowerCase() ?? "";
}

function commandAttributes(command: ProviderCommand): Record<string, string> {
  switch (command.kind) {
    case "approve":
    case "unblock":
      return { command_kind: command.kind };
    case "changes":
      return { command_kind: command.kind, command_prose: command.prose };
    case "review":
      return { command_kind: command.kind, command_target: command.target };
    case "block":
    case "override":
      return { command_kind: command.kind, command_reason: command.reason };
  }
}

function commentBody(
  objectAttributes: Record<string, unknown> | undefined,
  attributes: Record<string, unknown> | undefined,
): string | undefined {
  return firstString(
    objectAttributes?.note,
    objectAttributes?.body,
    attributes?.note,
    attributes?.body,
  );
}

function classifyAction(input: {
  readonly eventKind: string;
  readonly objectKind: string | undefined;
  readonly objectAttributes: Record<string, unknown> | undefined;
  readonly attributes: Record<string, unknown> | undefined;
}): Exclude<GitLabWebhookClassification, "noop"> {
  const event = lower(input.eventKind);
  const objectKind = lower(input.objectKind);
  const action = lower(
    firstString(
      input.objectAttributes?.action,
      input.objectAttributes?.state,
      input.objectAttributes?.state_id,
      input.attributes?.action,
      input.attributes?.state,
    ),
  );

  if (event.includes("approval") || objectKind.includes("approval")) {
    return "approval";
  }
  if (event.includes("pipeline") || objectKind.includes("pipeline")) {
    return "context_update";
  }
  if (event.includes("merge request") || objectKind.includes("merge")) {
    if (["merge", "merged", "close", "closed"].includes(action)) {
      return "conflict";
    }
    return "context_update";
  }
  if (["close", "closed", "reopen", "reopened"].includes(action)) {
    return "conflict";
  }
  return "context_update";
}

function commandSource(input: {
  readonly actor: string | undefined;
  readonly occurredAt: string | undefined;
  readonly eventId: string;
  readonly objectId: string;
  readonly objectKind: string | undefined;
  readonly objectAttributes: Record<string, unknown> | undefined;
  readonly project: Record<string, unknown> | undefined;
  readonly providerProjectId: string | undefined;
  readonly providerProjectPath: string | undefined;
}): ProviderCommandSource {
  const noteableKind = firstString(
    input.objectAttributes?.noteable_type,
    input.objectAttributes?.target_type,
    input.objectKind,
  );
  const noteableId = firstString(
    input.objectAttributes?.noteable_id,
    input.objectAttributes?.target_id,
    input.objectAttributes?.issue_id,
    input.objectAttributes?.merge_request_id,
    input.objectId,
  );
  return {
    actor: input.actor ?? "unknown",
    occurred_at: input.occurredAt ?? "unknown",
    artifact: {
      provider: "gitlab",
      object_kind: noteableKind ?? input.objectKind ?? "unknown",
      object_id: noteableId ?? input.objectId,
      uri: firstString(input.objectAttributes?.url, input.project?.web_url),
      ...(input.providerProjectId
        ? { provider_project_id: input.providerProjectId }
        : {}),
      ...(input.providerProjectPath
        ? { provider_project_path: input.providerProjectPath }
        : {}),
    },
    raw_comment: {
      provider: "gitlab",
      comment_id: input.objectId,
      uri: firstString(input.objectAttributes?.url),
      ...(input.providerProjectId
        ? { provider_project_id: input.providerProjectId }
        : {}),
      ...(input.providerProjectPath
        ? { provider_project_path: input.providerProjectPath }
        : {}),
    },
  };
}

function classificationForComment(
  parsed: ProviderCommandParseResult,
  objectAttributes: Record<string, unknown> | undefined,
): {
  readonly kind: Exclude<GitLabWebhookClassification, "noop">;
  readonly attributes: Record<string, string>;
} {
  if (parsed.status === "parsed") {
    return {
      kind: "valid_command",
      attributes: commandAttributes(parsed.command),
    };
  }
  if (parsed.status === "needs_clarification") {
    return {
      kind: "needs_clarification",
      attributes: {
        clarification_reason: parsed.reason,
        accepted_syntax: parsed.accepted_syntax.join(", "),
      },
    };
  }
  const noteableType = lower(firstString(objectAttributes?.noteable_type));
  return {
    kind: noteableType.includes("merge") ? "review_feedback" : "context_update",
    attributes: {},
  };
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
  // Resolve the originating provider project so downstream lookups against
  // `provider_mirrors` can scope by project (COL-1.2b). GitLab webhooks put
  // the project ID either on `body.project.id` or `body.project_id`, and the
  // path under `project.path_with_namespace` (older payloads use `project.path`).
  const providerProjectId = firstString(
    project?.id,
    objectAttributes?.project_id,
    input.body.project_id,
  );
  const providerProjectPath = firstString(
    project?.path_with_namespace,
    project?.path,
  );
  const body = commentBody(objectAttributes, attributes);
  const isComment =
    lower(eventKind).includes("note") ||
    lower(objectKind).includes("note") ||
    lower(objectKind).includes("comment");
  const parsedCommand =
    isComment && body
      ? parseProviderCommand({
          body,
          source: commandSource({
            actor,
            occurredAt,
            eventId,
            objectId,
            objectKind,
            objectAttributes,
            project,
            providerProjectId,
            providerProjectPath,
          }),
        })
      : undefined;
  const commentClassification = parsedCommand
    ? classificationForComment(parsedCommand, objectAttributes)
    : undefined;
  const classification =
    commentClassification?.kind ??
    classifyAction({
      eventKind,
      objectKind,
      objectAttributes,
      attributes,
    });
  const signal: ProviderEventSignal = {
    provider: "gitlab",
    event_type: firstString(input.body.event_type, eventKind) ?? eventKind,
    event_id: eventId,
    object_kind: objectKind ?? "unknown",
    object_id: objectId,
    ...(taskId && isTaskId(taskId) ? { task_id: taskId } : {}),
    ...(actor ? { actor } : {}),
    ...(occurredAt ? { occurred_at: occurredAt } : {}),
    ...(providerProjectId ? { provider_project_id: providerProjectId } : {}),
    ...(providerProjectPath
      ? { provider_project_path: providerProjectPath }
      : {}),
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
      ...(providerProjectId ? { provider_project_id: providerProjectId } : {}),
      ...(providerProjectPath
        ? { provider_project_path: providerProjectPath }
        : {}),
    },
    attributes: {
      classification,
      ...scalarAttributes(attributes, objectAttributes),
      ...(body ? { provider_text: body } : {}),
      ...(commentClassification?.attributes ?? {}),
    },
  };

  return {
    kind: classification,
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
