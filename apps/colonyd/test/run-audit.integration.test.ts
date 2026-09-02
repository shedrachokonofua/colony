import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetEnvCache } from "@colony/config";
import { FakeProviderAdapter } from "@colony/provider";
import { boot, type ColonydHandle } from "../src/main.js";
import { runArchitect } from "../src/runs/architect.js";

const stubServers: Server[] = [];

async function closeAll(servers: Server[]): Promise<void> {
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
}

interface ModelStubHandle {
  baseUrl: string;
}

const ENVELOPE = {
  kind: "architect_decomposition",
  summary: "Decomposition covering the run-audit test.",
  acceptance: [
    {
      description: "Goal verified",
      command: "true",
    },
  ],
  tasks: [
    {
      title: "Task 1",
      spec: "Do something.",
      depends_on: [],
    },
  ],
};

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -b main", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "colony-test@example.com"', {
    cwd: dir,
    stdio: "pipe",
  });
  execSync('git config user.name "colony-test"', { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "test repo\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "initial commit"', { cwd: dir, stdio: "pipe" });
}

/**
 * Stub OpenAI completions server that executes a tool call and bash command
 * before submitting the decomposition envelope.
 */
async function startModelStub(): Promise<ModelStubHandle> {
  let callCount = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      callCount += 1;
      const parsed = JSON.parse(body) as {
        model: string;
        messages?: { role: string; content: unknown }[];
      };
      const model = parsed.model;
      const lastUser = [...(parsed.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user");
      const content = Array.isArray(lastUser?.content)
        ? lastUser.content
            .map((block) =>
              typeof block === "object" && block !== null && "text" in block
                ? String((block as { text: unknown }).text)
                : "",
            )
            .join("\n")
        : String(lastUser?.content ?? "");

      let chunks: Array<{
        delta: Record<string, unknown>;
        finish: string | null;
      }>;

      if (content.includes("## Critique")) {
        // Architect critique pass: return approval
        chunks = [
          {
            delta: {
              role: "assistant",
              content: JSON.stringify({ verdict: "approve", findings: [] }),
            },
            finish: null,
          },
          { delta: {}, finish: "stop" },
        ];
      } else if (content.includes("## Phase: consolidate")) {
        // Phase 3: Submit final architect decomposition
        chunks = [
          {
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-audit-submit",
                  type: "function",
                  function: {
                    name: "submit_architect_decomposition",
                    arguments: JSON.stringify(ENVELOPE),
                  },
                },
              ],
            },
            finish: null,
          },
          { delta: {}, finish: "tool_calls" },
        ];
      } else if (
        content.includes("## Phase: survey") ||
        content.includes("## Phase: decompose")
      ) {
        // If the model hasn't called bash yet in this phase, emit a bash tool call
        const hasToolResult = (parsed.messages ?? []).some(
          (m) => m.role === "tool",
        );
        if (!hasToolResult) {
          chunks = [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call-bash-${callCount}`,
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        command: "echo 'hello audit test'",
                      }),
                    },
                  },
                ],
              },
              finish: null,
            },
            { delta: {}, finish: "tool_calls" },
          ];
        } else {
          chunks = [
            {
              delta: {
                role: "assistant",
                content: "Phase exploration complete.",
              },
              finish: null,
            },
            { delta: {}, finish: "stop" },
          ];
        }
      } else {
        chunks = [
          { delta: { role: "assistant", content: "Working." }, finish: null },
          { delta: {}, finish: "stop" },
        ];
      }

      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
        "cache-control": "no-cache",
      });
      for (const { delta, finish } of chunks) {
        response.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-audit-${callCount}`,
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stubServers.push(server);
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("listen failed");
  return { baseUrl: `http://127.0.0.1:${addr.port}/v1` };
}

describe("run audit end-to-end integration over in-process sandbox engine", () => {
  let dir: string;
  let artifactsDir: string;
  let gitRepoDir: string;
  let provider: FakeProviderAdapter;
  let handle: ColonydHandle | undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "colonyd-run-audit-"));
    artifactsDir = join(dir, "artifacts");
    gitRepoDir = join(dir, "git-repo");
    initGitRepo(gitRepoDir);
    const configPath = join(dir, "colony.yaml");
    const stub = await startModelStub();

    writeFileSync(
      configPath,
      [
        "agent_runtime: pi",
        "allow_literal_keys: true",
        "hitl:",
        "  mode: yolo",
        "review:",
        "  mode: off",
        "sandbox:",
        "  engine: in-process",
        "artifacts:",
        "  kind: local",
        `  local:`,
        `    dir: ${artifactsDir}`,
        "sessions_dir: " + join(dir, "sessions"),
        "providers:",
        "  fake_llm:",
        "    api: openai-completions",
        `    base_url: ${stub.baseUrl}`,
        "    auth:",
        "      kind: api_key",
        "      value: fake-key",
        "    models:",
        "      - id: fake-model",
        "        name: fake-model",
        "agents:",
        "  architect:",
        "    provider: fake_llm",
        "    model: fake-model",
        "  developer:",
        "    provider: fake_llm",
        "    model: fake-model",
      ].join("\n"),
      "utf8",
    );

    process.env["NODE_ENV"] = "test";
    process.env["AGENT_RUNTIME"] = "pi";
    process.env["GITLAB_TOKEN"] = "";
    process.env["COLONYD_DB_PATH"] = join(dir, "test.db");
    process.env["COLONY_CONFIG_PATH"] = configPath;
    resetEnvCache();

    provider = new FakeProviderAdapter();
    handle = await boot({
      provider,
      headless: true,
    });
  }, 90_000);

  afterAll(async () => {
    await handle?.shutdown();
    await closeAll(stubServers.splice(0));
    rmSync(dir, { recursive: true, force: true });
  });

  it("drives an agent run to completion and verifies tool_call, command, transcript artifact, and audit rows in Store", async () => {
    if (!handle) throw new Error("boot failed");

    const repo = await provider.repos.create({
      name: "run-audit-e2e",
      path: gitRepoDir,
    });

    const scope = handle.ctx.store.createScope({
      goal: "audit e2e test",
      provider_repo_id: repo.id,
      provider_repo_path: repo.path,
    });

    // Execute the architect run to completion
    await runArchitect(handle.ctx, scope);

    // Fetch the run row
    const runs = handle.ctx.store.runsForScope(scope.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const run = runs[0]!;
    expect(run.status).toBe("succeeded");

    // 1. Assert tool_call run event
    const runEventsResult = handle.ctx.store.listRunEvents(run.id);
    const events = runEventsResult.events;

    const toolCallEvents = events.filter((e) => e.event === "tool_call");
    expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);
    const toolCallDetail = JSON.parse(toolCallEvents[0]!.detail_json) as Record<
      string,
      unknown
    >;
    expect(typeof toolCallDetail["args"]).toBe("object");
    expect(toolCallDetail["args"]).not.toBeNull();
    expect(typeof toolCallDetail["duration_ms"]).toBe("number");

    // 2. Assert command run event
    const commandEvents = events.filter((e) => e.event === "command");
    expect(commandEvents.length).toBeGreaterThanOrEqual(1);
    const commandDetail = JSON.parse(commandEvents[0]!.detail_json) as Record<
      string,
      unknown
    >;
    expect(typeof commandDetail["command"]).toBe("string");
    expect(typeof commandDetail["exit_code"]).toBe("number");

    // 3. Assert run_artifacts row of kind transcript and sha256 byte comparison
    const artifactsResult = handle.ctx.store.listRunArtifacts(run.id);
    const transcriptArtifact = artifactsResult.items.find(
      (item) => item.kind === "transcript",
    );
    expect(transcriptArtifact).toBeDefined();
    expect(transcriptArtifact!.key).toBe(`runs/${run.id}/transcript.jsonl.gz`);
    expect(transcriptArtifact!.sha256).toBeTypeOf("string");

    // Read stored bytes from <dir>/runs/<run_id>/transcript.jsonl.gz (or using its ref under artifactsDir)
    const storedBytesPath = join(artifactsDir, transcriptArtifact!.ref);
    const storedBytes = readFileSync(storedBytesPath);
    const computedSha256 = createHash("sha256")
      .update(storedBytes)
      .digest("hex");
    expect(transcriptArtifact!.sha256).toBe(computedSha256);

    // 4. Assert audit row with action run.finished carrying {run_id, status}
    const auditResult = handle.ctx.store.listAudit({ run_id: run.id });
    const runFinishedAudit = auditResult.events.find(
      (e) => e.action === "run.finished",
    );
    expect(runFinishedAudit).toBeDefined();
    const auditDetail = JSON.parse(runFinishedAudit!.detail_json) as Record<
      string,
      unknown
    >;
    expect(auditDetail["run_id"]).toBe(run.id);
    expect(auditDetail["status"]).toBe("succeeded");
  }, 30_000);
});
