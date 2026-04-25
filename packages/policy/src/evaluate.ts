import type {
  Capability,
  Policy,
  ProviderIdentity,
  Role,
} from "@colony/domain";
import {
  type TaskGraphAction,
  requiredCapabilityForAction,
} from "./actions.js";

const BOT_GRAPH_WRITE_EXEMPT_ROLES: ReadonlySet<Role> = new Set([
  "supervisor",
  "human",
]);

export interface PolicyEvaluationInput {
  readonly action: TaskGraphAction;
  readonly requiredCapability: Capability;
  /**
   * Grant rows (merged / deduped) for this request — capability strings the actor
   * holds in the current scope (or global).
   */
  readonly granted: ReadonlySet<Capability>;
  /**
   * Optional provider identity. When absent, only grant checks run (convenient for
   * tests or unsettled operator accounts).
   */
  readonly providerIdentity: ProviderIdentity | null;
  /**
   * For audit: resolved effective policy, when applicable.
   */
  readonly effectivePolicy: Policy | null;
}

export type PolicyEvaluationResult =
  | {
      allowed: true;
      capability: Capability;
      /** Policy object included for audit `evidence` (COL-0.8 accept). */
      effectivePolicy: Policy | null;
    }
  | {
      allowed: false;
      reason: string;
      capability: Capability;
      effectivePolicy: Policy | null;
    };

/**
 * `evaluate` answers whether an actor may perform `action` given grants and
 * provider identity. Bot agents cannot use `graph.write` except where exempt
 * (supervisor / human).
 */
export function evaluate(input: PolicyEvaluationInput): PolicyEvaluationResult {
  const cap = input.requiredCapability;
  if (!input.granted.has(cap)) {
    return {
      allowed: false,
      reason: `missing capability: ${cap}`,
      capability: cap,
      effectivePolicy: input.effectivePolicy,
    };
  }
  if (cap === "graph.write" && input.providerIdentity) {
    const { is_bot, role } = input.providerIdentity;
    if (is_bot && !BOT_GRAPH_WRITE_EXEMPT_ROLES.has(role)) {
      return {
        allowed: false,
        reason: "bot agents cannot use graph.write",
        capability: cap,
        effectivePolicy: input.effectivePolicy,
      };
    }
  }
  return {
    allowed: true,
    capability: cap,
    effectivePolicy: input.effectivePolicy,
  };
}

/**
 * One-call helper: derive required capability for `action` and evaluate.
 */
export function evaluateAction(
  action: TaskGraphAction,
  input: Omit<PolicyEvaluationInput, "requiredCapability" | "action">,
): PolicyEvaluationResult {
  return evaluate({
    action,
    requiredCapability: requiredCapabilityForAction(action),
    granted: input.granted,
    providerIdentity: input.providerIdentity,
    effectivePolicy: input.effectivePolicy,
  });
}
