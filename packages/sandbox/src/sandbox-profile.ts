import type { SandboxCapability } from "./run-extensions.js";
import {
  EMPTY_SANDBOX_RUN_EXTENSIONS,
  type SandboxRunExtensions,
  assertValidRunExtensions,
} from "./run-extensions.js";

export const SANDBOX_ROLES = ["developer", "reviewer", "validate"] as const;
export type SandboxRole = (typeof SANDBOX_ROLES)[number];

export const SANDBOX_ROLE_LABEL = "colony.shdr.ch/sandbox-role" as const;
export const SANDBOX_PART_OF_LABEL = "app.kubernetes.io/part-of" as const;
export const SANDBOX_PART_OF_VALUE = "colony" as const;

export type SandboxRuntimeClass = "gvisor";

export interface SandboxEgressService {
  readonly kind: "service";
  readonly namespace: string;
  readonly name: string;
  readonly ports: readonly number[];
  readonly note?: string;
}

export interface SandboxEgressKubeDns {
  readonly kind: "kube-dns";
}

export type SandboxEgressTarget = SandboxEgressService | SandboxEgressKubeDns;

export interface SandboxEgressDeny {
  readonly kind: "service";
  readonly namespace: string;
  readonly name: string;
  readonly reason: string;
}

export interface SandboxResourceLimits {
  readonly cpu: string;
  readonly memory: string;
  readonly ephemeralStorage: string;
  /** PVC size for the /workspace ephemeral volume (ceph thin-provisioned). */
  readonly workspaceStorage: string;
}

/**
 * Scheduler requests, deliberately far below the limits: a sandbox idles at
 * ~0 CPU while its agent waits on the model and peaked at 0.4 CPU / 670Mi
 * under a full monorepo test run (measured 2026-08-30). Requests size the
 * namespace quota footprint; limits still grant full burst.
 */
export interface SandboxResourceRequests {
  readonly cpu: string;
  readonly memory: string;
}

export interface SandboxLaunchProfile {
  readonly role: SandboxRole;
  readonly actorRole: "developer" | "reviewer";
  readonly runtimeClass: SandboxRuntimeClass;
  readonly podLabels: Readonly<Record<string, string>>;
  readonly egressAllowlist: readonly SandboxEgressTarget[];
  readonly egressDenylist: readonly SandboxEgressDeny[];
  readonly envAllowlist: readonly string[];
  readonly capabilities: readonly SandboxCapability[];
  readonly runExtensions: SandboxRunExtensions;
  readonly resourceLimits: SandboxResourceLimits;
  readonly resourceRequests: SandboxResourceRequests;
  readonly readOnlyRootFilesystem: boolean;
}

export interface SandboxNamespaceRefs {
  readonly controlPlaneNamespace: string;
  readonly toolGatewayServiceName: string;
  readonly toolGatewayPort: number;
  readonly taskGraphApiServiceName: string;
}

export const DEFAULT_SANDBOX_REFS: SandboxNamespaceRefs = {
  controlPlaneNamespace: "colony",
  toolGatewayServiceName: "colony-tool-gateway",
  toolGatewayPort: 4200,
  taskGraphApiServiceName: "colony-api",
};

const DEVELOPER_CAPABILITIES: readonly SandboxCapability[] = [
  "sandbox.exec",
  "tool.call",
  "provider.branches.push",
  "provider.commits.read",
];

const REVIEWER_CAPABILITIES: readonly SandboxCapability[] = [
  "sandbox.exec",
  "tool.call",
  "provider.commits.read",
];

const VALIDATE_CAPABILITIES: readonly SandboxCapability[] = ["sandbox.exec"];

const DEVELOPER_RESOURCES: SandboxResourceLimits = {
  cpu: "2",
  memory: "4Gi",
  ephemeralStorage: "8Gi",
  // 10 claims x 16Gi fits the namespace's 200Gi requests.storage quota.
  workspaceStorage: "16Gi",
};

const DEVELOPER_REQUESTS: SandboxResourceRequests = {
  cpu: "500m",
  memory: "1536Mi",
};

