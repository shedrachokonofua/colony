import type { PiBaseAgentRunnerOptions } from "./pi-base-agent-runner.js";
import {
  ARCHITECT_ROLE_PROFILE,
  DEFAULT_ARCHITECT_TOOLS,
  PiBaseAgentRunner,
} from "./pi-base-agent-runner.js";

export type PiArchitectRunnerOptions = PiBaseAgentRunnerOptions;

export { DEFAULT_ARCHITECT_TOOLS };
export { ARCHITECT_STAGES, buildArchitectStages } from "./architect-stages.js";
export type { ArchitectStage, ArchitectStageName } from "./architect-stages.js";

export class PiArchitectRunner extends PiBaseAgentRunner {
  constructor(options: PiArchitectRunnerOptions = {}) {
    super(ARCHITECT_ROLE_PROFILE, options);
  }
}
