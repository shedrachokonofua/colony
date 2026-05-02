import { z } from "zod";
import { taskIdSchema } from "../common.js";
import { reviewFindingSchema } from "./reviewer-review.js";
import { envelopeBaseShape } from "./base.js";

export const planReviewRoleSpecificSchema = z
  .object({
    findings: z.array(reviewFindingSchema),
    summary: z.string(),
  })
  .strict();

export const planReviewEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    task_id: taskIdSchema,
    role_specific: planReviewRoleSpecificSchema,
  })
  .strict()
  .meta({
    id: "colony.envelope.plan_review.v1",
    title: "PlanReviewEnvelope",
    description:
      "Specialized reviewer output for the pre-implementation developer plan gate.",
  });

export type PlanReviewEnvelope = z.infer<typeof planReviewEnvelopeSchema>;
