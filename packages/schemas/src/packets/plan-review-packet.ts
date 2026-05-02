import { z } from "zod";
import { developerPlanEnvelopeSchema } from "../envelopes/developer-plan.js";
import { taskPacketSchema } from "./task-packet.js";

export const planReviewPacketSchema = taskPacketSchema
  .extend({
    developer_plan: developerPlanEnvelopeSchema,
    review_count: z.number().int().nonnegative(),
    loop_cap: z.number().int().positive(),
  })
  .strict()
  .meta({
    id: "colony.packet.plan_review.v1",
    title: "PlanReviewPacket",
    description:
      "Bounded context delivered to the Plan Reviewer run. Adds the developer_plan envelope and loop budget on top of the task packet.",
  });

export type PlanReviewPacket = z.infer<typeof planReviewPacketSchema>;
