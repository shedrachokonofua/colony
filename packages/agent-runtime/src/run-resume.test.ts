import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { context, trace, type Context } from "@opentelemetry/api";
import {
  registerInMemorySpanExporter,
  startColonyRunSpan,
} from "@colony/observability";
import type { ExecRequest, SandboxHandle } from "@colony/sandbox";
import type { AgentRunMetadata } from "./adapter.js";
import { sessionFilePath } from "./session-store.js";
import { RESUME_STEER_PROMPT, resumeRun } from "./run-resume.js";
import type { ResumeRequest, ResumeSession } from "./run-resume.js";

/**
 * Covers the resume seam against a fake engine and a scripted session file:
 * the steer prompt that opens the segment, the events emitted, the fresh
 * span the resumed work nests under, and the failure modes that must fail the
 * run rather than leave it driverless (a missing journal, a dead sandbox, a
 * driver that never starts the loop).
 */

const dirs: string[] = [];
let seam: ReturnType<typeof registerInMemorySpanExporter> | undefined;

/** Trace id of the span active right now, or undefined when there is none. */
function currentTraceId(): string | undefined {
  return trace.getSpan(context.active())?.spanContext().traceId;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  await seam?.shutdown();
  seam = undefined;
});

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `colony-resume-${prefix}-`));
  dirs.push(dir);
  return dir;
}

/** A sandbox handle that records execs and reports itself alive. */
interface FakeHandle extends SandboxHandle {
  readonly execs: string[];
}

function fakeHandle(sandboxId: string): FakeHandle {
  const execs: string[] = [];
  return {
    sandboxId,
    execs,
    async exec(request: ExecRequest) {
      execs.push(request.command);
      return { exitCode: 0, timedOut: false };
    },
    async readFile() {
      return Buffer.from("stub");
    },
    async writeFile() {},
    async destroy() {},
  };
}

/**
 * Writes a scripted journal in the SDK's own wire shape: a title slot line
 * followed by the session header, then one line per recorded turn.
 */
function scriptSession(entries: number): string {
  const dir = newDir("sessions");
  const file = sessionFilePath(dir, "run-1");
  mkdirSync(join(dir, "sessions", "run-1"), { recursive: true });
  const lines: Record<string, unknown>[] = [
    {
      type: "title",
      v: 1,
      title: "",
      updatedAt: "2026-09-01T00:00:00.000Z",
      pad: "",
    },
    {
      type: "session",
      version: 3,
      id: "01a05b1d-2073-7109-9bbd-66085c1611e1",
      timestamp: "2026-09-01T00:00:00.000Z",
      cwd: "/workspace",
    },
  ];
  for (let i = lines.length; i < entries; i += 1) {
    lines.push({
      type: "message",
      id: `m-${i}`,
      parentId: null,
      timestamp: "2026-09-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: `turn ${i}` }] },
    });
  }
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return dir;
}

const RUN_ID = "run-1";
const SANDBOX_ID = "sandbox-1";

interface SpanRecord {
  readonly traceId: string;
  status?: string;
  reason?: string;
}

interface Harness {
  readonly request: ResumeRequest;
  readonly events: { event: string; detail: Record<string, unknown> }[];
  readonly spans: SpanRecord[];
  readonly handle: FakeHandle;
  /** Context observed by the driver, when it recorded one. */
  observed: Context | undefined;
}

function metadata(status: AgentRunMetadata["status"]): AgentRunMetadata {
  return {
    runId: RUN_ID,
    sandboxId: SANDBOX_ID,
    role: "developer",
    status,
    packetHash: "",
  };
}

function harness(options: {
  sessionsDir?: string;
  connect?: (id: string) => Promise<SandboxHandle>;
  startSpan?: ResumeRequest["startSpan"];
  /** Drives the reloaded session; defaults to a live continuation. */
  drive?: ResumeRequest["drive"];
}): Harness {
  const events: { event: string; detail: Record<string, unknown> }[] = [];
  const spans: SpanRecord[] = [];
  const handle = fakeHandle(SANDBOX_ID);
  const h: Harness = {
    events,
    spans,
    handle,
    observed: undefined,
    request: undefined as unknown as ResumeRequest,
  };
  const connect =
    options.connect ??
    (() =>
      handle === undefined
        ? Promise.reject(new Error("gone"))
        : Promise.resolve(handle));
  const drive: ResumeRequest["drive"] =
    options.drive ??
    (async (session: ResumeSession) => {
      h.observed = session.traceContext;
      session.onRunning();
      return metadata("succeeded");
    });
  const request: ResumeRequest = {
    runId: RUN_ID,
    sandboxId: SANDBOX_ID,
    sessionsDir: options.sessionsDir ?? scriptSession(1),
    packet: { task_id: "col-c8f58a57.3" },
    connect,
    drive,
    emitEvent: (event, detail) => {
      events.push({ event, detail });
    },
    startSpan:
      options.startSpan ??
      (() => {
        const record: SpanRecord = { traceId: "trace-resume-1" };
        const spanContext = context.active();
        return {
          traceId: record.traceId,
          spanContext,
          end(status, reason) {
            record.status = status;
            record.reason = reason;
            spans.push(record);
          },
        };
      }),
  };
  Object.assign(h, { request });
  return h;
}

