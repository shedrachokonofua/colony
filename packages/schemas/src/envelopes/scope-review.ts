import { z } from "zod";
import { scopeIdSchema, taskIdSchema } from "../common.js";
import { envelopeBaseShape } from "./base.js";
import { reviewFindingSchema } from "./reviewer-review.js";

const unresolvedItemSchema = z
  .object({
    kind: z.enum([
      "conflict",
      "pending_sync",
      "blocked_task",
      "open_proposal",
      "missing_artifact",
    ]),
    task_id: taskIdSchema.optional(),
    description: z.string().min(1),
  })
  .strict();

export const scopeReviewRoleSpecificSchema = z
  .object({
    findings: z.array(reviewFindingSchema),
    unresolved_items: z.array(unresolvedItemSchema),
    summary: z.string(),
    recommendation: z.enum([
      "approve_scope_close",
      "request_changes",
      "block_release",
      "escalate",
    ]),
  })
  .strict();

export const scopeReviewEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    scope_id: scopeIdSchema,
    role_specific: scopeReviewRoleSpecificSchema,
  })
  .strict()
  .meta({
    id: "colony.envelope.scope_review.v1",
    title: "ScopeReviewEnvelope",
    description:
      "Reviewer output for the scope close gate. Aggregates findings and unresolved items across child tasks, and recommends approval / changes / block / escalate.",
  });

export type ScopeReviewEnvelope = z.infer<typeof scopeReviewEnvelopeSchema>;
