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

const targetProjectSchema = z
  .object({
    role: z.string().min(1),
    provider: z.string().min(1),
    project_id: z.string().min(1),
    project_path: z.string().min(1),
    default_branch: z.string().min(1).optional(),
  })
  .strict();

const existingTaskSchema = z
  .object({
    task_id: taskIdSchema,
    title: z.string().min(1),
    state: taskStateSchema,
  })
  .strict();

export const architectPacketSchema = z
  .object({
    version: z.literal(1),
    scope_id: scopeIdSchema,
    provider_scope_artifact: artifactRefSchema,
    repo: repoRefSchema,
    scope_goal: z.string().min(1),
    scope_acceptance_criteria: z.array(z.string().min(1)),
    scope_non_goals: z.array(z.string()),
    scope_brief_version: z.string().min(1),
    target_projects: z.array(targetProjectSchema),
    existing_tasks: z.array(existingTaskSchema),
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
    id: "colony.packet.architect.v1",
    title: "ArchitectPacket",
    description:
      "Bounded context delivered to an Architect run that proposes a scope decomposition. Carries the scope brief, available provider project targets, any tasks already attached to the scope, and the freshness/policy envelope. Architect output is consumed only after the spec/DAG gate opens.",
  });

export type ArchitectPacket = z.infer<typeof architectPacketSchema>;
export type ArchitectTargetProject = z.infer<typeof targetProjectSchema>;
export type ArchitectExistingTask = z.infer<typeof existingTaskSchema>;
