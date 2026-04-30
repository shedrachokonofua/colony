import { z } from "zod";
import { scopeIdSchema, taskIdSchema } from "../common.js";
import { envelopeBaseShape } from "./base.js";

const proposedDependencyKindSchema = z.enum([
  "blocks",
  "parent_child",
  "related",
]);

const proposedTaskSchema = z
  .object({
    proposed_task_id: taskIdSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    acceptance_criteria: z.array(z.string().min(1)).min(1),
    non_goals: z.array(z.string()),
    // Architect output is advisory: this is a free-form hint. The supervisor
    // routes work to the developer runner today; reviewer/architect roles are
    // chosen separately. Generic decompositions naturally want labels like
    // "qa", "frontend", "ops" — accept any non-empty string.
    suggested_role: z.string().min(1),
    // Architect output is advisory: it lists capabilities *suggested* for
    // the worker bot but the supervisor + policy layer is the source of
    // truth on actual grants. Accept arbitrary strings here; mismatches
    // surface during commit if the policy denies them.
    suggested_capabilities: z.array(z.string()),
    estimated_effort_minutes: z.number().int().positive().optional(),
  })
  .strict();

const proposedDependencySchema = z
  .object({
    from_task_id: taskIdSchema,
    to_task_id: taskIdSchema,
    kind: proposedDependencyKindSchema,
  })
  .strict();

export const architectDecompositionRoleSpecificSchema = z
  .object({
    proposed_tasks: z.array(proposedTaskSchema).min(1),
    proposed_dependencies: z.array(proposedDependencySchema),
    open_questions: z.array(z.string()),
    assumptions: z.array(z.string()),
  })
  .strict();

export const architectDecompositionEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    scope_id: scopeIdSchema,
    role_specific: architectDecompositionRoleSpecificSchema,
  })
  .strict()
  .meta({
    id: "colony.envelope.architect.decomposition.v1",
    title: "ArchitectDecompositionEnvelope",
    description:
      "Architect output proposing a scope decomposition. Supervisor consumes this to seed tasks + dependencies after the spec/DAG gate opens.",
  });

export type ArchitectDecompositionEnvelope = z.infer<
  typeof architectDecompositionEnvelopeSchema
>;
