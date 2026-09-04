export const COLONY_AGENT_RUNTIME_PACKAGE = "@colony/agent-runtime" as const;

export * from "./adapter.js";
export * from "./credential-broker.js";
export * from "./hashing.js";
export * from "./pi-adapter.js";
export * from "./runtime-bindings.js";
export * from "./skill-registry.js";
export * from "./tool-materialization.js";

export {
  createRunAuditSink,
  noopRunAuditSink,
  type RunAuditSink,
} from "./audit-sink.js";
export { redactText, redactValue } from "./redact.js";

// Re-export pi-runner-common helpers needed by the run paths. The large
// LLM-side dependencies stay behind the per-runner subpath modules.
export {
  buildArchitectSystemPrompt,
  buildImplementerSystemPrompt,
  buildReviewerSystemPrompt,
  buildReviewerFinalizerPrompt,
  createImplementerSubmitTool,
  createReviewerSubmitTool,
  implementerCompletionEnvelopeTypeBox,
  reviewerVerdictEnvelopeTypeBox,
  provisionRepoWorkspace,
  provisionScratchDir,
} from "./pi-runner-common.js";
export type { PiModelSpec, PiRunnerLogger } from "./pi-runner-common.js";
export { validateDecompositionEnvelope } from "./envelope-validation.js";
export {
  ArchitectExtensionEnvelope,
  architectExtensionEnvelopeTypeBox,
  createArchitectExtensionSubmitTool,
  buildArchitectExtensionSystemPrompt,
} from "./architect-extension.js";
export type {
  ArchitectExtensionEnvelope as ArchitectExtensionEnvelopeType,
  ArchitectExtensionTask,
} from "./architect-extension.js";
export { validateExtensionEnvelope } from "./envelope-validation.js";
export type { DecompositionValidationError } from "./envelope-validation.js";
export {
  ARCHITECT_STAGES,
  architectDecompositionEnvelopeTypeBox,
  buildArchitectStages,
  createArchitectSubmitTool,
  createPlanReviewSubmitTool,
  formatPlanReviewFeedback,
  PLAN_REVIEW_SYSTEM_PROMPT,
  planReviewVerdictTypeBox,
} from "./architect-stages.js";
export type {
  ArchitectStage,
  ArchitectStageName,
  InspectionManifest,
  StageArtifacts,
} from "./architect-stages.js";