describe("resumeRun", () => {
  it("opens the resumed segment with the fixed steer prompt", async () => {
    let seen: string | undefined;
    const h = harness({
      drive: async (session) => {
        seen = session.steerPrompt;
        session.onRunning();
        return metadata("succeeded");
      },
    });
    await resumeRun(h.request);
    expect(seen).toBe(RESUME_STEER_PROMPT);
    expect(RESUME_STEER_PROMPT).toContain("git status");
  });

  it("hands the driver the reloaded journal and the re-attached sandbox", async () => {
    const h = harness({
      drive: async (session) => {
        session.onRunning();
        return metadata(
          session.handle.sandboxId === SANDBOX_ID ? "succeeded" : "failed",
        );
      },
    });
    const result = await resumeRun(h.request);
    expect(result.status).toBe("succeeded");
    // The journal is the run's own file, not a fresh in-memory session.
    expect(h.request.sessionsDir).toContain("colony-resume-sessions");
  });

  it("emits run_resumed with the sandbox id and the loaded entry count", async () => {
    const h = harness({ sessionsDir: scriptSession(4) });
    await resumeRun(h.request);
    expect(h.events).toEqual([
      {
        event: "run_resumed",
        detail: { sandbox_id: SANDBOX_ID, entries_loaded: 4 },
      },
    ]);
  });

  it("emits run_resume_failed and rethrows when the session journal is missing", async () => {
    const h = harness({
      sessionsDir: newDir("empty"),
      drive: async () => {
        throw new Error("driver must not run without a journal");
      },
    });
    const request = { ...h.request, runId: "run-absent" };
    let threw = false;
    try {
      await resumeRun(request);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.event).toBe("run_resume_failed");
    expect(h.events[0]!.detail.error).toContain("run-absent");
    expect(h.spans[0]?.status).toBe("failed");
  });

  it("emits run_resume_failed and rethrows when the sandbox is gone", async () => {
    const h = harness({
      connect: () =>
        Promise.reject(new Error("sandbox sandbox-1 gone: no Sandbox CR")),
      drive: async () => {
        throw new Error("driver must not run without a sandbox");
      },
    });
    let threw = false;
    try {
      await resumeRun(h.request);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(h.events[0]!.event).toBe("run_resume_failed");
    expect(h.events[0]!.detail.error).toContain("sandbox-1 gone");
  });

  it("runs the continuation inside the FRESH span, carrying colony.run_id", async () => {
    // The real seam, not a stub: `startColonyRunSpan` is what colonyd
    // supplies, and only a real span owns a context the SDK's GenAI spans
    // can actually nest under. The withSpanContext helper below proves the
    // continuation ran inside it.
    seam = registerInMemorySpanExporter();
    const traceIds: (string | undefined)[] = [];
    const h = harness({
      startSpan: () =>
        startColonyRunSpan({
          scope_id: "col-c8f58a57",
          task_id: "col-c8f58a57.3",
          run_id: RUN_ID,
          kind: "resume",
          model_id: null,
        }),
      drive: async (session) => {
        // Runs INSIDE the span: an unused wrapper span would leave the
        // continuation on whatever context happened to be active.
        traceIds.push(currentTraceId());
        session.onRunning();
        return metadata("succeeded");
      },
    });
    await resumeRun(h.request);
    const [span] = seam.exporter
      .getFinishedSpans()
      .filter((s) => s.name === "colony.run");
    expect(span).toBeDefined();
    // The resumed segment opened its own root: one fresh trace, not the
    // pre-restart one, and it carries the run id.
    expect(span!.attributes["colony.run_id"]).toBe(RUN_ID);
    expect(span!.attributes["colony.run.status"]).toBe("succeeded");
    expect(traceIds).toEqual([span!.spanContext().traceId]);
  });

  it("runs the continuation with no span context when tracing is off", async () => {
    const h = harness({ startSpan: () => undefined });
    await resumeRun(h.request);
    expect(h.observed).toBeUndefined();
    expect(h.spans).toHaveLength(0);
    expect(h.events.map((e) => e.event)).toEqual(["run_resumed"]);
  });

  it("never leaves a run without a driver: a driver throw surfaces to the caller", async () => {
    const h = harness({
      drive: async () => {
        throw new Error("driver exploded");
      },
    });
    await expect(resumeRun(h.request)).rejects.toThrow("driver exploded");
    expect(h.events.map((e) => e.event)).toContain("run_resume_failed");
  });

  it("fails a driver that returns without ever starting the agent loop", async () => {
    // The review blocker: a resumed run was marked resumed with no driver
    // steering it. A driver that never reports the loop running is the same
    // defect, so it must fail the run rather than resolve a success.
    const h = harness({
      drive: async () => metadata("succeeded"),
    });
    await expect(resumeRun(h.request)).rejects.toThrow(/without starting/);
    expect(h.events.map((e) => e.event)).toEqual(["run_resume_failed"]);
    expect(h.spans[0]?.status).toBe("failed");
  });

  it("a failed resume segment leaves the sandbox connectable for requeue", async () => {
    // A failed resume destroys nothing: the surviving sandbox stays owned
    // by the daemon's adoption cycle, so the caller's fail+requeue can
    // connect to the same id again. Destroying it here made the next
    // adoption reject "sandbox … gone" and the run unresumable.
    const { createInProcessEngine } =
      await import("@colony/sandbox-in-process");
    const { buildSandboxLaunchProfile } = await import("@colony/sandbox");
    const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createServer } = await import("node:http");
    const { PiBaseAgentRunner, REVIEWER_ROLE_PROFILE } =
      await import("./pi-base-agent-runner.js");
    const { createFileSessionManager, sessionFilePath } =
      await import("./session-store.js");
    // The gateway settles the segment at once: an empty `length` stop is a
    // terminal response, so the run fails without spending its wall clock.
    const gateway = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
        "cache-control": "no-cache",
      });
      response.end(
        'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"resume-keep-alive","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
      );
    });
    await new Promise<void>((resolve) =>
      gateway.listen(0, "127.0.0.1", resolve),
    );
    const address = gateway.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    try {
      const workspace = mkdtempSync(join(tmpdir(), "colony-resume-sandbox-"));
      dirs.push(workspace);
      const engine = createInProcessEngine();
      const live = await engine.provision(
        buildSandboxLaunchProfile("reviewer"),
        workspace,
      );
      const runId = "run-resume-survives";
      const sessionsDir = newDir("keep-alive");
      mkdirSync(join(sessionsDir, "sessions", runId), { recursive: true });
      writeFileSync(
        sessionFilePath(sessionsDir, runId),
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
      );
      const sessionManager = await createFileSessionManager(sessionsDir, runId);
      const runner = new PiBaseAgentRunner(
        {
          ...REVIEWER_ROLE_PROFILE,
          workspaceMode: "scratch",
          requireRepositoryInspection: false,
          defaultTools: [],
        },
        {
          model: {
            id: "resume-keep-alive",
            name: "resume-keep-alive",
            api: "openai-completions",
            provider: "test-gateway",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8_192,
          },
          scratchDir: newDir("keep-alive-scratch"),
          broker: { resolve: () => "test-key" },
          maxTurns: 1,
          jiggleBackoffMs: 0,
          runTimeoutMs: 10_000,
          workspaceProbeIntervalMs: 3_600_000,
        },
      );
      const result = await runner.resume({
        runId,
        packet: { goal: "Review the change", head_sha: "c".repeat(40) },
        environment: { role: "reviewer" },
        handle: live,
        sessionManager,
        steerPrompt: RESUME_STEER_PROMPT,
      });
      expect(result.envelope).toEqual({ __unfinished: true });
      expect(result.reason).toBeDefined();
      // The resumed sandbox survives the failed segment: a fresh engine in
      // a new object graph — the post-restart adoption path — still connects.
      const reattached = await createInProcessEngine().connect(live.sandboxId);
      expect(reattached).toBe(live);
      await expect(
        reattached.exec({ command: "true" }, () => undefined),
      ).resolves.toMatchObject({ exitCode: 0 });
      await live.destroy();
    } finally {
      await new Promise<void>((resolve, reject) =>
        gateway.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
