import { z } from "zod";
import {
  artifactRefSchema,
  capabilitySchema,
  memoryBundleSchema,
  policyConstraintsSchema,
  providerContextSchema,
  repoRefSchema,
  requiredOutputSchema,
  scopeIdSchema,
  taskIdSchema,
  taskStateSchema,
} from "../common.js";
import { freshnessSchema } from "../freshness.js";

const childTaskStatusSchema = z
  .object({
    task_id: taskIdSchema,
    state: taskStateSchema,
    title: z.string().min(1),
    closed_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

const proposalRefSchema = z
  .object({
    proposal_id: z.string().min(1),
    title: z.string().min(1),
    classification: z.enum([
      "blocker",
      "in_scope_followup",
      "out_of_scope_followup",
      "scope_change",
      "rejected",
    ]),
    follow_up_task_id: taskIdSchema.optional(),
  })
  .strict();

const releaseDeployStateSchema = z
  .object({
    release_required: z.boolean(),
    release_state: z
      .enum(["not_required", "pending", "approved", "released", "rolled_back"])
      .optional(),
    release_artifact_id: z.string().min(1).optional(),
  })
  .strict();

export const scopeReviewPacketSchema = z
  .object({
    version: z.literal(1),
    scope_id: scopeIdSchema,
    provider_scope_artifact: artifactRefSchema,
    repo: repoRefSchema,
    scope_goal: z.string().min(1),
    scope_acceptance_criteria: z.array(z.string().min(1)),
    provider_context: providerContextSchema,
    memory_bundle: memoryBundleSchema,
    policy: policyConstraintsSchema,
    capabilities: z.array(capabilitySchema),
    required_outputs: z.array(requiredOutputSchema),
    tool_permissions: z.array(z.string()),
    sandbox_profile: z.string().min(1),
    time_budget_minutes: z.number().int().positive(),
    child_task_statuses: z.array(childTaskStatusSchema),
    merged_artifacts: z.array(artifactRefSchema),
    unresolved_conflicts: z.array(z.string()),
    pending_sync_items: z.array(z.string()),
    accepted_followups: z.array(proposalRefSchema),
    rejected_proposals: z.array(proposalRefSchema),
    release_deploy_state: releaseDeployStateSchema,
    freshness: freshnessSchema,
  })
  .strict()
  .meta({
    id: "colony.packet.scope_review.v1",
    title: "ScopeReviewPacket",
    description:
      "Bounded context delivered to a Reviewer run that evaluates whether a scope can close. Carries child task outcomes, merged artifacts, conflict/sync residue, follow-up disposition, and release/deploy state.",
  });

export type ScopeReviewPacket = z.infer<typeof scopeReviewPacketSchema>;
