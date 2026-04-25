import { z } from "zod";
import { taskIdSchema } from "../common.js";
import { envelopeBaseShape } from "./base.js";

export const BLOCKER_CLASSES = [
  "missing_approval",
  "failing_pipeline",
  "external_dep",
  "ambiguous_requirement",
  "missing_capability",
  "provider_outage",
  "infrastructure",
  "policy_violation",
  "other",
] as const;

export const blockedRoleSpecificSchema = z
  .object({
    blocker_class: z.enum(BLOCKER_CLASSES),
    description: z.string().min(1),
    expected_unblock: z.string().optional(),
    needs_human: z.boolean(),
    referenced_artifacts: z.array(z.string()),
  })
  .strict();

export const blockedEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    task_id: taskIdSchema,
    role_specific: blockedRoleSpecificSchema,
  })
  .strict()
  .meta({
    id: "colony.envelope.blocked.v1",
    title: "BlockedEnvelope",
    description:
      "Emitted when an agent run cannot make progress without human or external action. Supervisor moves the task to `blocked` and surfaces the blocker class to operators.",
  });

export type BlockedEnvelope = z.infer<typeof blockedEnvelopeSchema>;
