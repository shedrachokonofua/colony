import { z } from "zod";

export const ArchitectDecompositionV2 = z
  .object({
    kind: z.literal("architect_decomposition"),
    summary: z.string().min(1),
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
