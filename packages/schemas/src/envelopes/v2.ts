import { z } from "zod";

export const ArchitectDecompositionV2 = z
  .object({
    kind: z.literal("architect_decomposition"),
    summary: z.string().min(1),
    acceptance: z
      .array(
        z
          .object({
            description: z.string().min(1),
            command: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    tasks: z
      .array(
        z.object({
          title: z.string().min(1),
          spec: z.string().min(1), // outcome-oriented markdown: goal, user-observable behavior, invariants, required evidence
          depends_on: z.array(z.number().int().nonnegative()).default([]), // indexes into this same array
        }),
      )
      .min(1)
      .max(20),
  })
  .strict();

export type ArchitectDecompositionV2 = z.infer<typeof ArchitectDecompositionV2>;

export const ImplementerCompletionV2 = z
  .object({
    kind: z.literal("implementer_completion"),
    status: z.enum(["complete", "blocked"]),
    summary: z.string().min(1),
    branch: z.string().min(1),
    head_sha: z.string().regex(/^[0-9a-f]{40}$/),
    commands: z
      .array(z.object({ cmd: z.string(), exit_code: z.number().int() }))
      .default([]),
    blocked_reason: z.string().optional(),
  })
  .strict();

export type ImplementerCompletionV2 = z.infer<typeof ImplementerCompletionV2>;

export const ReviewerVerdictV2 = z
  .object({
    kind: z.literal("reviewer_verdict"),
    verdict: z.enum(["approve", "request_changes"]),
    summary: z.string().min(1),
    findings: z
      .array(
        z.object({
          severity: z.enum(["blocker", "major", "minor"]),
          file: z.string().min(1).optional(),
          note: z.string().min(1),
        }),
      )
      .default([]),
    // What the reviewer actually read against the spec. An approve is a
    // claim about the diff; it must name the files behind it. 123 of 123
    // approvals in one 48h window carried zero findings and a summary under
    // 80 chars (2026-09-02) - the schema permitted "LGTM".
    inspected: z
      .array(
        z.object({
          file: z.string().min(1),
          note: z.string().min(1),
        }),
      )
      .default([]),
    // the SHA the reviewer actually inspected; colonyd rejects a mismatch
    head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict()
  .refine((v) => v.verdict !== "request_changes" || v.findings.length > 0, {
    message: "request_changes requires at least one finding",
  })
  .refine((v) => v.verdict !== "approve" || v.inspected.length > 0, {
    message:
      "approve requires at least one inspected file with a note on what was checked",
  })
  .refine((v) => v.verdict !== "approve" || v.summary.trim().length >= 80, {
    message:
      "approve requires a substantive summary (>= 80 chars): what the change does and why it satisfies the spec",
  });

export type ReviewerVerdictV2 = z.infer<typeof ReviewerVerdictV2>;
