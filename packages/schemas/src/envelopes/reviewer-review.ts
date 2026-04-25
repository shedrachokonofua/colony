import { z } from "zod";
import { severitySchema, taskIdSchema } from "../common.js";
import { envelopeBaseShape } from "./base.js";

export const reviewFindingSchema = z
  .object({
    severity: severitySchema,
    evidence: z.string().min(1),
    acceptance_criterion_ref: z.string().optional(),
    suggested_fix: z.string().optional(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const reviewerRoleSpecificSchema = z
  .object({
    findings: z.array(reviewFindingSchema),
    summary: z.string().optional(),
  })
  .strict();

export const reviewerReviewEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    task_id: taskIdSchema,
    role_specific: reviewerRoleSpecificSchema,
  })
  .strict()
  .meta({
    id: "colony.envelope.reviewer.review.v1",
    title: "ReviewerReviewEnvelope",
    description:
      "Reviewer output for an MR/PR review. Findings carry severity, evidence, the acceptance criterion they reference, and per-finding confidence.",
  });

export type ReviewerReviewEnvelope = z.infer<
  typeof reviewerReviewEnvelopeSchema
>;
