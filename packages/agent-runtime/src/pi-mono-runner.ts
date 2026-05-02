import type { PiRunnerBaseOptions } from "./pi-runner-common.js";
import {
  DEFAULT_REVIEWER_TOOLS,
  PiBaseAgentRunner,
  REVIEWER_ROLE_PROFILE,
} from "./pi-base-agent-runner.js";

export type PiMonoRunnerOptions = PiRunnerBaseOptions;

export { DEFAULT_REVIEWER_TOOLS };

export class PiMonoRunner extends PiBaseAgentRunner {
  constructor(options: PiMonoRunnerOptions = {}) {
    super(REVIEWER_ROLE_PROFILE, options);
  }
}
