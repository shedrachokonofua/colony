import type { z } from "zod";

import { architectDecompositionEnvelopeSchema } from "./envelopes/architect-decomposition.js";
import { blockedEnvelopeSchema } from "./envelopes/blocked.js";
import { developerCompletionEnvelopeSchema } from "./envelopes/developer-completion.js";
import { discoveredWorkEnvelopeSchema } from "./envelopes/discovered-work.js";
import { mergeReadinessEnvelopeSchema } from "./envelopes/merge-readiness.js";
import { reviewerReviewEnvelopeSchema } from "./envelopes/reviewer-review.js";
import { scopeReviewEnvelopeSchema } from "./envelopes/scope-review.js";
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
