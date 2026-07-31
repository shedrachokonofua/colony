import type { PiRunnerBaseOptions } from "./pi-runner-common.js";
import {
  ARCHITECT_ROLE_PROFILE,
  DEFAULT_ARCHITECT_TOOLS,
  PiBaseAgentRunner,
} from "./pi-base-agent-runner.js";

export type PiArchitectRunnerOptions = PiRunnerBaseOptions;

export { DEFAULT_ARCHITECT_TOOLS };

export class PiArchitectRunner extends PiBaseAgentRunner {
  constructor(options: PiArchitectRunnerOptions = {}) {
    super(ARCHITECT_ROLE_PROFILE, options);
  }
}
