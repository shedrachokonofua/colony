import { describe, expect, it } from "bun:test";
import type { Fault } from "@colony/core";
import {
  PiBaseAgentRunner,
  DEVELOPER_ROLE_PROFILE,
} from "../src/pi-base-agent-runner.js";
import {
  PiAgentRuntimeAdapter,
  type PiRunner,
  type PiRunRequest,
  type PiRunResult,
} from "../src/pi-adapter.js";
import type { AgentRuntimePacket } from "../src/adapter.js";
import {
  LIVENESS_FAILURE_REASON,
  installRunGuards,
  type PiModelSpec,
} from "../src/pi-runner-common.js";
import type { Agent } from "@oh-my-pi/pi-agent-core";

describe("fault emission", () => {
  it("emits wall timeout fault as {model, wall_timeout}", async () => {
    const runner: PiRunner = {
      kind: "pi-coding-agent",
      run: async (_req: PiRunRequest): Promise<PiRunResult> => {
        return {
          sandboxId: "sb-1",
          envelope: { __unfinished: true },
          reason: "timeout_without_envelope",
          fault: {
            layer: "model",
            code: "wall_timeout",
            detail: "run timeout exceeded",
          },
        };
      },
    };
    const adapter = new PiAgentRuntimeAdapter(runner);
    const meta = await adapter.startRun(
      { goal: "test" },
      { role: "developer", runId: "run-wall" },
    );
    expect(meta.fault).toEqual({
      layer: "model",
      code: "wall_timeout",
      detail: "run timeout exceeded",
    });
  });

  it("emits watchdog wedge fault as {harness, watchdog_wedge}", async () => {
    let capturedFault: Fault | undefined;
    let capturedReason: string | undefined;

    const fakeAgent = {
      subscribe: () => () => {},
    } as unknown as Agent;

    let resolveDone!: () => void;
    const done = new Promise<void>((res) => {
      resolveDone = res;
    });

    const cleanup = installRunGuards(fakeAgent, "run-watchdog", {
      livenessTimeoutMs: 5,
      abort: () => {},
      onFailure: (reason, fault) => {
        capturedReason = reason;
        capturedFault = fault;
        resolveDone();
      },
    });

    try {
      await done;
      expect(capturedReason).toBe(LIVENESS_FAILURE_REASON);
      expect(capturedFault).toEqual({
        layer: "harness",
        code: "watchdog_wedge",
        detail: "liveness_watchdog_no_progress",
      });
    } finally {
      cleanup();
    }
  });

  it("emits workspace lost fault as {sandbox, workspace_lost}", async () => {
    const fakeModel: PiModelSpec = {
      id: "m",
      name: "m",
      provider: "p",
      api: "openai",
      baseUrl: "http://localhost",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    };
    // When scratchDir fails or repo provision fails, provisionProfileWorkspace throws.
    // However, if scratchDir is provided, provisionScratchDir is called.
    // If workspaceMode is repo-required, provisionRepoWorkspace is called.
    const runner = new PiBaseAgentRunner(DEVELOPER_ROLE_PROFILE, {
      model: fakeModel,
    });
    // With requireCredentials: true (default for DEVELOPER_ROLE_PROFILE repo workspace),
    // missing credentials throws workspace_provision_failed:missing_credentials
    const packet: AgentRuntimePacket = {
      goal: "test",
      repo: {
        url: "so/test",
        branch: "main",
        base_commit: "0123456789012345678901234567890123456789",
      },
    };
    const result = await runner.run({
      runId: "run-ws-lost",
      packet,
      environment: { role: "developer" },
    });
    expect(result.fault).toBeDefined();
    expect(result.fault?.layer).toBe("sandbox");
    expect(result.fault?.code).toBe("workspace_lost");
  });

  it("emits provider connection exhaustion as {provider, connection_exhausted}", async () => {
    const runner: PiRunner = {
      kind: "pi-coding-agent",
      run: async (): Promise<PiRunResult> => {
        return {
          sandboxId: "sb-provider",
          envelope: { __unfinished: true },
          reason: "provider_connection_failure: ECONNRESET",
          fault: {
            layer: "provider",
            code: "connection_exhausted",
            detail: "ECONNRESET",
          },
        };
      },
    };
    const adapter = new PiAgentRuntimeAdapter(runner);
    const meta = await adapter.startRun(
      {},
      { role: "developer", runId: "run-prov" },
    );
    expect(meta.fault).toEqual({
      layer: "provider",
      code: "connection_exhausted",
      detail: "ECONNRESET",
    });
  });

  it("emits session-init replacement as {harness, session_init_replaced}", async () => {
    const runner: PiRunner = {
      kind: "pi-coding-agent",
      run: async (): Promise<PiRunResult> => {
        return {
          sandboxId: "sb-harness",
          envelope: { __unfinished: true },
          reason: "session_init_replaced",
          fault: {
            layer: "harness",
            code: "session_init_replaced",
            detail: 'Agent "Main" was replaced during session initialization',
          },
        };
      },
    };
    const adapter = new PiAgentRuntimeAdapter(runner);
    const meta = await adapter.startRun(
      {},
      { role: "developer", runId: "run-session-init" },
    );
    expect(meta.fault).toEqual({
      layer: "harness",
      code: "session_init_replaced",
      detail: 'Agent "Main" was replaced during session initialization',
    });
  });

  it("emits envelope schema rejection as {model, envelope_rejected}", async () => {
    const runner: PiRunner = {
      kind: "pi-coding-agent",
      run: async (): Promise<PiRunResult> => {
        return {
          sandboxId: "sb-env",
          envelope: { invalid: true },
        };
      },
    };
    const adapter = new PiAgentRuntimeAdapter(runner);
    const meta = await adapter.startRun(
      {},
      { role: "developer", runId: "run-rejected" },
    );
    expect(meta.status).toBe("envelope_rejected");
    expect(meta.fault?.layer).toBe("model");
    expect(meta.fault?.code).toBe("envelope_rejected");
    expect(meta.fault?.detail).toBeDefined();
  });

  it("emits max turns exhausted as {model, max_turns}", () => {
    let capturedFault: Fault | undefined;
    const fakeAgent = {
      subscribe: (fn: (e: { type: string }) => void) => {
        // simulate max turns
        fn({ type: "turn_end" });
        fn({ type: "turn_end" });
        return () => {};
      },
    } as unknown as Agent;
    installRunGuards(fakeAgent, "run-turns", {
      maxTurns: 2,
      abort: () => {},
      onFailure: (_reason, fault) => {
        capturedFault = fault;
      },
    });
    expect(capturedFault).toEqual({
      layer: "model",
      code: "max_turns",
      detail: "turns >= 2",
    });
  });

  it("adapter finish wrapper maps unexpected throws to {unknown, unknown} and logs console.error", async () => {
    const runner: PiRunner = {
      kind: "pi-coding-agent",
      run: async (): Promise<PiRunResult> => {
        throw new Error("completely unexpected crash");
      },
    };
    const adapter = new PiAgentRuntimeAdapter(runner);
    const meta = await adapter.startRun(
      {},
      { role: "developer", runId: "run-throw" },
    );
    expect(meta.status).toBe("failed");
    expect(meta.fault).toEqual({
      layer: "unknown",
      code: "unknown",
      detail: "completely unexpected crash",
    });
  });
});
