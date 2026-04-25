import { z } from "zod";
import { scopeIdSchema, taskIdSchema } from "../common.js";
import { envelopeBaseShape } from "./base.js";

export const PROPOSAL_KINDS = [
  "blocker",
  "in_scope_followup",
  "out_of_scope_followup",
  "scope_change",
  "refactor",
  "bug",
] as const;

export const URGENCIES = ["low", "medium", "high", "critical"] as const;

export const discoveredWorkRoleSpecificSchema = z
  .object({
    proposal_kind: z.enum(PROPOSAL_KINDS),
    title: z.string().min(1),
    description: z.string().min(1),
    evidence: z.array(z.string()),
    affected_paths: z.array(z.string()),
    urgency: z.enum(URGENCIES),
    blocks_current_task: z.boolean(),
  })
  .strict();

export const discoveredWorkEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    scope_id: scopeIdSchema,
    source_task_id: taskIdSchema,
    role_specific: discoveredWorkRoleSpecificSchema,
  })
  .strict()
  .meta({
    id: "colony.envelope.discovered_work.v1",
    title: "DiscoveredWorkEnvelope",
    description:
      "Agent-side proposal for new work uncovered mid-task. Supervisor classifies (blocker / in-scope follow-up / out-of-scope / scope change / rejected). Never auto-promoted to a task without policy + human approval.",
  });

export type DiscoveredWorkEnvelope = z.infer<
  typeof discoveredWorkEnvelopeSchema
>;
