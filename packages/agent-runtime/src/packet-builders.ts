import type { Capability, TaskState } from "@colony/domain";
import {
  type DeveloperCompletionEnvelope,
  type Freshness,
  type ReviewPacket,
  type TaskPacket,
  reviewPacketSchema,
  taskPacketSchema,
} from "@colony/schemas";
import { sha256Json } from "./hashing.js";

const UNCOMPUTED_PACKET_HASH = "sha256:packet-hash-uncomputed";

export interface ProviderCommentInput {
  readonly author: string;
  readonly posted_at: string;
  readonly body: string;
  readonly provider_id: string;
}

export interface TaskPacketBuilderInput {
  readonly scope_id: TaskPacket["scope_id"];
  readonly task_id: TaskPacket["task_id"];
  readonly provider_issue: TaskPacket["provider_issue"];
  readonly repo: TaskPacket["repo"];
  readonly goal: string;
  readonly acceptance_criteria: readonly string[];
  readonly non_goals: readonly string[];
  readonly dependencies: readonly {
    readonly task_id: TaskPacket["task_id"];
    readonly state: TaskState;
  }[];
  readonly provider_context: Omit<
    TaskPacket["provider_context"],
    "recent_comments"
  > & {
    readonly recent_comments: readonly ProviderCommentInput[];
  };
  readonly memory_bundle: TaskPacket["memory_bundle"];
  readonly policy: TaskPacket["policy"];
  readonly capabilities: readonly Capability[];
  readonly required_outputs: TaskPacket["required_outputs"];
  readonly tool_permissions: readonly string[];
  readonly sandbox_profile: string;
  readonly known_risks: readonly string[];
  readonly time_budget_minutes: number;
  readonly freshness: Omit<Freshness, "packet_hash">;
}

export interface ReviewPacketBuilderInput extends TaskPacketBuilderInput {
  readonly mr_id: string;
  readonly commit_sha: string;
  readonly diff_summary: string;
  readonly developer_envelope: DeveloperCompletionEnvelope;
  readonly pipeline_artifacts: ReviewPacket["pipeline_artifacts"];
}

export function buildTaskPacket(input: TaskPacketBuilderInput): TaskPacket {
  const packet: TaskPacket = {
    version: 1,
    scope_id: input.scope_id,
    task_id: input.task_id,
    provider_issue: input.provider_issue,
    repo: input.repo,
    goal: input.goal,
    acceptance_criteria: [...input.acceptance_criteria],
    non_goals: [...input.non_goals],
    dependencies: input.dependencies.map((dep) => ({
      task_id: dep.task_id,
      state: dep.state,
    })),
    provider_context: {
      ...input.provider_context,
      recent_comments:
        input.provider_context.recent_comments.map(quoteProviderComment),
    },
    memory_bundle: input.memory_bundle,
    policy: input.policy,
    capabilities: [...input.capabilities],
    required_outputs: [...input.required_outputs],
    tool_permissions: [...input.tool_permissions],
    sandbox_profile: input.sandbox_profile,
    known_risks: [...input.known_risks],
    time_budget_minutes: input.time_budget_minutes,
    freshness: {
      ...input.freshness,
      packet_hash: UNCOMPUTED_PACKET_HASH,
    },
  };
  const packet_hash = hashPacket(packet);
  return taskPacketSchema.parse({
    ...packet,
    freshness: { ...packet.freshness, packet_hash },
  });
}

export function buildReviewPacket(
  input: ReviewPacketBuilderInput,
): ReviewPacket {
  const taskPacket = buildTaskPacket(input);
  const packet: ReviewPacket = {
    ...taskPacket,
    mr_id: input.mr_id,
    commit_sha: input.commit_sha,
    diff_summary: input.diff_summary,
    developer_envelope: input.developer_envelope,
    pipeline_artifacts: [...input.pipeline_artifacts],
    freshness: {
      ...taskPacket.freshness,
      packet_hash: UNCOMPUTED_PACKET_HASH,
    },
  };
  const packet_hash = hashPacket(packet);
  return reviewPacketSchema.parse({
    ...packet,
    freshness: { ...packet.freshness, packet_hash },
  });
}

export function hashPacket(packet: TaskPacket | ReviewPacket): string {
  return sha256Json({
    ...packet,
    freshness: {
      ...packet.freshness,
      packet_hash: UNCOMPUTED_PACKET_HASH,
    },
  });
}

export function hashEnvelope(envelope: unknown): string {
  return sha256Json(envelope);
}

export function quoteProviderComment(
  comment: ProviderCommentInput,
): TaskPacket["provider_context"]["recent_comments"][number] {
  return {
    author: comment.author,
    posted_at: comment.posted_at,
    provider_id: comment.provider_id,
    body: [
      `<untrusted-provider-comment provider_id="${escapeAttribute(
        comment.provider_id,
      )}" author="${escapeAttribute(comment.author)}">`,
      comment.body,
      "</untrusted-provider-comment>",
    ].join("\n"),
  };
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
