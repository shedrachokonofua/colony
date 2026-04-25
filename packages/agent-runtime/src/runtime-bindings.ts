import { sha256Json } from "./hashing.js";

export type RuntimeNetworkPosture = "permissive" | "restricted";

export interface RuntimeEnvBinding {
  readonly name: string;
  readonly value?: string;
  readonly valueFrom?: {
    readonly kind: "secret" | "configMap" | "fieldRef";
    readonly name: string;
    readonly key?: string;
  };
}

export interface RuntimeMountBinding {
  readonly name: string;
  readonly mountPath: string;
  readonly readOnly: boolean;
  readonly source: {
    readonly kind: "configMap" | "secret" | "persistentVolumeClaim" | "profile";
    readonly name: string;
    readonly key?: string;
  };
}

export interface RuntimeCredentialBinding {
  readonly name: string;
  readonly capability: string;
  readonly mountPath?: string;
  readonly env?: string;
  readonly broker: "tool-gateway" | "kubernetes-secret" | "external";
}

export interface RuntimeEgressBinding {
  readonly name: string;
  readonly kind: "dns" | "service" | "cidr" | "external";
  readonly target: string;
  readonly ports?: readonly number[];
}

export interface RuntimeServiceAccountBinding {
  readonly name: string;
  readonly automountToken: boolean;
  readonly rbacProfile: "none" | "read-only" | "custom";
}

export interface DeployerRuntimeBinding {
  readonly name: string;
  readonly environment: "local" | "dev" | "pilot" | "prod";
  readonly networkPosture: RuntimeNetworkPosture;
  readonly env: readonly RuntimeEnvBinding[];
  readonly configMounts: readonly RuntimeMountBinding[];
  readonly credentialBindings: readonly RuntimeCredentialBinding[];
  readonly egress: readonly RuntimeEgressBinding[];
  readonly serviceAccount: RuntimeServiceAccountBinding;
  readonly annotations?: Readonly<Record<string, string>>;
}

export interface RuntimeBindingSelection {
  readonly binding: DeployerRuntimeBinding;
  readonly hash: string;
}

export function selectRuntimeBinding(
  binding: DeployerRuntimeBinding,
): RuntimeBindingSelection {
  assertValidRuntimeBinding(binding);
  return {
    binding,
    hash: hashRuntimeBinding(binding),
  };
}

export function hashRuntimeBinding(binding: DeployerRuntimeBinding): string {
  return sha256Json(binding);
}

export function assertValidRuntimeBinding(
  binding: DeployerRuntimeBinding,
): void {
  if (!binding.name.trim()) {
    throw new Error("runtime binding name is required");
  }
  assertUnique(
    binding.env.map((entry) => entry.name),
    "runtime env binding",
  );
  assertUnique(
    binding.configMounts.map((entry) => entry.mountPath),
    "runtime mount path",
  );
  assertUnique(
    binding.credentialBindings.map((entry) => entry.name),
    "runtime credential binding",
  );
  for (const mount of binding.configMounts) {
    if (!mount.readOnly) {
      throw new Error(`runtime config mount must be read-only: ${mount.name}`);
    }
  }
  for (const credential of binding.credentialBindings) {
    if (!credential.mountPath && !credential.env) {
      throw new Error(
        `credential binding requires mountPath or env: ${credential.name}`,
      );
    }
  }
  if (
    (binding.environment === "pilot" || binding.environment === "prod") &&
    binding.networkPosture !== "restricted"
  ) {
    throw new Error("pilot/prod runtime bindings must use restricted network");
  }
  if (
    (binding.environment === "pilot" || binding.environment === "prod") &&
    binding.serviceAccount.automountToken
  ) {
    throw new Error(
      "pilot/prod sandbox service accounts must not automount tokens",
    );
  }
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}
