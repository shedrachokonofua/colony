import { timingSafeEqual } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Connection, Client as TemporalClient } from "@temporalio/client";
import { env } from "@colony/config";
import {
  createPool,
  IdempotencyRepository,
  ProviderProjectRepository,
  type Pool,
} from "@colony/db";
import { isScopeId, isTaskId, type ProviderEntityKind } from "@colony/domain";
import {
  parseProviderCommand,
  type ProviderCommand,
  type ProviderCommandParseResult,
  type ProviderCommandSource,
} from "@colony/provider";
import {
  approvalSignal,
  pipelineUpdateSignal,
  providerEventSignal,
  supervisorWorkflowId,
  type ApprovalSignal,
  type PipelineUpdateSignal,
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
  readonly signalApproval: (
    scope_id: ScopeId,
    signal: ApprovalSignal,
  ) => Promise<{ readonly workflow_id: string }>;
  readonly signalPipelineUpdate: (
    scope_id: ScopeId,
    signal: PipelineUpdateSignal,
  ) => Promise<{ readonly workflow_id: string }>;
}

/**
 * Resolves a provider note's "noteable" (the issue/MR the comment is on)
 * to a Colony mirror so the dispatcher can tell if a `/approve` was
 * posted on a scope-level issue (decomposition gate) or a task-level
 * one. Implementations query `provider_mirrors`.
 */
export interface MirrorLookup {
  readonly findMirror: (input: {
    readonly provider: string;
    readonly provider_id: string;
    readonly provider_project_id?: string;
    readonly preferred_entity_kinds?: readonly ProviderEntityKind[];
  }) => Promise<MirrorContext | null>;
}

interface MirrorContext {
  readonly entity_kind: ProviderEntityKind;
  readonly colony_id: string;
}

export interface WebhookDispatcherDeps {
  readonly verifier: WebhookSignatureVerifier;
  readonly dedup: WebhookDedupStore;
  readonly supervisor: SupervisorSignalDispatcher;
  readonly mirrors?: MirrorLookup;
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
  readonly issue?: unknown;
  readonly merge_request?: unknown;
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
      readonly scope_id?: ScopeId;
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

