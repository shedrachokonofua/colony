import { z } from "zod";

/**
 * Offline session-cost model for per-task implementer sessions: the median
 * wall-clock milliseconds per touched file across every landed attempt in
 * the runs table. Built by `buildTaskCostModel` (@colony/core) and stored
 * alongside predictions derived from it.
 */
export const TaskCostModelV1 = z
  .object({
    version: z.literal("v1"),
    sample_size: z.number().int().nonnegative(),
    ms_per_file: z.number().nonnegative(),
  })
  .strict();

export type TaskCostModelV1 = z.infer<typeof TaskCostModelV1>;
