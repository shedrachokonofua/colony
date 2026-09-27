import { ThinkingLevel as SdkThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import type { AgentRuntimeRole } from "./adapter.js";
import type { SandboxRole } from "@colony/sandbox";

/**
 * Colony's configured thinking levels as they appear in colony.yaml. The SDK's
 * selector values come from its own effort enum, so they are mapped rather
 * than cast.
 */
export type ColonyThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const SDK_THINKING_LEVELS = {
  off: SdkThinkingLevel.Off,
  minimal: SdkThinkingLevel.Minimal,
  low: SdkThinkingLevel.Low,
  medium: SdkThinkingLevel.Medium,
  high: SdkThinkingLevel.High,
  xhigh: SdkThinkingLevel.XHigh,
  max: SdkThinkingLevel.Max,
} as const satisfies Record<ColonyThinkingLevel, SdkThinkingLevel>;

export function toSdkThinkingLevel(
  level: ColonyThinkingLevel,
): SdkThinkingLevel {
  return SDK_THINKING_LEVELS[level];
}

/** An effort a model can be asked for: every thinking level but `off`. */
export type ColonyEffort = Exclude<ColonyThinkingLevel, "off">;

/**
 * Thinking metadata for a model whose supported efforts the config declares.
 * The SDK infers a ladder only for catalogued ids; a gateway alias such as
 * router/muse-spark-1.3-contributor gets a generic ladder without `max`, so
 * a `max` request would be clamped below what the model accepts.
 */
export function declaredThinking(
  efforts: readonly ColonyEffort[],
): NonNullable<Model["thinking"]> {
  return {
    mode: "effort",
    efforts: efforts.map((effort) => SDK_THINKING_LEVELS[effort]),
  };
}

/**
 * Map a pi runner role onto a sandbox launch role. The architect is a
 * read-only developer-style role, so it shares the reviewer sandbox profile
 * (no branch-push capability, read-only root filesystem).
 */
export function toSandboxRole(role: AgentRuntimeRole): SandboxRole {
  return role === "developer" ? "developer" : "reviewer";
}

/** Binding name reported to the credential broker for colonyd runs. */
export const PI_RUNTIME_BINDING_NAME = "colonyd";

export type { ToolDefinition };
