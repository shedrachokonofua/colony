import type { PiRunnerBaseOptions } from "./pi-runner-common.js";
import {
  DEFAULT_ARCHITECT_TOOLS,
  PiBaseAgentRunner,
  REVIEWER_ROLE_PROFILE,
} from "./pi-base-agent-runner.js";

export type PiReviewerRunnerOptions = PiRunnerBaseOptions;

export { DEFAULT_ARCHITECT_TOOLS };

export class PiReviewerRunner extends PiBaseAgentRunner {
  constructor(options: PiReviewerRunnerOptions = {}) {
    super(REVIEWER_ROLE_PROFILE, options);
  }
}
