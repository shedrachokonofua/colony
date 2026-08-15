import type { ColonyConfig } from "@colony/config";
import type { Store } from "@colony/core";
import type { ProviderAdapter } from "@colony/provider";
import type { AgentWiring } from "./agent-runtime.js";
import type { Logger } from "./logging.js";
import type { GateExecutor } from "./runs/merge-gate.js";

export interface ColonydContext {
  readonly store: Store;
  readonly provider: ProviderAdapter;
  readonly config: ColonyConfig;
  readonly agents: AgentWiring;
  readonly logger: Logger;
  readonly gateExecutor?: GateExecutor;
  readonly env: {
    readonly gitlabBaseUrl: string;
    readonly gitlabToken: string;
    readonly webhookSecret: string;
    readonly singleToken: boolean;
    readonly maxConcurrent: number;
    readonly maxAttempts: number;
  };
  /** Request an immediate tick (single-flight guarded by main). */
  requestTick(): void;
}

export const SERVICE_ACTOR = "svc:colonyd";
