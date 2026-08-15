import { z } from "zod";

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