const REVIEWER_RESOURCES: SandboxResourceLimits = {
  cpu: "1",
  memory: "2Gi",
  ephemeralStorage: "4Gi",
  workspaceStorage: "8Gi",
};

const REVIEWER_REQUESTS: SandboxResourceRequests = {
  cpu: "250m",
  memory: "1Gi",
};

const VALIDATE_ENV_ALLOWLIST: readonly string[] = [
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
];

const COMMON_ENV_ALLOWLIST: readonly string[] = [
  "COLONY_RUN_ID",
  "COLONY_TASK_ID",
  "COLONY_SCOPE_ID",
  "COLONY_PACKET_HASH",
  "COLONY_TOOL_GATEWAY_URL",
  "COLONY_TOOL_GATEWAY_TOKEN",
  "COLONY_SANDBOX_ROLE",
];

export interface BuildLaunchProfileOptions {
  readonly refs?: SandboxNamespaceRefs;
  readonly runExtensions?: SandboxRunExtensions;
}

export function buildSandboxLaunchProfile(
  role: SandboxRole,
  options: BuildLaunchProfileOptions = {},
): SandboxLaunchProfile {
  const refs = options.refs ?? DEFAULT_SANDBOX_REFS;
  const runExtensions = options.runExtensions ?? EMPTY_SANDBOX_RUN_EXTENSIONS;
  assertValidRunExtensions(runExtensions);

  const podLabels = {
    [SANDBOX_PART_OF_LABEL]: SANDBOX_PART_OF_VALUE,
    [SANDBOX_ROLE_LABEL]: role,
    "app.kubernetes.io/component": "agent-sandbox",
    "app.kubernetes.io/managed-by": "colony-supervisor",
  } as const;

  const egressAllowlist: SandboxEgressTarget[] = [
    { kind: "kube-dns" },
    {
      kind: "service",
      namespace: refs.controlPlaneNamespace,
      name: refs.toolGatewayServiceName,
      ports: [refs.toolGatewayPort],
      note: "Agents reach git, package registries, and LLM endpoints only via Tool Gateway.",
    },
  ];

  const egressDenylist: SandboxEgressDeny[] = [
    {
      kind: "service",
      namespace: refs.controlPlaneNamespace,
      name: refs.taskGraphApiServiceName,
      reason:
        "Agents must not call the Task Graph API directly. They consume packets and return envelopes via the Supervisor workflow.",
    },
  ];

  if (role === "validate") {
    return {
      role,
      actorRole: "reviewer",
      runtimeClass: "gvisor",
      podLabels,
      egressAllowlist,
      egressDenylist,
      envAllowlist: VALIDATE_ENV_ALLOWLIST,
      capabilities: VALIDATE_CAPABILITIES,
      runExtensions: EMPTY_SANDBOX_RUN_EXTENSIONS,
      resourceLimits: REVIEWER_RESOURCES,
      resourceRequests: REVIEWER_REQUESTS,
      readOnlyRootFilesystem: true,
    };
  }

  if (role === "developer") {
    return {
      role,
      actorRole: "developer",
      runtimeClass: "gvisor",
      podLabels,
      egressAllowlist,
      egressDenylist,
      envAllowlist: COMMON_ENV_ALLOWLIST,
      capabilities: DEVELOPER_CAPABILITIES,
      runExtensions,
      resourceLimits: DEVELOPER_RESOURCES,
      resourceRequests: DEVELOPER_REQUESTS,
      readOnlyRootFilesystem: false,
    };
  }

  return {
    role,
    actorRole: "reviewer",
    runtimeClass: "gvisor",
    podLabels,
    egressAllowlist,
    egressDenylist,
    envAllowlist: COMMON_ENV_ALLOWLIST,
    capabilities: REVIEWER_CAPABILITIES,
    runExtensions,
    resourceLimits: REVIEWER_RESOURCES,
    resourceRequests: REVIEWER_REQUESTS,
    readOnlyRootFilesystem: true,
  };
}
