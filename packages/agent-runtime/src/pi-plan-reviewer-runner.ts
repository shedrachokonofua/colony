import type { PiRunnerBaseOptions } from "./pi-runner-common.js";
import {
  PiBaseAgentRunner,
  PLAN_REVIEWER_ROLE_PROFILE,
} from "./pi-base-agent-runner.js";

export type PiPlanReviewerRunnerOptions = PiRunnerBaseOptions;

/** The reviewer chain, pointed at a plan instead of a diff. */
export class PiPlanReviewerRunner extends PiBaseAgentRunner {
  constructor(options: PiPlanReviewerRunnerOptions = {}) {
    super(PLAN_REVIEWER_ROLE_PROFILE, options);
  }
}
