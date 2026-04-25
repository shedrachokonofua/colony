import { z } from "zod";
import { artifactRefSchema, riskLevelSchema } from "../common.js";
import { freshnessSchema } from "../freshness.js";

export const ENVELOPE_RESULTS = [
  "done",
  "changes_requested",
  "approved",
  "blocked",
  "escalate",
] as const;

export const envelopeResultSchema = z.enum(ENVELOPE_RESULTS);

export const NEXT_ACTIONS = [
  "request_review",
  "merge",
  "close",
  "wait_human",
  "return_to_author",
  "request_human_review",
  "propose_decomposition",
  "propose_discovered_work",
  "open_gate",
  "report_blocked",
  "escalate",
] as const;

export const nextActionSchema = z.enum(NEXT_ACTIONS);

export const envelopeBaseShape = {
  version: z.literal(1),
  result: envelopeResultSchema,
  confidence: z.number().min(0).max(1),
  requires_human: z.boolean(),
  risk_level: riskLevelSchema,
  artifacts: z.array(artifactRefSchema),
  policy_flags: z.array(z.string()),
  next_action: nextActionSchema,
  freshness: freshnessSchema,
  rationale: z.string(),
} as const;
