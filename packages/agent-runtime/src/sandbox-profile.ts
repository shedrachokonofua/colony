import type { Capability, Role } from "@colony/domain";
import {
  EMPTY_SANDBOX_RUN_EXTENSIONS,
  type SandboxRunExtensions,
  assertValidRunExtensions,
} from "./run-extensions.js";

export const SANDBOX_ROLES = ["developer", "reviewer"] as const;
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
}

export interface SandboxLaunchProfile {
  readonly role: SandboxRole;
  readonly actorRole: Role;
  readonly runtimeClass: SandboxRuntimeClass;
  readonly podLabels: Readonly<Record<string, string>>;
  readonly egressAllowlist: readonly SandboxEgressTarget[];
  readonly egressDenylist: readonly SandboxEgressDeny[];
  readonly envAllowlist: readonly string[];
  readonly capabilities: readonly Capability[];
  readonly runExtensions: SandboxRunExtensions;
  readonly resourceLimits: SandboxResourceLimits;
  readonly readOnlyRootFilesystem: boolean;
}

export interface SandboxNamespaceRefs {
  readonly controlPlaneNamespace: string;
  readonly toolGatewayServiceName: string;
  readonly toolGatewayPort: number;
  readonly taskGraphApiServiceName: string;
}

export const DEFAULT_SANDBOX_REFS: SandboxNamespaceRefs = {
  controlPlaneNamespace: "colony-dev",
  toolGatewayServiceName: "colony-tool-gateway",
  toolGatewayPort: 4200,
  taskGraphApiServiceName: "colony-api",
};

const DEVELOPER_CAPABILITIES: readonly Capability[] = [
  "sandbox.exec",
  "tool.call",
  "provider.branches.push",
  "provider.commits.read",
];

const REVIEWER_CAPABILITIES: readonly Capability[] = [
  "sandbox.exec",
  "tool.call",
  "provider.commits.read",
];

const DEVELOPER_RESOURCES: SandboxResourceLimits = {
  cpu: "2",
  memory: "4Gi",
  ephemeralStorage: "8Gi",
};

const REVIEWER_RESOURCES: SandboxResourceLimits = {
  cpu: "1",
  memory: "2Gi",
  ephemeralStorage: "4Gi",
};

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
    readOnlyRootFilesystem: true,
  };
}
