import type { PiRunnerBaseOptions } from "./pi-runner-common.js";
import {
  DEVELOPER_PLANNER_ROLE_PROFILE,
  PiBaseAgentRunner,
  PLAN_REVIEWER_ROLE_PROFILE,
} from "./pi-base-agent-runner.js";

export type PiPlanRunnerOptions = PiRunnerBaseOptions;

export class PiDeveloperPlanRunner extends PiBaseAgentRunner {
  constructor(options: PiPlanRunnerOptions = {}) {
    super(DEVELOPER_PLANNER_ROLE_PROFILE, options);
  }
}

export class PiPlanReviewRunner extends PiBaseAgentRunner {
  constructor(options: PiPlanRunnerOptions = {}) {
    super(PLAN_REVIEWER_ROLE_PROFILE, options);
  }
}
