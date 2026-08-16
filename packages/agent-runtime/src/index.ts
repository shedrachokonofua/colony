export const COLONY_AGENT_RUNTIME_PACKAGE = "@colony/agent-runtime" as const;

export * from "./adapter.js";
export * from "./credential-broker.js";
export * from "./hashing.js";
export * from "./pi-adapter.js";
export * from "./runtime-bindings.js";
export * from "./skill-registry.js";
export * from "./tool-materialization.js";

// Re-export pi-runner-common helpers needed by the run paths. The large
// LLM-side dependencies stay behind the per-runner subpath modules.
export {
  buildArchitectSystemPrompt,
  buildImplementerSystemPrompt,
  buildReviewerSystemPrompt,
  buildReviewerFinalizerPrompt,
  createArchitectSubmitTool,
  createImplementerSubmitTool,
  createReviewerSubmitTool,
  architectDecompositionEnvelopeTypeBox,
  implementerCompletionEnvelopeTypeBox,
  reviewerVerdictEnvelopeTypeBox,
} from "./pi-runner-common.js";
export type { PiRunnerLogger } from "./pi-runner-common.js";
