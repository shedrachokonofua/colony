import { ThinkingLevel as SdkThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
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
  | "xhigh";

const SDK_THINKING_LEVELS = {
  off: SdkThinkingLevel.Off,
  minimal: SdkThinkingLevel.Minimal,
  low: SdkThinkingLevel.Low,
  medium: SdkThinkingLevel.Medium,
  high: SdkThinkingLevel.High,
  xhigh: SdkThinkingLevel.XHigh,
} as const satisfies Record<ColonyThinkingLevel, SdkThinkingLevel>;

export function toSdkThinkingLevel(
  level: ColonyThinkingLevel,
): SdkThinkingLevel {
  return SDK_THINKING_LEVELS[level];
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