  private async signalWithStart(
    scope_id: ScopeId,
    signalName: string,
    signalArgs: unknown[],
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
      signal: signalName,
      signalArgs,
    });
    return { workflow_id };
  }

  async signalProviderEvent(
    scope_id: ScopeId,
    signal: ProviderEventSignal,
  ): Promise<{ readonly workflow_id: string }> {
    return this.signalWithStart(scope_id, providerEventSignal.name, [signal]);
  }

  async signalApproval(
    scope_id: ScopeId,
    signal: ApprovalSignal,
  ): Promise<{ readonly workflow_id: string }> {
    return this.signalWithStart(scope_id, approvalSignal.name, [signal]);
  }

  async signalPipelineUpdate(
    scope_id: ScopeId,
    signal: PipelineUpdateSignal,
  ): Promise<{ readonly workflow_id: string }> {
    return this.signalWithStart(scope_id, pipelineUpdateSignal.name, [signal]);
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
    const providerProjects = new ProviderProjectRepository(pool);
    deps = {
      verifier: new GitLabTokenVerifier(cfg.GITLAB_WEBHOOK_SECRET),
      dedup: new IdempotencyRepository(pool),
      supervisor: new TemporalSupervisorSignalDispatcher(),
      mirrors: {
        async findMirror(input) {
          const row = await providerProjects.findMirrorByProviderRef({
            provider: input.provider,
            provider_id: input.provider_id,
            provider_project_id: input.provider_project_id,
            preferred_entity_kinds: input.preferred_entity_kinds,
          });
          if (!row) return null;
          return {
            entity_kind: row.entity_kind,
            colony_id: row.colony_id,
          };
        },
      },
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

function scopedProviderId(
  providerProjectId: string | undefined,
  providerLocalId: string | undefined,
): string | undefined {
  if (!providerLocalId) return undefined;
  return providerProjectId
    ? `${providerProjectId}:${providerLocalId}`
    : providerLocalId;
}

function gitLabLocalIdFromUrl(
  uri: unknown,
  segment: "issues" | "merge_requests",
): string | undefined {
  const value = asString(uri);
  if (!value) return undefined;
  const match = value.match(new RegExp(`/(?:-/)?${segment}/(\\d+)`));
  return match?.[1];
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
  readonly referenceObjectId: string | undefined;
}): ProviderCommandSource {
  const noteableKind = firstString(
    input.objectAttributes?.noteable_type,
    input.objectAttributes?.target_type,
    input.objectKind,
  );
  return {
    actor: input.actor ?? "unknown",
    occurred_at: input.occurredAt ?? "unknown",
    artifact: {
      provider: "gitlab",
      object_kind: noteableKind ?? input.objectKind ?? "unknown",
      object_id: input.referenceObjectId ?? input.objectId,
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

/**
 * After classification, look up the noteable's Colony mirror so a
 * `/approve` posted on a scope-level issue routes to the decomposition
 * gate, not a task gate. Mutates `signal.attributes` in place to keep
 * the signal shape simple. Idempotent — calling twice is safe.
 *
 * Resolution order for the noteable's provider_id:
 * 1. `signal.reference.object_id` (the noteable's ID, captured by
 *    classifier from `objectAttributes.noteable_id`/`target_id` etc.)
 * 2. `signal.object_id` as a last resort
 */
export async function enrichSignalWithMirrorContext(
  signal: ProviderEventSignal,
  mirrors: MirrorLookup,
): Promise<MirrorContext | null> {
  const noteableId =
    signal.reference?.object_id ?? signal.object_id ?? undefined;
  if (!noteableId) return null;
  const mirror = await mirrors.findMirror({
    provider: signal.provider,
    provider_id: noteableId,
    provider_project_id: signal.provider_project_id,
    preferred_entity_kinds: preferredMirrorKinds(signal),
  });
  if (!mirror) return null;
  if (
    (mirror.entity_kind === "task" || mirror.entity_kind === "mr_pr") &&
    isTaskId(mirror.colony_id) &&
    !signal.task_id
  ) {
    (signal as { task_id: string }).task_id = mirror.colony_id;
  }

  const commandKind = signal.attributes?.command_kind;
  if (typeof commandKind !== "string") return mirror;
  const target =
    mirror.entity_kind === "scope" ? "scope_decomposition" : mirror.entity_kind;
  // attributes is readonly; rebuild the same object with the extra key.
  // We reassign through `as` because the upstream type is a frozen
  // Record; webhook dispatcher owns the only writes to it pre-dispatch.
  const enriched: Record<string, JsonScalar> = {
    ...(signal.attributes ?? {}),
    command_target: target,
    command_target_colony_id: mirror.colony_id,
  };
  (signal as { attributes: typeof enriched }).attributes = enriched;
  return mirror;
}

type JsonScalar = string | number | boolean | null;

function providerObjectId(input: {
  readonly objectKind: string | undefined;
  readonly objectAttributes: Record<string, unknown> | undefined;
  readonly providerProjectId: string | undefined;
  readonly fallback: string | undefined;
}): string | undefined {
  const objectKind = lower(input.objectKind);
  const iid = firstString(input.objectAttributes?.iid);
  if (
    input.providerProjectId &&
    iid &&
    (objectKind.includes("issue") || objectKind.includes("merge"))
  ) {
    return scopedProviderId(input.providerProjectId, iid);
  }
  return input.fallback;
}

function noteableProviderObjectId(input: {
  readonly objectKind: string | undefined;
  readonly objectAttributes: Record<string, unknown> | undefined;
  readonly issue: Record<string, unknown> | undefined;
  readonly mergeRequest: Record<string, unknown> | undefined;
  readonly providerProjectId: string | undefined;
  readonly fallback: string;
}): string {
  const noteableKind = lower(
    firstString(
      input.objectAttributes?.noteable_type,
      input.objectAttributes?.target_type,
      input.objectKind,
    ),
  );
  const issueIid = firstString(
    input.objectAttributes?.issue_iid,
    input.issue?.iid,
    gitLabLocalIdFromUrl(input.objectAttributes?.url, "issues"),
  );
  if (input.providerProjectId && issueIid && noteableKind.includes("issue")) {
    return (
      scopedProviderId(input.providerProjectId, issueIid) ?? input.fallback
    );
  }
  const mrIid = firstString(
    input.objectAttributes?.merge_request_iid,
    input.mergeRequest?.iid,
    gitLabLocalIdFromUrl(input.objectAttributes?.url, "merge_requests"),
  );
  if (input.providerProjectId && mrIid && noteableKind.includes("merge")) {
    return scopedProviderId(input.providerProjectId, mrIid) ?? input.fallback;
  }
  return (
    firstString(
      input.objectAttributes?.noteable_id,
      input.objectAttributes?.target_id,
      input.objectAttributes?.issue_id,
      input.objectAttributes?.merge_request_id,
    ) ?? input.fallback
  );
}

function pipelineMergeRequestObjectId(input: {
  readonly objectAttributes: Record<string, unknown> | undefined;
  readonly mergeRequest: Record<string, unknown> | undefined;
  readonly providerProjectId: string | undefined;
}): string | undefined {
  const objectAttributesMr = asRecord(input.objectAttributes?.merge_request);
  const iid = firstString(
    input.mergeRequest?.iid,
    objectAttributesMr?.iid,
    input.objectAttributes?.merge_request_iid,
  );
  return scopedProviderId(input.providerProjectId, iid);
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
  const issue = asRecord(input.body.issue);
  const mergeRequest = asRecord(input.body.merge_request);
  const attributes = asRecord(input.body.attributes);
  const user = asRecord(input.body.user);
  const objectKind = firstString(
    input.body.object_kind,
    objectAttributes?.object_kind,
    eventKind,
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
  const rawObjectId = firstString(
    input.body.object_id,
    objectAttributes?.id,
    objectAttributes?.iid,
    input.body.project_id,
    project?.id,
    eventId,
  );
  const objectId = providerObjectId({
    objectKind,
    objectAttributes,
    providerProjectId,
    fallback: rawObjectId,
  });

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
  const classifiedScopeId = scopeId && isScopeId(scopeId) ? scopeId : undefined;

  const taskId = firstString(input.body.task_id, objectAttributes?.task_id);
  const actor = firstString(input.body.actor, user?.username, user?.name);
  const occurredAt = firstString(
    input.body.occurred_at,
    objectAttributes?.updated_at,
    objectAttributes?.created_at,
  );
  const body = commentBody(objectAttributes, attributes);
  const isComment =
    lower(eventKind).includes("note") ||
    lower(objectKind).includes("note") ||
    lower(objectKind).includes("comment");
  const referenceObjectId = isComment
    ? noteableProviderObjectId({
        objectKind,
        objectAttributes,
        issue,
        mergeRequest,
        providerProjectId,
        fallback: objectId,
      })
    : (pipelineMergeRequestObjectId({
        objectAttributes,
        mergeRequest,
        providerProjectId,
      }) ?? objectId);
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
            referenceObjectId,
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
      object_id: referenceObjectId,
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
    ...(classifiedScopeId ? { scope_id: classifiedScopeId } : {}),
    event_id: eventId,
    object_id: objectId,
    signal,
  };
}

function approvalFromProviderSignal(
  signal: ProviderEventSignal,
): ApprovalSignal | null {
  if (!signal.task_id) return null;
  return {
    task_id: signal.task_id,
    actor: signal.actor ?? "unknown",
    artifact_id: signal.reference?.object_id ?? signal.object_id,
    approval_id: signal.object_id,
    commit_sha: firstString(
      signal.attributes?.commit_sha,
      signal.attributes?.sha,
    ),
    pipeline_id: firstString(
      signal.attributes?.pipeline_id,
      signal.attributes?.pipeline,
    ),
    reference: signal.reference,
    occurred_at: signal.occurred_at,
  };
}

function pipelineUpdateFromProviderSignal(
  signal: ProviderEventSignal,
): PipelineUpdateSignal | null {
  if (!signal.task_id) return null;
  const pipeline_id = firstString(
    signal.attributes?.pipeline_id,
    signal.attributes?.id,
    signal.object_id,
  );
  const status = firstString(
    signal.attributes?.status,
    signal.attributes?.state,
  );
  if (!pipeline_id || !status) return null;
  return {
    provider: signal.provider,
    task_id: signal.task_id,
    pipeline_id,
    status,
    commit_sha: firstString(
      signal.attributes?.commit_sha,
      signal.attributes?.sha,
    ),
    reference: signal.reference,
    occurred_at: signal.occurred_at,
  };
}

function isPipelineProviderSignal(signal: ProviderEventSignal): boolean {
  return (
    lower(signal.event_type).includes("pipeline") ||
    lower(signal.object_kind).includes("pipeline")
  );
}

async function dispatchWebhookSignal(
  deps: WebhookDispatcherDeps,
  scope_id: ScopeId,
  classified: Exclude<ClassifiedGitLabWebhook, { readonly kind: "noop" }>,
): Promise<{ readonly workflow_id: string }> {
  if (classified.kind === "approval") {
    const approval = approvalFromProviderSignal(classified.signal);
    if (approval) {
      return deps.supervisor.signalApproval(scope_id, approval);
    }
  }
  if (isPipelineProviderSignal(classified.signal)) {
    const pipeline = pipelineUpdateFromProviderSignal(classified.signal);
    if (pipeline) {
      return deps.supervisor.signalPipelineUpdate(scope_id, pipeline);
    }
  }
  return deps.supervisor.signalProviderEvent(scope_id, classified.signal);
}

function preferredMirrorKinds(
  signal: ProviderEventSignal,
): readonly ProviderEntityKind[] | undefined {
  const objectKind = lower(
    firstString(
      signal.attributes?.noteable_type,
      signal.reference?.object_kind,
      signal.object_kind,
      signal.event_type,
    ),
  );
  const eventType = lower(signal.event_type);
  if (objectKind.includes("merge") || eventType.includes("merge")) {
    return ["mr_pr"];
  }
  if (objectKind.includes("pipeline") || eventType.includes("pipeline")) {
    return ["mr_pr"];
  }
  if (objectKind.includes("issue")) {
    return ["scope", "task"];
  }
  return undefined;
}

function scopeIdFromMirror(mirror: MirrorContext | null): ScopeId | undefined {
  if (!mirror) return undefined;
  if (isScopeId(mirror.colony_id)) return mirror.colony_id;
  if (isTaskId(mirror.colony_id)) {
    const scope_id = mirror.colony_id.slice(
      0,
      mirror.colony_id.lastIndexOf("."),
    );
    return isScopeId(scope_id) ? scope_id : undefined;
  }
  return undefined;
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
      mirrors: overrides.mirrors ?? defaults.mirrors,
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

    const mirror = depsForRequest.mirrors
      ? await enrichSignalWithMirrorContext(
          classified.signal,
          depsForRequest.mirrors,
        )
      : null;
    const scope_id = classified.scope_id ?? scopeIdFromMirror(mirror);
    if (!scope_id) {
      return c.json(
        {
          accepted: false as const,
          error: "missing_scope_id",
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

    const signalResult = await dispatchWebhookSignal(
      depsForRequest,
      scope_id,
      classified,
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
