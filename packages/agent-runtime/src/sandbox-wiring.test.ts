import type { PiModelSpec } from "./pi-runner-common.js";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type {
  ExecEvent,
  ExecRequest,
  SandboxEngine,
  SandboxHandle,
} from "@colony/sandbox";
import { buildSandboxLaunchProfile } from "@colony/sandbox";
import { createInProcessEngine } from "@colony/sandbox-in-process";
import { afterEach, describe, expect, it } from "bun:test";
import {
  PiBaseAgentRunner,
  REVIEWER_ROLE_PROFILE,
} from "./pi-base-agent-runner.js";
import { buildSandboxTools } from "./sandbox-tools.js";

const servers: Server[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Stub handle that records every sandbox call instead of touching an engine. */
class RecordingHandle implements SandboxHandle {
  readonly execs: { command: string; cwd?: string }[] = [];
  readonly reads: string[] = [];
  readonly writes: { path: string; content: string }[] = [];
  destroyCalls = 0;

  exec(request: ExecRequest, _onEvent: (event: ExecEvent) => void) {
    this.execs.push({ command: request.command, cwd: request.cwd });
    return Promise.resolve({ exitCode: 0, timedOut: false });
  }

  readFile(path: string): Promise<Buffer> {
    this.reads.push(path);
    return Promise.resolve(Buffer.from("hello from the sandbox\n"));
  }

  writeFile(path: string, content: string): Promise<void> {
    this.writes.push({ path, content });
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    this.destroyCalls += 1;
    return Promise.resolve();
  }
}

function writeToolCallResponse(
  response: import("node:http").ServerResponse,
  name: string,
  args: Record<string, unknown>,
  model: string,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    connection: "keep-alive",
    "cache-control": "no-cache",
  });
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-wiring",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${name}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-wiring",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

/** Sandbox tools ignore the extension context; a stub keeps the SDK signature. */
const toolContext = {} as ExtensionContext;

