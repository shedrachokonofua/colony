import type { PiModelSpec } from "./pi-runner-common.js";
import { createServer, type Server, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createInProcessEngine } from "@colony/sandbox-in-process";
import {
  PiBaseAgentRunner,
  DEVELOPER_ROLE_PROFILE,
} from "./pi-base-agent-runner.js";
import { buildSubmitDeadlineNudge } from "./pi-session.js";

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  connection: "keep-alive",
  "cache-control": "no-cache",
};

function sseToolCall(name: string, args: unknown): string {
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  const base = {
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
  };
  return (
    chunk({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${name}-${Math.random().toString(36).slice(2, 8)}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    chunk({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    }) +
    "data: [DONE]\n\n"
  );
}

function sseProseStop(text: string): string {
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  const base = {
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
  };
  return (
    chunk({
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    }) +
    chunk({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }) +
    "data: [DONE]\n\n"
  );
}

type RequestBody = Record<string, unknown> & {
  model?: string;
  tool_choice?: { function?: { name?: string } };
  tools?: { function: { name: string } }[];
  messages?: { role: string; content?: unknown }[];
};

/**
 * Fake OpenAI-compatible gateway that records every request body and every
 * tool result the model sees. `respond` decides each turn's answer.
 */
async function startGateway(
  respond: (body: RequestBody, response: ServerResponse) => void,
): Promise<{
  baseUrl: string;
  requestBodies: RequestBody[];
  toolResultsSeen: string[];
}> {
  const requestBodies: RequestBody[] = [];
  const toolResultsSeen: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as RequestBody;
      requestBodies.push(parsed);
      for (const message of parsed.messages ?? []) {
        if (message.role === "tool")
          toolResultsSeen.push(String(message.content));
      }
      response.on("error", () => {
        // The forced-submit abort can destroy the socket mid-response.
      });
      respond(parsed, response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestBodies,
    toolResultsSeen,
  };
}

const respondToolCall = (
  response: ServerResponse,
  name: string,
  args: unknown,
): void => {
  response.writeHead(200, SSE_HEADERS);
  response.end(sseToolCall(name, args));
};

const respondProseStop = (response: ServerResponse, text: string): void => {
  response.writeHead(200, SSE_HEADERS);
  response.end(sseProseStop(text));
};

const modelSpec = (baseUrl: string, id = "m"): PiModelSpec => ({
  id,
  name: id,
  api: "openai-completions",
  provider: "test-gateway",
  baseUrl,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
});

/** Non-bare origin with one commit on main; pushes land on other branches. */
function seedOrigin(prefix: string): {
  origin: string;
  baseSha: string;
  branch: string;
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(root);
  const origin = join(root, "origin");
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  execFileSync(
    "git",
    ["-C", origin, "commit", "-q", "--allow-empty", "-m", "init"],
    { env: GIT_ENV },
  );
  execFileSync("git", [
    "-C",
    origin,
    "config",
    "receive.denyCurrentBranch",
    "updateInstead",
  ]);
  const baseSha = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  return { origin, baseSha, branch: "colony/forced-submit" };
}

const packet = (origin: string, branch: string, baseSha: string) =>
  ({
    goal: "Land the change",
    body: "b",
    head_sha: baseSha,
    repo: {
      url: origin,
      branch,
      base_commit: baseSha,
      credentials: { token: "local-noop" },
    },
  }) as never;

/**
 * The model never stops on its own: outside the finalizer it answers every
 * turn with a work tool call, so the run only ends through the deadline
 * escalation. Inside the finalizer (tools collapsed to the submit tool) it
 * obeys the forced tool_choice and submits `envelope`, or stops in prose
 * when the force is not in effect.
 *
 * The per-turn delay is a genuine platform timer on purpose (same contract
 * as subagent-tool.test.ts): the deadline escalation under test is the real
 * wall clock inside `runner.run()`, which fake timers cannot advance while
 * the run is awaited. The delay also keeps turn volume below the turn cap,
 * so the wall - not max_turns - is what decides the run.
 */
const stubbornModel =
  (envelope: unknown, delayMs: number) =>
  (body: RequestBody, response: ServerResponse): void => {
    const tools = body.tools ?? [];
    const onlySubmit =
      tools.length === 1 &&
      tools[0]?.function.name === "submit_implementer_completion";
    const forced =
      body.tool_choice?.function?.name === "submit_implementer_completion";
    setTimeout(() => {
      if (onlySubmit) {
        if (forced) {
          respondToolCall(response, "submit_implementer_completion", envelope);
        } else {
          respondProseStop(response, "Nothing further can be done.");
        }
        return;
      }
      respondToolCall(response, "bash", { command: "true" });
    }, delayMs);
  };

describe("deadline forced submission", () => {
  it("captures an envelope through the forced finalizer before the wall, with the pushed head", async () => {
    const { origin, baseSha, branch } = seedOrigin("colony-forced-submit-");
    // The work branch already exists on the remote at baseSha: the forced
    // submission must succeed against whatever is already pushed.
    execFileSync("git", ["-C", origin, "branch", branch]);
    const completeEnvelope = {
      kind: "implementer_completion",
      status: "complete",
      summary: "Landed the change before the deadline; checks pass.",
      branch,
      head_sha: baseSha,
      commands: [{ cmd: "bun test", exit_code: 0 }],
    };
    const { baseUrl, requestBodies, toolResultsSeen } = await startGateway(
      stubbornModel(completeEnvelope, 100),
    );

    const runTimeoutMs = 30_000;
    const runner = new PiBaseAgentRunner(DEVELOPER_ROLE_PROFILE, {
      model: modelSpec(baseUrl),
      fallbackModels: [],
      engine: createInProcessEngine(),
      broker: { resolve: () => "test-key" },
      maxTurns: 5_000,
      runTimeoutMs,
    });

    const startedAt = Date.now();
    const result = await runner.run({
      runId: `forced-submit-${Date.now()}`,
      packet: packet(origin, branch, baseSha),
      environment: { role: "developer" },
    });
    const elapsedMs = Date.now() - startedAt;

    // The run ends with a captured envelope, before the wall closes it.
    expect(result.envelope).toEqual(completeEnvelope);
    expect(result.reason).toBeUndefined();
    expect(elapsedMs).toBeLessThan(runTimeoutMs);

    // The submission went through the forced finalizer: tools collapsed to
    // the submit tool with a forced tool_choice, pointing at the pushed head.
    const finalizerBodies = requestBodies.filter(
      (body) =>
        body.tool_choice?.function?.name === "submit_implementer_completion",
    );
    expect(finalizerBodies.length).toBeGreaterThanOrEqual(1);
    expect(finalizerBodies[0]?.tools).toHaveLength(1);
    expect(finalizerBodies[0]?.tools?.[0]?.function.name).toBe(
      "submit_implementer_completion",
    );

    // The role-aware deadline nudge reached the model while it was still
    // free-running, and it told the implementer to push before submitting.
    expect(
      toolResultsSeen.some(
        (text) =>
          text.includes("commit what you have NOW") &&
          text.includes("git push"),
      ),
    ).toBe(true);
    expect(
      toolResultsSeen.some((text) =>
        text.includes("submit_implementer_completion"),
      ),
    ).toBe(true);
    expect(
      toolResultsSeen.some((text) =>
        text.includes("a conservative submitted verdict"),
      ),
    ).toBe(false);
  }, 120_000);

  it("ends with a classified failure before the wall when nothing is pushed", async () => {
    const { origin, baseSha, branch } = seedOrigin("colony-forced-empty-");
    // No work branch on the remote: every submission is refused by the
    // pushed-head gate, and the run must still end cleanly before the wall.
    const refusedEnvelope = {
      kind: "implementer_completion",
      status: "blocked",
      summary: "Nothing usable was produced before the deadline.",
      branch,
      head_sha: baseSha,
      blocked_reason: "no work pushed before the deadline",
    };
    const { baseUrl, requestBodies } = await startGateway(
      stubbornModel(refusedEnvelope, 100),
    );

    const runTimeoutMs = 30_000;
    const runner = new PiBaseAgentRunner(DEVELOPER_ROLE_PROFILE, {
      model: modelSpec(baseUrl),
      fallbackModels: [],
      engine: createInProcessEngine(),
      broker: { resolve: () => "test-key" },
      maxTurns: 5_000,
      runTimeoutMs,
    });

    const startedAt = Date.now();
    const result = await runner.run({
      runId: `forced-empty-${Date.now()}`,
      packet: packet(origin, branch, baseSha),
      environment: { role: "developer" },
    });
    const elapsedMs = Date.now() - startedAt;

    // Bounded classified failure, not a hang until the wall timer.
    expect(elapsedMs).toBeLessThan(runTimeoutMs);
    expect(result.envelope).toEqual({ __unfinished: true });
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("does not exist on the remote");
    expect(result.fault).toBeDefined();

    // The forced finalizer ran and the gate refused each attempt.
    const finalizerBodies = requestBodies.filter(
      (body) =>
        body.tool_choice?.function?.name === "submit_implementer_completion",
    );
    expect(finalizerBodies.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("fails like the wall timeout when the forced submission is blocked", async () => {
    const { origin, baseSha, branch } = seedOrigin("colony-forced-blocked-");
    execFileSync("git", ["-C", origin, "branch", branch]);
    // A forced BLOCKED envelope is not a success: colonyd parks a blocked
    // implementer task on the operator, while a timeout requeues and
    // continues from the pushed branch. The run must fail with the timeout's
    // own classification and carry the blocked_reason.
    const blockedEnvelope = {
      kind: "implementer_completion",
      status: "blocked",
      summary:
        "Deadline reached before the task finished; partial work pushed.",
      branch,
      head_sha: baseSha,
      blocked_reason: "work incomplete at the run deadline",
    };
    const { baseUrl, requestBodies } = await startGateway(
      stubbornModel(blockedEnvelope, 100),
    );

    const runTimeoutMs = 30_000;
    const runner = new PiBaseAgentRunner(DEVELOPER_ROLE_PROFILE, {
      model: modelSpec(baseUrl),
      fallbackModels: [],
      engine: createInProcessEngine(),
      broker: { resolve: () => "test-key" },
      maxTurns: 5_000,
      runTimeoutMs,
    });

    const startedAt = Date.now();
    const result = await runner.run({
      runId: `forced-blocked-${Date.now()}`,
      packet: packet(origin, branch, baseSha),
      environment: { role: "developer" },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.envelope).toEqual({ __unfinished: true });
    expect(result.reason).toBe("timeout_without_envelope");
    expect(result.fault).toMatchObject({
      layer: "model",
      code: "timeout_no_envelope",
    });
    expect(result.fault?.detail).toContain(
      "work incomplete at the run deadline",
    );
    expect(elapsedMs).toBeLessThan(runTimeoutMs);

    const finalizerBodies = requestBodies.filter(
      (body) =>
        body.tool_choice?.function?.name === "submit_implementer_completion",
    );
    expect(finalizerBodies.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("keeps a voluntary blocked submission before the forced phase a success", async () => {
    const { origin, baseSha, branch } = seedOrigin("colony-voluntary-blocked-");
    execFileSync("git", ["-C", origin, "branch", branch]);
    const blockedEnvelope = {
      kind: "implementer_completion",
      status: "blocked",
      summary: "Cannot finish this task from the current repository state.",
      branch,
      head_sha: baseSha,
      blocked_reason: "spec precondition is missing",
    };
    // The model submits on its first turn: nothing forced about it.
    const { baseUrl } = await startGateway((body, response) => {
      respondToolCall(
        response,
        "submit_implementer_completion",
        blockedEnvelope,
      );
    });

    const runner = new PiBaseAgentRunner(DEVELOPER_ROLE_PROFILE, {
      model: modelSpec(baseUrl),
      fallbackModels: [],
      engine: createInProcessEngine(),
      broker: { resolve: () => "test-key" },
      maxTurns: 5_000,
      runTimeoutMs: 30_000,
    });

    const result = await runner.run({
      runId: `voluntary-blocked-${Date.now()}`,
      packet: packet(origin, branch, baseSha),
      environment: { role: "developer" },
    });

    expect(result.envelope).toEqual({ ...blockedEnvelope, commands: [] });
    expect(result.reason).toBeUndefined();
    expect(result.fault).toBeUndefined();
  }, 120_000);
});

describe("deadline nudge wording", () => {
  it("orders the implementer to push before it submits", () => {
    const nudge = buildSubmitDeadlineNudge(
      "developer",
      "submit_implementer_completion",
      "colony/forced-submit",
    );
    expect(nudge).toContain(
      "commit what you have NOW and push it (git push origin colony/forced-submit)",
    );
    expect(nudge).toMatch(/push[\s\S]*then call submit_implementer_completion/);
    expect(nudge).toContain('status "blocked" with blocked_reason');
    expect(nudge).toContain(
      "a blocked submission pointing at what you pushed beats a timeout",
    );
    expect(nudge).not.toContain("conservative submitted verdict");
  });

  it("keeps the verdict wording for the read-only roles", () => {
    for (const [role, submitName] of [
      ["reviewer", "submit_reviewer_verdict"],
      ["plan_reviewer", "submit_plan_review_verdict"],
      ["architect", "submit_architect_decomposition"],
    ] as const) {
      const nudge = buildSubmitDeadlineNudge(role, submitName, undefined);
      expect(nudge).toContain(
        "The submission window is closing. Stop investigating NOW",
      );
      expect(nudge).toContain(`call ${submitName} with the envelope`);
      expect(nudge).toContain(
        "a conservative submitted verdict beats a perfect unsubmitted one",
      );
      expect(nudge).not.toContain("git push");
    }
  });
});
