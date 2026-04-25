import { z } from "zod";
import {
  artifactRefSchema,
  capabilitySchema,
  dependencyRefSchema,
  memoryBundleSchema,
  pipelineArtifactSchema,
  policyConstraintsSchema,
  providerContextSchema,
  repoRefSchema,
  requiredOutputSchema,
  scopeIdSchema,
  taskIdSchema,
} from "../common.js";
import { developerCompletionEnvelopeSchema } from "../envelopes/developer-completion.js";
import { freshnessSchema } from "../freshness.js";

export const reviewPacketSchema = z
  .object({
    version: z.literal(1),
    scope_id: scopeIdSchema,
    task_id: taskIdSchema,
    provider_issue: artifactRefSchema,
    repo: repoRefSchema,
    goal: z.string().min(1),
    acceptance_criteria: z.array(z.string().min(1)),
    non_goals: z.array(z.string()),
    dependencies: z.array(dependencyRefSchema),
    provider_context: providerContextSchema,
    memory_bundle: memoryBundleSchema,
    policy: policyConstraintsSchema,
    capabilities: z.array(capabilitySchema),
    required_outputs: z.array(requiredOutputSchema),
    tool_permissions: z.array(z.string()),
    sandbox_profile: z.string().min(1),
    known_risks: z.array(z.string()),
    time_budget_minutes: z.number().int().positive(),
    mr_id: z.string().min(1),
    commit_sha: z.string().min(1),
    diff_summary: z.string(),
    developer_envelope: developerCompletionEnvelopeSchema,
    pipeline_artifacts: z.array(pipelineArtifactSchema),
    freshness: freshnessSchema,
  })
  .strict()
  .meta({
    id: "colony.packet.review.v1",
    title: "ReviewPacket",
    description:
      "Bounded context delivered to a Reviewer run. Adds the MR/PR head, diff summary, the Developer's prior envelope, and pipeline artifacts on top of the task packet.",
  });

export type ReviewPacket = z.infer<typeof reviewPacketSchema>;
