import { z } from "zod";
import { taskIdSchema } from "../common.js";
import { envelopeBaseShape } from "./base.js";

export const developerPlanRoleSpecificSchema = z
  .object({
    approach: z.string().min(1),
    files_to_touch: z.array(z.string().min(1)),
    tests_to_add: z.array(z.string().min(1)),
    risks: z.array(z.string()),
  })
  .strict();

export const developerPlanEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    task_id: taskIdSchema,
    role_specific: developerPlanRoleSpecificSchema,
  })
  .strict()
  .meta({
    id: "colony.envelope.developer_plan.v1",
    title: "DeveloperPlanEnvelope",
    description:
      "Developer planning output emitted before code changes. Captures approach, intended files, tests, and risks for reviewer approval.",
  });

export type DeveloperPlanEnvelope = z.infer<typeof developerPlanEnvelopeSchema>;
