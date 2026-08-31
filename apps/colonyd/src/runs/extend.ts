import type { AppendTaskInput, Scope } from "@colony/core";
import type { ArchitectExtensionEnvelope } from "@colony/agent-runtime";
import type { ColonydContext } from "../context.js";
import { SERVICE_ACTOR } from "../context.js";
export const MAX_EXTENSION_ROUNDS = 2;

/** Apply one accepted extension envelope after its architect run succeeds. */
export async function handleArchitectExtension(
  ctx: ColonydContext,
  scope: Scope,
  runId: string,
  envelope: ArchitectExtensionEnvelope,
): Promise<void> {
  const current = ctx.store.getScope(scope.id);
  if (!current || current.status !== "validating") return;
  if (current.extension_rounds >= MAX_EXTENSION_ROUNDS) {
    ctx.store.setScopeStatus(current.id, "blocked", SERVICE_ACTOR, {
      blocked_reason: `validation extension rounds exhausted (cap ${MAX_EXTENSION_ROUNDS})`,
    });
    return;
  }
  if (envelope.kind === "human_required") {
    ctx.store.incrementExtensionRound(current.id, MAX_EXTENSION_ROUNDS);
    ctx.store.setScopeStatus(current.id, "blocked", SERVICE_ACTOR, {
      blocked_reason: envelope.reason,
    });
    ctx.store.audit(SERVICE_ACTOR, "scope.human_required", {
      scope_id: current.id,
      run_id: runId,
      detail: { reason: envelope.reason },
    });
    return;
  }
  if (envelope.kind === "acceptance_fix") {
    ctx.store.setScopeAcceptance(current.id, envelope.acceptance);
    ctx.store.incrementExtensionRound(current.id, MAX_EXTENSION_ROUNDS);
    ctx.store.audit(SERVICE_ACTOR, "scope.extension_acceptance_fixed", {
      scope_id: current.id,
      run_id: runId,
      detail: { criteria_count: envelope.acceptance.length },
    });
    return;
  }

  if (ctx.config.hitlMode === "yolo" && current.approvals !== "manual") {
    ctx.store.appendTasks(
      current.id,
      envelope.tasks as readonly AppendTaskInput[],
      SERVICE_ACTOR,
      envelope.acceptance,
    );
    ctx.store.incrementExtensionRound(current.id, MAX_EXTENSION_ROUNDS);
    return;
  }

  // Reuse the initial plan approval surface: plan_json carries the tagged
  // extension and the planning tick/approve-plan endpoint append it instead of
  // materializing a second copy of the original plan.
  ctx.store.setScopeStatus(current.id, "planning", SERVICE_ACTOR, {
    extension_round: current.extension_rounds + 1,
  });
  ctx.store.setScopePlan(current.id, JSON.stringify(envelope));
  ctx.store.incrementExtensionRound(current.id, MAX_EXTENSION_ROUNDS);
  ctx.store.audit(SERVICE_ACTOR, "scope.extension_proposed", {
    scope_id: current.id,
    run_id: runId,
    detail: { task_count: envelope.tasks.length },
  });
}
