import type { PiRunnerBaseOptions } from "./pi-runner-common.js";
import {
  DEFAULT_DEVELOPER_TOOLS,
  DEVELOPER_ROLE_PROFILE,
  PiBaseAgentRunner,
  type PiBaseAgentRunnerOptions,
} from "./pi-base-agent-runner.js";

export interface PiCodingAgentRunnerOptions extends PiRunnerBaseOptions {
  readonly developerTools?: readonly string[];
  readonly logToolArgs?: boolean;
}

export { DEFAULT_DEVELOPER_TOOLS };

export class PiCodingAgentRunner extends PiBaseAgentRunner {
  constructor(options: PiCodingAgentRunnerOptions = {}) {
    const { developerTools, ...baseOptions } = options;
    super(DEVELOPER_ROLE_PROFILE, {
      ...(baseOptions as PiBaseAgentRunnerOptions),
      tools: developerTools,
    });
  }
}
