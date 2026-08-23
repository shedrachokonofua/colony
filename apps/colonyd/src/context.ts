import type { ColonyConfig } from "@colony/config";
import type { Store } from "@colony/core";
import type { SandboxEngine } from "@colony/sandbox";
import type { ProviderAdapter } from "@colony/provider";
import type { AgentWiring } from "./agent-runtime.js";
import type { Logger } from "./logging.js";
import type { TokenVerifier } from "./oidc.js";
import type { GateExecutor } from "./runs/merge-gate.js";
import type { ValidateExecutor } from "./runs/validate.js";

export interface ColonydContext {
  readonly store: Store;
  readonly provider: ProviderAdapter;
  readonly config: ColonyConfig;
  readonly agents: AgentWiring;
  readonly logger: Logger;
  readonly gateExecutor?: GateExecutor;
  /** Test seam: overrides the credential-free validation command runner. */
  readonly validateExecutor?: ValidateExecutor;
  /** Sandbox engine used to provision scope-validation handles. */
  readonly validateEngine?: SandboxEngine;
  /** Test seam: overrides the verifier built from env.oidcIssuer. */
  readonly oidcVerifier?: TokenVerifier;
  readonly env: {
    readonly gitlabBaseUrl: string;
    readonly gitlabToken: string;
    readonly webhookSecret: string;
    readonly singleToken: boolean;
    readonly maxConcurrent: number;
    readonly maxAttempts: number;
    readonly oidcIssuer: string;
    readonly oidcClientId: string;
    readonly oidcRequiredRole: string;
    /** Trace-UI deep-link base for the console; empty when unconfigured. */
    readonly traceUiBaseUrl: string;
  };
  /** Request an immediate tick (single-flight guarded by main). */
  requestTick(): void;
}

export const SERVICE_ACTOR = "svc:colonyd";
