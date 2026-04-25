import { z } from "zod";
import { taskIdSchema } from "../common.js";
import { envelopeBaseShape } from "./base.js";

export const developerCompletionRoleSpecificSchema = z
  .object({
    tests_added: z.array(z.string()),
    tests_modified: z.array(z.string()).optional(),
    self_review_notes: z.string(),
    follow_up_proposals: z.array(z.string()).optional(),
  })
  .strict();

export const developerCompletionEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    task_id: taskIdSchema,
    role_specific: developerCompletionRoleSpecificSchema,
  })
  .strict()
  .meta({
    id: "colony.envelope.developer.completion.v1",
    title: "DeveloperCompletionEnvelope",
    description:
      "Developer output emitted when a task run finishes. Must reference the MR/PR and head commit in artifacts; Supervisor uses freshness + envelope to advance the task to review_requested.",
  });

export type DeveloperCompletionEnvelope = z.infer<
  typeof developerCompletionEnvelopeSchema
>;
