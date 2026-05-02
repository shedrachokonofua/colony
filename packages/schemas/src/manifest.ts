import type { z } from "zod";

import { architectDecompositionEnvelopeSchema } from "./envelopes/architect-decomposition.js";
import { blockedEnvelopeSchema } from "./envelopes/blocked.js";
import { developerCompletionEnvelopeSchema } from "./envelopes/developer-completion.js";
import { developerPlanEnvelopeSchema } from "./envelopes/developer-plan.js";
import { discoveredWorkEnvelopeSchema } from "./envelopes/discovered-work.js";
import { mergeReadinessEnvelopeSchema } from "./envelopes/merge-readiness.js";
import { planReviewEnvelopeSchema } from "./envelopes/plan-review.js";
import { reviewerReviewEnvelopeSchema } from "./envelopes/reviewer-review.js";
import { scopeReviewEnvelopeSchema } from "./envelopes/scope-review.js";
import { architectPacketSchema } from "./packets/architect-packet.js";
import { planReviewPacketSchema } from "./packets/plan-review-packet.js";
import { reviewPacketSchema } from "./packets/review-packet.js";
import { scopeReviewPacketSchema } from "./packets/scope-review-packet.js";
import { taskPacketSchema } from "./packets/task-packet.js";

export type SchemaKind = "envelope" | "packet";

export interface SchemaSpec {
  readonly kind: SchemaKind;
  readonly name: string;
  readonly version: number;
  readonly schema: z.ZodType;
}

export const SCHEMAS: ReadonlyArray<SchemaSpec> = [
  {
    kind: "packet",
    name: "task",
    version: 1,
    schema: taskPacketSchema,
  },
  {
    kind: "packet",
    name: "plan_review",
    version: 1,
    schema: planReviewPacketSchema,
  },
  {
    kind: "packet",
    name: "review",
    version: 1,
    schema: reviewPacketSchema,
  },
  {
    kind: "packet",
    name: "scope_review",
    version: 1,
    schema: scopeReviewPacketSchema,
  },
  {
    kind: "packet",
    name: "architect",
    version: 1,
    schema: architectPacketSchema,
  },
  {
    kind: "envelope",
    name: "architect.decomposition",
    version: 1,
    schema: architectDecompositionEnvelopeSchema,
  },
  {
    kind: "envelope",
    name: "developer.completion",
    version: 1,
    schema: developerCompletionEnvelopeSchema,
  },
  {
    kind: "envelope",
    name: "developer_plan",
    version: 1,
    schema: developerPlanEnvelopeSchema,
  },
  {
    kind: "envelope",
    name: "plan_review",
    version: 1,
    schema: planReviewEnvelopeSchema,
  },
  {
    kind: "envelope",
    name: "reviewer.review",
    version: 1,
    schema: reviewerReviewEnvelopeSchema,
  },
  {
    kind: "envelope",
    name: "discovered_work",
    version: 1,
    schema: discoveredWorkEnvelopeSchema,
  },
  {
    kind: "envelope",
    name: "blocked",
    version: 1,
    schema: blockedEnvelopeSchema,
  },
  {
    kind: "envelope",
    name: "merge_readiness",
    version: 1,
    schema: mergeReadinessEnvelopeSchema,
  },
  {
    kind: "envelope",
    name: "scope_review",
    version: 1,
    schema: scopeReviewEnvelopeSchema,
  },
];
