import type { Capability, Role } from "./actors.js";
import type {
  ActorId,
  AgentRunId,
  ApprovalId,
  ArtifactId,
  AssignmentId,
  AuditId,
  CapabilityGrantId,
  DependencyId,
  EventId,
  GateId,
  PolicyId,
  ProviderMirrorId,
  ReviewId,
  ScopeId,
  TaskId,
} from "./ids.js";
import type { ScopeState, TaskState } from "./state-machines.js";

export type Iso8601 = string;

export interface Scope {
  readonly id: ScopeId;
  readonly title: string;
  readonly description: string;
  readonly state: ScopeState;
  readonly state_version: number;
  readonly created_at: Iso8601;
  readonly updated_at: Iso8601;
}

export interface Task {
  readonly id: TaskId;
  readonly scope_id: ScopeId;
  readonly title: string;
  readonly description: string;
  readonly acceptance_criteria: ReadonlyArray<string>;
  readonly non_goals: ReadonlyArray<string>;
  readonly state: TaskState;
  readonly state_version: number;
  readonly claim_version: number;
  readonly assignee?: ActorId;
  readonly created_at: Iso8601;
  readonly updated_at: Iso8601;
}

export type DependencyKind =
  | "blocks"
  | "parent_child"
  | "related"
  | "discovered_from"
  | "duplicates"
  | "supersedes";

export interface TaskDependency {
  readonly id: DependencyId;
  readonly from_task_id: TaskId;
  readonly to_task_id: TaskId;
  readonly kind: DependencyKind;
  readonly created_at: Iso8601;
}

export interface Assignment {
  readonly id: AssignmentId;
  readonly task_id: TaskId;
  readonly assignee: ActorId;
  readonly role: Role;
  readonly assigned_at: Iso8601;
  readonly released_at?: Iso8601;
}

export type GateKind = "spec_dag" | "mr_pr" | "scope_close" | "release_deploy";
export type GateStatus = "pending" | "open" | "blocked" | "closed";

export interface Gate {
  readonly id: GateId;
  readonly scope_id: ScopeId;
  readonly task_id?: TaskId;
  readonly kind: GateKind;
  readonly status: GateStatus;
  readonly required_approvals: ReadonlyArray<Role>;
  readonly opened_at?: Iso8601;
  readonly closed_at?: Iso8601;
}

export type ReviewResult =
  | "approved"
  | "changes_requested"
  | "blocked"
  | "escalate";

export interface Review {
  readonly id: ReviewId;
  readonly task_id: TaskId;
  readonly artifact_id?: ArtifactId;
  readonly reviewer: ActorId;
  readonly result?: ReviewResult;
  readonly envelope_hash?: string;
  readonly requested_at: Iso8601;
  readonly resolved_at?: Iso8601;
}

export interface Approval {
  readonly id: ApprovalId;
  readonly artifact_id: ArtifactId;
  readonly actor: ActorId;
  readonly commit_sha?: string;
  readonly pipeline_id?: string;
  readonly approved_at: Iso8601;
  readonly invalidated_at?: Iso8601;
  readonly invalidation_reason?: string;
}

export type ArtifactKind =
  | "issue"
  | "epic"
  | "mr"
  | "pr"
  | "commit"
  | "branch"
  | "pipeline"
  | "comment"
  | "release";

export interface Artifact {
  readonly id: ArtifactId;
  readonly kind: ArtifactKind;
  readonly scope_id?: ScopeId;
  readonly task_id?: TaskId;
  readonly provider: string;
  readonly provider_id: string;
  readonly uri: string;
  readonly hash?: string;
  readonly created_at: Iso8601;
}

export type EventKind =
  | "scope_state_changed"
  | "task_state_changed"
  | "claim_succeeded"
  | "claim_failed"
  | "envelope_received"
  | "envelope_rejected"
  | "provider_event"
  | "review_requested"
  | "review_resolved"
  | "approval_recorded"
  | "approval_invalidated"
  | "gate_opened"
  | "gate_closed"
  | "conflict_detected"
  | "conflict_resolved"
  | "pending_sync_marked"
  | "pending_sync_recovered"
  | "operator_override"
  | "audit_recorded";

export interface Event {
  readonly id: EventId;
  readonly scope_id?: ScopeId;
  readonly task_id?: TaskId;
  readonly kind: EventKind;
  readonly actor?: ActorId;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly recorded_at: Iso8601;
}

export interface AuditRecord {
  readonly id: AuditId;
  readonly scope_id?: ScopeId;
  readonly task_id?: TaskId;
  readonly actor: ActorId;
  readonly action: string;
  readonly capability?: Capability;
  readonly target_kind?: string;
  readonly target_id?: string;
  readonly previous_state?: string;
  readonly new_state?: string;
  readonly reason?: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly recorded_at: Iso8601;
}

export type AgentRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "envelope_rejected";

export interface AgentRun {
  readonly id: AgentRunId;
  readonly task_id?: TaskId;
  readonly review_id?: ReviewId;
  readonly role: Role;
  readonly sandbox_id?: string;
  readonly packet_hash: string;
  readonly envelope_hash?: string;
  readonly status: AgentRunStatus;
  readonly started_at: Iso8601;
  readonly finished_at?: Iso8601;
}

export type ProviderEntityKind =
  | "scope"
  | "task"
  | "mr_pr"
  | "comment"
  | "branch"
  | "commit"
  | "pipeline"
  | "user";

export interface ProviderMirror {
  readonly id: ProviderMirrorId;
  readonly colony_id: string;
  readonly entity_kind: ProviderEntityKind;
  readonly provider: string;
  readonly provider_id: string;
  readonly source_version?: string;
  readonly projected_at?: Iso8601;
  readonly freshness_ttl_seconds?: number;
}

export type PolicyScope = "global" | "project" | "scope" | "task";

export interface Policy {
  readonly id: PolicyId;
  readonly scope: PolicyScope;
  readonly target_id?: string;
  readonly version: number;
  readonly protected_paths: ReadonlyArray<string>;
  readonly security_labels: ReadonlyArray<string>;
  readonly always_human_review: boolean;
  readonly review_loop_cap: number;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly created_at: Iso8601;
}

export interface CapabilityGrant {
  readonly id: CapabilityGrantId;
  readonly actor: ActorId;
  readonly role: Role;
  readonly capability: Capability;
  readonly scope_id?: ScopeId;
  readonly task_id?: TaskId;
  readonly granted_by: ActorId;
  readonly granted_at: Iso8601;
  readonly expires_at?: Iso8601;
}

export interface ProviderIdentity {
  readonly actor: ActorId;
  readonly provider: string;
  readonly provider_user_id: string;
  readonly role: Role;
  readonly is_bot: boolean;
}
