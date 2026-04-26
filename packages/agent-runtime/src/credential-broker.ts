import type { AgentRunEnvironment, AgentRuntimePacket } from "./adapter.js";

export interface CredentialResolveRequest {
  readonly provider: string;
  readonly capability: string;
  readonly bindingName: string;
  readonly environment: AgentRunEnvironment;
}

export interface ToolAuthorizationRequest {
  readonly toolName: string;
  readonly args: unknown;
  readonly packet: AgentRuntimePacket;
  readonly environment: AgentRunEnvironment;
}

export interface ToolAuthorizationResult {
  readonly allow: boolean;
  readonly reason?: string;
}

export interface CredentialBroker {
  resolve(
    request: CredentialResolveRequest,
  ): Promise<string | undefined> | string | undefined;
  authorizeTool?(
    request: ToolAuthorizationRequest,
  ):
    | Promise<ToolAuthorizationResult | undefined>
    | ToolAuthorizationResult
    | undefined;
}

export const permissiveCredentialBroker: CredentialBroker = {
  resolve: () => undefined,
  authorizeTool: () => ({ allow: true }),
};
