import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { Fault } from "@colony/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  PiBaseAgentRunner,
  REVIEWER_ROLE_PROFILE,
  classifyProvisionFailure,
} from "../src/pi-base-agent-runner.js";
import {
  PiAgentRuntimeAdapter,
  type PiRunner,
  type PiRunRequest,
  type PiRunResult,
} from "../src/pi-adapter.js";
import {
  LIVENESS_FAILURE_REASON,
  installRunGuards,
  workspaceProbeStep,
  type WorkspaceProbeHandle,
  type WorkspaceProbeOptions,
  type WorkspaceProbeState,
} from "../src/pi-runner-common.js";
import type { Agent } from "@oh-my-pi/pi-agent-core";

/** The sandbox codes the attempt-budget consumer is told to expect. */
const SANDBOX_FAULT_CODES = [
  "workspace_lost",
  "probe_failed",
  "workspace_eacces",
  "sandbox_cr_missing",
  "exec_transport",
];

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
    let faults: Fault[] = [];
    let lost = 0;
    const state: WorkspaceProbeState = { misses: 0, fired: false };
    const options: WorkspaceProbeOptions = {
      runId: "run-ws-lost",
      sandboxId: "sb-ws-lost",
      onLost: () => {
        lost += 1;
      },
    };
    // Two completed marker checks that find nothing: exactly the evidence
    // `workspaceProbeStep` is specified to call loss.
    const handle: WorkspaceProbeHandle = {
      exec: () => Promise.resolve({ exitCode: 1 }),
    };
    await workspaceProbeStep(handle, state, options, (fault) => {
      faults.push(fault);
    });
    expect(
      await workspaceProbeStep(handle, state, options, (fault) => {
        faults.push(fault);
      }),
    ).toBe(true);
    expect(lost).toBe(1);
    expect(faults).toEqual([
      {
        layer: "sandbox",
        code: "workspace_lost",
        detail: "workspace marker check failed",
      },
    ]);
  });

  // A code outside this set is invisible to the attempt-budget consumer, so
  // every provision failure - including the ones nothing matches - must land
  // on one of them.
  it("classifies every provision failure into the sandbox contract", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        "workspace_provision_failed:packet_seed_failed: EACCES",
        "workspace_eacces",
      ],
      // EROFS is a read-only filesystem, not a lost one: it is the same
      // filesystem contract as EACCES, so it shares that code.
      ["workspace_provision_failed:clone_failed: EROFS", "workspace_eacces"],
      ["workspace_provision_failed:missing_credentials", "sandbox_cr_missing"],
      [
        "workspace_provision_failed:clone_failed: exit 128",
        "sandbox_cr_missing",
      ],
      ["exec transport closed before provision", "exec_transport"],
      ["exec-transport handshake failed", "exec_transport"],
    ];
    for (const [message, expected] of cases) {
      const code = classifyProvisionFailure(message);
      expect(SANDBOX_FAULT_CODES).toContain(code);
      expect(code).toBe(expected);
    }
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

  it("emits an envelope that fails schema parse as {model, envelope_invalid}", async () => {
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
    expect(meta.fault?.code).toBe("envelope_invalid");
    expect(meta.fault?.detail).toBeDefined();
  });

  it("preserves a runner-classified fault over the adapter's synthesis", async () => {
    const runner: PiRunner = {
      kind: "pi-coding-agent",
      run: async (): Promise<PiRunResult> => {
        return {
          sandboxId: "sb-env",
          envelope: { invalid: true },
          fault: { layer: "model", code: "envelope_rejected" },
        };
      },
    };
    const adapter = new PiAgentRuntimeAdapter(runner);
    const meta = await adapter.startRun(
      {},
      { role: "developer", runId: "run-kept" },
    );
    expect(meta.fault?.code).toBe("envelope_rejected");
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
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
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
      expect(spy).toHaveBeenCalledWith(
        "[fault] unknown classification",
        "completely unexpected crash",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("resumeRun copies the segment fault onto resumed metadata", async () => {
    const runner: PiRunner = {
      kind: "pi-coding-agent",
      run: async (): Promise<PiRunResult> => {
        throw new Error("not used");
      },
      resume: async (req): Promise<PiRunResult> => {
        req.onRunning?.();
        return {
          sandboxId: "sb-resumed",
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
    const sessionsDir = mkdtempSync(join(tmpdir(), "colony-fault-resume-"));
    mkdirSync(join(sessionsDir, "sessions", "run-resume-fault"), {
      recursive: true,
    });
    writeFileSync(
      join(sessionsDir, "sessions", "run-resume-fault", "session.jsonl"),
      [
        JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "x" }),
        JSON.stringify({
          type: "session",
          version: 3,
          id: "01a05b1d-2073-7109-9bbd-66085c1611e1",
          timestamp: "2026-09-01T00:00:00.000Z",
          cwd: "/workspace",
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const meta = await adapter.resumeRun(
      { goal: "test" },
      {
        role: "developer",
        runId: "run-resume-fault",
        sandboxId: "sb-resumed",
        sessionsDir,
        connect: () =>
          Promise.resolve({
            sandboxId: "sb-resumed",
            exec: () => Promise.resolve({ exitCode: 0, timedOut: false }),
            readFile: () => Promise.resolve(""),
            writeFile: () => Promise.resolve(),
            destroy: () => Promise.resolve(),
          } as never),
      },
    );
    rmSync(sessionsDir, { recursive: true, force: true });
    expect(meta.status).toBe("failed");
    expect(meta.fault).toEqual({
      layer: "model",
      code: "wall_timeout",
      detail: "run timeout exceeded",
    });
  });

  it("resumeRun maps a throw with no structured fault to {unknown, unknown}", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const runner: PiRunner = {
        kind: "pi-coding-agent",
        run: async (): Promise<PiRunResult> => {
          throw new Error("not used");
        },
      };
      const adapter = new PiAgentRuntimeAdapter(runner);
      const sessionsDir = mkdtempSync(join(tmpdir(), "colony-fault-noresume-"));
      writeFileSync(
        join(sessionsDir, "PACKET.json"),
        JSON.stringify({ goal: "test" }),
        "utf8",
      );
      const meta = await adapter.resumeRun({ goal: "test" }, {
        role: "developer",
        runId: "run-resume-throw",
        sandboxId: "sb-gone",
        sessionsDir,
        connect: () => Promise.resolve(undefined as never),
      } as never);
      rmSync(sessionsDir, { recursive: true, force: true });
      expect(meta.status).toBe("failed");
      expect(meta.fault?.layer).toBe("unknown");
      expect(meta.fault?.code).toBe("unknown");
      expect(spy).toHaveBeenCalledWith(
        "[fault] unknown classification",
        expect.anything(),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("does not log or fault-classify a throw that races a cancellation", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      let cancel: (() => Promise<void>) | undefined;
      const runner: PiRunner = {
        kind: "pi-coding-agent",
        run: async (_req: PiRunRequest): Promise<PiRunResult> => {
          await cancel!();
          throw new Error("aborted mid-teardown");
        },
      };
      const adapter = new PiAgentRuntimeAdapter(runner);
      cancel = () => adapter.cancelRun("run-cancel-race").then(() => undefined);
      const meta = await adapter.startRun(
        {},
        { role: "developer", runId: "run-cancel-race" },
      );
      expect(meta.status).toBe("canceled");
      expect(meta.fault).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// The tests below drive the real runner against a gateway, so they observe
// the fault PiRunResult actually returns rather than the stub runners above.
const servers: Server[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          // Bun clears the underlying server on close(), so stop requests first.
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  connection: "keep-alive",
  "cache-control": "no-cache",
};

function sseChunk(
  response: ServerResponse,
  model: string,
  choices: unknown[],
  usage?: object,
): void {
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices,
      ...(usage ? { usage } : {}),
    })}\n\n`,
  );
}

/**
 * A gateway that answers the nth request with `respond(n)`. Requests past the
 * handler's interest simply hang, which is what lets the wall clock close a
 * run without a submission.
 */
async function startGateway(
  respond: (request: number, response: ServerResponse) => void,
): Promise<string> {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    respond(requests, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return `http://127.0.0.1:${address.port}/v1`;
}

let toolCallId = 0;

function respondToolCall(
  response: ServerResponse,
  model: string,
  name: string,
  args: unknown,
): void {
  toolCallId += 1;
  response.writeHead(200, SSE_HEADERS);
  sseChunk(response, model, [
    {
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call-${toolCallId}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      finish_reason: null,
    },
  ]);
  sseChunk(
    response,
    model,
    [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    { completion_tokens: 4, prompt_tokens: 1 },
  );
  response.end("data: [DONE]\n\n");
}

function respondText(response: ServerResponse, model: string): void {
  response.writeHead(200, SSE_HEADERS);
  sseChunk(response, model, [
    {
      index: 0,
      delta: { role: "assistant", content: "Reviewing the change now." },
      finish_reason: null,
    },
  ]);
  sseChunk(response, model, [{ index: 0, delta: {}, finish_reason: "stop" }], {
    completion_tokens: 3,
    prompt_tokens: 1,
  });
  response.end("data: [DONE]\n\n");
}

/**
 * A runner whose session journal cannot be created, so `createAgentSession`
 * throws before any model work happens. That is the seam whose catch used to
 * rethrow after classifying.
 */
function runnerWithUnbuildableSession(): PiBaseAgentRunner {
  const scratchDir = mkdtempSync(join(tmpdir(), "colony-fault-init-"));
  scratchDirs.push(scratchDir);
  const occupied = join(scratchDir, "sessions-root");
  writeFileSync(occupied, "not a directory", "utf8");
  return new PiBaseAgentRunner(
    {
      ...REVIEWER_ROLE_PROFILE,
      workspaceMode: "scratch",
      requireRepositoryInspection: false,
      defaultTools: [],
    },
    {
      model: {
        id: "primary",
        name: "primary",
        provider: "test-gateway",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      scratchDir,
      sessionsDir: occupied,
      broker: { resolve: () => "test-key" },
    },
  );
}

/**
 * A runner with a readable file in its workspace and the `read` tool, so a
 * tool call can actually succeed before the run ends.
 */
function runnerWithReadableFile(
  baseUrl: string,
  runTimeoutMs: number,
): PiBaseAgentRunner {
  const scratchDir = mkdtempSync(join(tmpdir(), "colony-fault-tools-"));
  scratchDirs.push(scratchDir);
  writeFileSync(join(scratchDir, "notes.txt"), "findings so far\n", "utf8");
  return new PiBaseAgentRunner(
    {
      ...REVIEWER_ROLE_PROFILE,
      workspaceMode: "scratch",
      requireRepositoryInspection: false,
      defaultTools: ["read"],
    },
    {
      model: {
        id: "primary",
        name: "primary",
        provider: "test-gateway",
        api: "openai-completions",
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      scratchDir,
      broker: { resolve: () => "test-key" },
      connectionRetryBackoffMs: 1,
      jiggleBackoffMs: 1,
      runTimeoutMs,
    },
  );
}

function runnerOn(baseUrl: string, runTimeoutMs: number): PiBaseAgentRunner {
  const scratchDir = mkdtempSync(join(tmpdir(), "colony-fault-test-"));
  scratchDirs.push(scratchDir);
  return new PiBaseAgentRunner(
    {
      ...REVIEWER_ROLE_PROFILE,
      workspaceMode: "scratch",
      requireRepositoryInspection: false,
      defaultTools: [],
    },
    {
      model: {
        id: "primary",
        name: "primary",
        provider: "test-gateway",
        api: "openai-completions",
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      scratchDir,
      broker: { resolve: () => "test-key" },
      connectionRetryBackoffMs: 1,
      jiggleBackoffMs: 1,
      runTimeoutMs,
    },
  );
}

const HEAD_SHA = "a".repeat(40);

/**
 * The SDK folds every HTTP and stream failure into an error turn, so the
 * finalizer's catch is only reachable through a fault the harness raises
 * before the request goes out: a profile whose finalizer prompt throws.
 */
function runnerWithThrowingFinalizer(baseUrl: string): PiBaseAgentRunner {
  const scratchDir = mkdtempSync(join(tmpdir(), "colony-fault-finalizer-"));
  scratchDirs.push(scratchDir);
  return new PiBaseAgentRunner(
    {
      ...REVIEWER_ROLE_PROFILE,
      workspaceMode: "scratch",
      requireRepositoryInspection: false,
      defaultTools: [],
      finalizerPrompt: () => {
        throw new Error("finalizer prompt assembly exploded");
      },
    },
    {
      model: {
        id: "primary",
        name: "primary",
        provider: "test-gateway",
        api: "openai-completions",
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      scratchDir,
      broker: { resolve: () => "test-key" },
      connectionRetryBackoffMs: 1,
      jiggleBackoffMs: 1,
      runTimeoutMs: 120_000,
    },
  );
}

/**
 * A runner whose sandbox engine refuses to provision, the way a k8s engine
 * does when the Sandbox CR never becomes ready or its create is refused.
 * The workspace provision succeeds here, so this is the engine path only.
 */
function runnerWithFailingProvision(message: string): PiBaseAgentRunner {
  const scratchDir = mkdtempSync(join(tmpdir(), "colony-fault-provision-"));
  scratchDirs.push(scratchDir);
  return new PiBaseAgentRunner(
    {
      ...REVIEWER_ROLE_PROFILE,
      workspaceMode: "scratch",
      requireRepositoryInspection: false,
      defaultTools: [],
    },
    {
      model: {
        id: "primary",
        name: "primary",
        provider: "test-gateway",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      scratchDir,
      broker: { resolve: () => "test-key" },
      engine: {
        provision: () => Promise.reject(new Error(message)),
        connect: () => Promise.reject(new Error("unused")),
      },
    },
  );
}

describe("fault emission from a real run", () => {
  // engine.provision sits in the outer try/finally, which has no catch: a
  // k8s throw (CR ready-timeout, CR failed, refused RBAC) escaped run() and
  // the adapter's finish wrapper reported {unknown,unknown}. The local
  // workspace-clone catch never sees those messages.
  it("returns a sandbox fault when engine.provision throws", async () => {
    const result = await runnerWithFailingProvision(
      "timed out 60000ms waiting for Sandbox CR sb-1 to become ready",
    ).run({
      runId: "run-provision-throw",
      packet: { goal: "Review the change" },
      environment: { role: "reviewer" },
    });
    expect(result.envelope).toEqual({ __unfinished: true });
    expect(SANDBOX_FAULT_CODES).toContain(result.fault?.code ?? "");
    expect(result.fault).toEqual({
      layer: "sandbox",
      code: "sandbox_cr_missing",
      detail: "timed out 60000ms waiting for Sandbox CR sb-1 to become ready",
    });
  }, 120_000);

  // The catch around createAgentSession classified the fault and rethrew, and
  // run() has no catch: the throw escaped to PiAgentRuntimeAdapter.startRun,
  // which logged "unknown classification" and returned {unknown, unknown}. A
  // stub runner cannot catch that, so this drives the real failure.
  it("returns a session-construction fault instead of rethrowing it", async () => {
    const result = await runnerWithUnbuildableSession().run({
      runId: "run-session-throw",
      packet: { goal: "Review the change" },
      environment: { role: "reviewer" },
    });
    expect(result.envelope).toEqual({ __unfinished: true });
    expect(result.fault?.layer).toBe("harness");
    expect(result.fault?.code).toBe("plumbing_error");
    expect(result.fault?.detail).toContain("ENOTDIR");
  }, 120_000);

  // CONNECTION_ERROR_RE matches \b50[0234]\b, \b529\b, "bad gateway" and
  // "gateway timeout", and driveSession tested it before the protocol
  // table, so those arms were unreachable: an exhausted 5xx leg was
  // reported {provider,connection_exhausted} instead of the spec code.
  it("classifies an exhausted 5xx leg as {provider, http_5xx}", async () => {
    const baseUrl = await startGateway((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "503 bad gateway from upstream",
            type: "server_error",
          },
        }),
      );
    });
    const result = await runnerOn(baseUrl, 120_000).run({
      runId: "run-http-5xx",
      packet: { goal: "Review the change" },
      environment: { role: "reviewer" },
    });
    expect(result.envelope).toEqual({ __unfinished: true });
    expect(result.fault?.layer).toBe("provider");
    expect(result.fault?.code).toBe("http_5xx");
  }, 300_000);

  it("splits the wall clock: no tool calls is {model, wall_timeout}", async () => {
    const baseUrl = await startGateway(() => {
      // Every request hangs, so only the wall can end this run.
    });
    const result = await runnerOn(baseUrl, 800).run({
      runId: "run-wall-only",
      packet: { goal: "Review the change" },
      environment: { role: "reviewer" },
    });
    expect(result.reason).toBe("timeout_without_envelope");
    expect(result.fault).toEqual({
      layer: "model",
      code: "wall_timeout",
      detail: "run timeout exceeded (800ms)",
    });
  }, 120_000);

  it("splits the wall clock: tool calls but no envelope is {model, timeout_no_envelope}", async () => {
    const baseUrl = await startGateway((request, response) => {
      if (request === 1) {
        // A real tool that succeeds, so the run's only defect is that it
        // never submits before the wall closes.
        respondToolCall(response, "primary", "read", { path: "notes.txt" });
      }
      // Later requests hang until the wall closes the run.
    });
    const result = await runnerWithReadableFile(baseUrl, 1_500).run({
      runId: "run-wall-tools",
      packet: { goal: "Review the change" },
      environment: { role: "reviewer" },
    });
    expect(result.fault).toEqual({
      layer: "model",
      code: "timeout_no_envelope",
      detail:
        "run timed out after tool activity without submitting an envelope",
    });
  }, 120_000);

  it("emits {model, envelope_invalid} when the submit arguments fail the schema", async () => {
    const baseUrl = await startGateway((request, response) => {
      if (request === 1) {
        // `summary` missing: the loop refuses the call before the tool runs.
        respondToolCall(response, "primary", "submit_reviewer_verdict", {
          kind: "reviewer_verdict",
          verdict: "approve",
          head_sha: HEAD_SHA,
        });
      } else {
        respondText(response, "primary");
      }
    });
    const result = await runnerOn(baseUrl, 60_000).run({
      runId: "run-shape-invalid",
      packet: { goal: "Review the change" },
      environment: { role: "reviewer" },
    });
    expect(result.fault?.layer).toBe("model");
    expect(result.fault?.code).toBe("envelope_invalid");
  }, 120_000);

  it("emits {model, envelope_rejected} for a schema-shaped submit the tool refused", async () => {
    const baseUrl = await startGateway((request, response) => {
      if (request === 1) {
        // Schema-shaped, but an approve with nothing inspected is refused.
        respondToolCall(response, "primary", "submit_reviewer_verdict", {
          kind: "reviewer_verdict",
          verdict: "approve",
          summary: "LGTM",
          findings: [],
          head_sha: HEAD_SHA,
        });
      } else {
        respondText(response, "primary");
      }
    });
    const result = await runnerOn(baseUrl, 60_000).run({
      runId: "run-shape-rejected",
      packet: { goal: "Review the change" },
      environment: { role: "reviewer" },
    });
    expect(result.fault?.layer).toBe("model");
    expect(result.fault?.code).toBe("envelope_rejected");
  }, 120_000);

  // With no candidate left, driveSession's protocol arm is the last
  // classifier before finalization. An SDK lifecycle throw there used to
  // fall back to {provider,connection_exhausted}; the spec wants the same
  // harness fallback the continuation steer uses.
  it("classifies the last candidate's non-provider throw as a harness fault", async () => {
    const baseUrl = await startGateway((_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "model lifecycle broke" } }),
      );
    });
    const result = await runnerOn(baseUrl, 60_000).run({
      runId: "run-last-candidate-harness",
      packet: { goal: "Review the change" },
      environment: { role: "reviewer" },
    });
    expect(result.envelope).toEqual({ __unfinished: true });
    expect(result.fault).toEqual({
      layer: "harness",
      code: "sdk_lifecycle",
      detail: "400 model lifecycle broke",
    });
  }, 120_000);

  // The forced finalizer prompt is the last thing to run before
  // finalization, and nothing between it and executeRun's return catches.
  // Its throw used to escape with no Fault on state, so the adapter's
  // finish wrapper reported {unknown,unknown} and the run kept no
  // classification at all.
  it("classifies a thrown finalizer prompt instead of reporting {unknown, unknown}", async () => {
    const baseUrl = await startGateway((_request, response) => {
      respondText(response, "primary");
    });
    // Through the adapter: {unknown,unknown} is exactly what its finish
    // wrapper records for a throw that escapes the runner.
    const adapter = new PiAgentRuntimeAdapter(
      runnerWithThrowingFinalizer(baseUrl),
    );
    const spy = spyOn(console, "error").mockImplementation(() => {});
    let meta;
    try {
      meta = await adapter.startRun(
        { goal: "Review the change" },
        { role: "reviewer", runId: "run-finalizer-throw" },
      );
    } finally {
      spy.mockRestore();
    }
    expect(meta.status).toBe("failed");
    expect(meta.fault?.layer).not.toBe("unknown");
    expect(meta.fault?.code).not.toBe("unknown");
    expect(spy).not.toHaveBeenCalledWith(
      "[fault] unknown classification",
      expect.anything(),
    );
  }, 120_000);
});
