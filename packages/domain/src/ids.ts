declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type ScopeId = Brand<string, "ScopeId">;
export type TaskId = Brand<string, "TaskId">;
export type DependencyId = Brand<string, "DependencyId">;
export type AssignmentId = Brand<string, "AssignmentId">;
export type GateId = Brand<string, "GateId">;
export type ReviewId = Brand<string, "ReviewId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type EventId = Brand<string, "EventId">;
export type AuditId = Brand<string, "AuditId">;
export type AgentRunId = Brand<string, "AgentRunId">;
export type ProviderMirrorId = Brand<string, "ProviderMirrorId">;
export type ProviderRepoId = Brand<string, "ProviderRepoId">;
export type ScopeTargetId = Brand<string, "ScopeTargetId">;
export type TaskTargetId = Brand<string, "TaskTargetId">;
export type PolicyId = Brand<string, "PolicyId">;
export type CapabilityGrantId = Brand<string, "CapabilityGrantId">;
export type ActorId = Brand<string, "ActorId">;

const SCOPE_ID_RE = /^col-[a-z0-9]{4,}$/;
const TASK_ID_RE = /^col-[a-z0-9]{4,}\.\d+$/;

export const isScopeId = (s: string): s is ScopeId => SCOPE_ID_RE.test(s);
export const isTaskId = (s: string): s is TaskId => TASK_ID_RE.test(s);

export const scopeId = (s: string): ScopeId => {
  if (!isScopeId(s)) throw new Error(`invalid scope id: ${s}`);
  return s;
};

export const taskId = (s: string): TaskId => {
  if (!isTaskId(s)) throw new Error(`invalid task id: ${s}`);
  return s;
};
