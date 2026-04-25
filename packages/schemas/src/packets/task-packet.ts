import { z } from "zod";
import {
  artifactRefSchema,
  capabilitySchema,
  dependencyRefSchema,
  memoryBundleSchema,
  policyConstraintsSchema,
  providerContextSchema,
  repoRefSchema,
  requiredOutputSchema,
  scopeIdSchema,
  taskIdSchema,
} from "../common.js";
import { freshnessSchema } from "../freshness.js";

export const taskPacketSchema = z
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
    freshness: freshnessSchema,
  })
  .strict()
  .meta({
    id: "colony.packet.task.v1",
    title: "TaskPacket",
    description:
      "Bounded context delivered to Developer (and Architect during decomposition) runs. Provider prose is quoted via provider_context, never injected as instructions.",
  });

export type TaskPacket = z.infer<typeof taskPacketSchema>;