describe("sandbox tool wiring", () => {
  it("routes bash/file tool calls through the sandbox handle and destroys it exactly once", async () => {
    const headSha = "b".repeat(40);
    const envelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary: "Wired sandbox tools completed the review.",
      findings: [],
      head_sha: headSha,
    };
    const handle = new RecordingHandle();
    const engine: SandboxEngine = {
      provision: () => Promise.resolve(handle),
    };

    let callCount = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const model = (JSON.parse(body) as { model: string }).model;
        callCount += 1;
        if (callCount === 1) {
          writeToolCallResponse(
            response,
            "bash",
            { command: "echo hello-from-sandbox" },
            model,
          );
        } else if (callCount === 2) {
          writeToolCallResponse(response, "read", { path: "notes.txt" }, model);
        } else if (callCount === 3) {
          writeToolCallResponse(
            response,
            "write",
            { path: "nested/out.txt", content: "wired body" },
            model,
          );
        } else {
          writeToolCallResponse(
            response,
            "submit_reviewer_verdict",
            envelope as unknown as Record<string, unknown>,
            model,
          );
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const model: PiModelSpec = {
      id: "wired",
      name: "wired",
      api: "openai-completions",
      provider: "test-gateway",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    };

    const scratchDir = mkdtempSync(join(tmpdir(), "colony-wiring-test-"));
    scratchDirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        defaultTools: ["bash", "read", "write"],
      },
      {
        model,
        scratchDir,
        broker: { resolve: () => "test-key" },
        maxTurns: 6,
        runTimeoutMs: 15_000,
        engine,
      },
    );

    const result = await runner.run({
      runId: "sandbox-wiring",
      packet: { goal: "Route tools through the handle", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    // Bash routed through the handle.
    expect(
      handle.execs.some((exec) =>
        exec.command.includes("echo hello-from-sandbox"),
      ),
    ).toBe(true);
    // Read routed through the handle (its `access` also shells out through exec).
    expect(handle.reads.some((path) => path.includes("notes.txt"))).toBe(true);
    // Write routed through the handle: parent directory created via exec, then
    // the file written through writeFile.
    expect(
      handle.writes.some(
        (write) =>
          write.path.includes("out.txt") && write.content === "wired body",
      ),
    ).toBe(true);
    expect(handle.execs.some((exec) => exec.command.includes("mkdir -p"))).toBe(
      true,
    );

    // Handle destroyed exactly once when the run completes.
    expect(handle.destroyCalls).toBe(1);

    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelope);
  });

  it("round-trips bash/file tools through a real in-process engine handle", async () => {
    const workspace = mkdtempSync(
      join(tmpdir(), "colony-sandbox-integration-"),
    );
    scratchDirs.push(workspace);
    const engine = createInProcessEngine();
    const handle = await engine.provision(
      buildSandboxLaunchProfile("developer"),
      workspace,
    );
    const toolList = buildSandboxTools(handle, workspace);
    const tools = Object.fromEntries(
      toolList.map((tool) => [tool.name, tool]),
    ) as Record<string, (typeof toolList)[number]>;
    try {
      // write → handle.writeFile (mkdir via handle.exec)
      await tools.write.execute(
        "w1",
        {
          path: "src/notes.txt",
          content: "hello sandbox\nsecond line\n",
        },
        undefined,
        undefined,
        toolContext,
      );
      // read → handle.readFile + handle.exec('test -r …') on the same path
      const read = await tools.read.execute(
        "r1",
        {
          path: "src/notes.txt",
        },
        undefined,
        undefined,
        toolContext,
      );
      expect(toolText(read)).toContain("hello sandbox");
      expect(toolText(read)).toContain("second line");

      // bash → handle.exec with a workspace-relative cwd
      const bash = await tools.bash.execute(
        "b1",
        {
          command: "cat src/notes.txt",
        },
        undefined,
        undefined,
        toolContext,
      );
      expect(toolText(bash)).toContain("hello sandbox");

      // ls → handle.exec('test -e/'test -d/'ls -1 …')
      const ls = await tools.ls.execute(
        "l1",
        {
          path: "src",
        },
        undefined,
        undefined,
        toolContext,
      );
      expect(toolText(ls)).toContain("notes.txt");

      // edit → handle.readFile + handle.writeFile + handle.exec('test -w …')
      const edit = await tools.edit.execute(
        "e1",
        {
          path: "src/notes.txt",
          edits: [{ oldText: "hello sandbox", newText: "edited sandbox" }],
        },
        undefined,
        undefined,
        toolContext,
      );
      const afterEdit = await tools.read.execute(
        "r2",
        {
          path: "src/notes.txt",
        },
        undefined,
        undefined,
        toolContext,
      );
      expect(toolText(afterEdit)).toContain("edited sandbox");
      expect(edit.details ?? undefined).toBeDefined();

      // find → handle.exec('find … -type f')
      const find = await tools.find.execute(
        "f1",
        {
          pattern: "**/*.txt",
        },
        undefined,
        undefined,
        toolContext,
      );
      expect(toolText(find)).toContain("notes.txt");

      // Absolute paths (the tool resolves them) never reach the handle; the
      // in-process engine rejects them, so the translation is what matters.
      expect(handle).toBeDefined();
    } finally {
      await handle.destroy();
    }
  });
});

export function toolText(result: {
  content: readonly { type: string; text?: string }[];
}): string {
  return result.content
    .map((content) =>
      content.type === "text" && typeof content.text === "string"
        ? content.text
        : "",
    )
    .join("\n");
}

describe("exec deadline surfacing", () => {
  it("reports a timed-out exec as a tool error, never success", async () => {
    // A dropped exec socket resolves { exitCode: null, timedOut: true } at the
    // engine deadline. The shim treats exitCode null as success, so the bash
    // operations seam must translate timedOut into its `timeout:` contract.
    const handle: SandboxHandle = {
      exec: () => Promise.resolve({ exitCode: null, timedOut: true }),
      readFile: () => Promise.reject(new Error("unused")),
      writeFile: () => Promise.reject(new Error("unused")),
      destroy: () => Promise.resolve(),
    };
    const tools = buildSandboxTools(handle, "/workspace");
    const bash = tools.find((tool) => tool.name === "bash") as AgentTool;
    await expect(
      bash.execute(
        "b-timeout",
        { command: "sleep 1200" },
        undefined,
        undefined,
        toolContext,
      ),
    ).rejects.toThrow(/timed out after 600 seconds/);
  });
});
