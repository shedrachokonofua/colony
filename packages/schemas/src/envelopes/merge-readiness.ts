import { z } from "zod";
import {
  PIPELINE_STATUSES,
  pipelineArtifactSchema,
  taskIdSchema,
} from "../common.js";
import { envelopeBaseShape } from "./base.js";

const approvalRefSchema = z
  .object({
    artifact_id: z.string().min(1),
    actor: z.string().min(1),
    commit_sha: z.string().min(1),
    approved_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export const mergeReadinessRoleSpecificSchema = z
  .object({
    head_commit_sha: z.string().min(1),
    pipeline_status: z.enum(PIPELINE_STATUSES),
    pipeline_artifacts: z.array(pipelineArtifactSchema),
    approvals: z.array(approvalRefSchema),
    blocking_thread_count: z.number().int().nonnegative(),
    open_review_findings: z.number().int().nonnegative(),
    human_approval_required: z.boolean(),
    human_approval_present: z.boolean(),
  })
  .strict();

export const mergeReadinessEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    task_id: taskIdSchema,
    role_specific: mergeReadinessRoleSpecificSchema,
  })
  .strict()
  .meta({
    id: "colony.envelope.merge_readiness.v1",
    title: "MergeReadinessEnvelope",
    description:
      "Supervisor-internal envelope summarizing the gate evaluation that opens (or refuses to open) the MR/PR merge gate. Artifacts plus pipeline + approvals + threads must all reconcile against the head commit.",
  });

export type MergeReadinessEnvelope = z.infer<
  typeof mergeReadinessEnvelopeSchema
>;
