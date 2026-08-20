import type { PiModelSpec } from "./pi-runner-common.js";
import { describe, it, expect, afterEach } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import {
  PiBaseAgentRunner,
  buildRunTools,
  ARCHITECT_ROLE_PROFILE,
  DEVELOPER_ROLE_PROFILE,
  REVIEWER_ROLE_PROFILE,
} from "./pi-base-agent-runner.js";
import { WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME } from "./web-tools.js";

const servers: Server[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (srv) =>
        new Promise<void>((resolve, reject) => {
          srv.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
  for (const d of scratchDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

function writeToolResponse(
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

describe("buildRunTools registration", () => {
  const dummyWebTools = {
    searxngUrl: "https://searxng.home.shdr.ch",
    transport: async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ results: [] }),
      truncated: false,
    }),
  } as const;

  for (const [label, profile] of [
    ["architect", ARCHITECT_ROLE_PROFILE],
    ["developer", DEVELOPER_ROLE_PROFILE],
    ["reviewer", REVIEWER_ROLE_PROFILE],
  ] as const) {
    it(`with webTools configured, ${label} exposes web_fetch as custom and web_search by builtin name`, () => {
      const { customTools, toolNames } = buildRunTools(profile, {
        webTools: dummyWebTools as unknown as never,
      });
      const names = customTools.map((t) => (t as { name: string }).name);
      expect(names).toContain(profile.submitTool(() => {}).name);
      // web_search is the SDK builtin (SearXNG provider): enabled by NAME in
      // toolNames, never registered as a Colony custom tool.
      expect(names).not.toContain(WEB_SEARCH_TOOL_NAME);
      expect(names).toContain(WEB_FETCH_TOOL_NAME);
      expect(toolNames).toContain(WEB_SEARCH_TOOL_NAME);
      expect(toolNames).toContain(WEB_FETCH_TOOL_NAME);
      // submit tool must still be listed in toolNames
      expect(toolNames).toContain(profile.submitTool(() => {}).name);
      // all custom tool names are present in toolNames
      for (const n of names) expect(toolNames).toContain(n);
    });

    it(`without webTools, ${label} tool set contains no web tool names and is unchanged`, () => {
      const withEmpty = buildRunTools(profile, {});
      const names = withEmpty.customTools.map(
        (t) => (t as { name: string }).name,
      );
      expect(names).not.toContain(WEB_SEARCH_TOOL_NAME);
      expect(names).not.toContain(WEB_FETCH_TOOL_NAME);
      expect(withEmpty.toolNames).not.toContain(WEB_SEARCH_TOOL_NAME);
      expect(withEmpty.toolNames).not.toContain(WEB_FETCH_TOOL_NAME);
      // byte-identical to "today": only workTools + submitTool
      const expected =
        (profile.defaultTools as readonly string[]).length + 1; /* submitTool */
      expect(withEmpty.toolNames.length).toBe(expected);
      expect(withEmpty.customTools.length).toBe(1);
      expect((withEmpty.customTools[0] as { name: string }).name).toBe(
        profile.submitTool(() => {}).name,
      );
    });
  }
});

describe("e2e: model invokes web_fetch against injected transport", () => {
  it("tool result is observable via stub model + injected transport", async () => {
    const headSha = "c".repeat(40);
    const envelope = {
      kind: "reviewer_verdict",
      verdict: "approve",
      summary: "Fetch confirmed the library API.",
      findings: [] as unknown[],
      head_sha: headSha,
    };

    // web_search execution is the SDK builtin's contract now; Colony's own
    // web tool surface is web_fetch, so that is the seam this test drives.
    let sawFetchInTransport = false;
    const injectedTransport = async ({ url }: { url: URL }) => {
      sawFetchInTransport = true;
      expect(url.toString()).toBe("https://example.com/docs");
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body><p>result body</p></body></html>",
        truncated: false,
      };
    };

    let callCount = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const model = (JSON.parse(body) as { model: string }).model;
        callCount += 1;
        if (callCount === 1) {
          writeToolResponse(
            res,
            "web_fetch",
            { url: "https://example.com/docs" },
            model,
          );
        } else {
          writeToolResponse(
            res,
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
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const baseUrl = `http://127.0.0.1:${(addr as import("node:net").AddressInfo).port}/v1`;
    const model: PiModelSpec = {
      id: "wired-web",
      name: "wired-web",
      api: "openai-completions",
      provider: "test-gateway",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    };

    const scratchDir = mkdtempSync(join(tmpdir(), "colony-web-wiring-"));
    scratchDirs.push(scratchDir);

    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        defaultTools: ["read"],
      },
      {
        model,
        scratchDir,
        broker: { resolve: () => "test-key" },
        maxTurns: 6,
        runTimeoutMs: 20_000,
        webTools: {
          searxngUrl: "https://searxng.home.shdr.ch",
          transport: injectedTransport,
        } as never,
      },
    );

    const result = await runner.run({
      runId: "web-wiring-e2e",
      packet: { goal: "Use web_fetch", head_sha: headSha },
      environment: { role: "reviewer" },
    });

    expect(result.reason).toBeUndefined();
    expect(result.envelope).toEqual(envelope);
    expect(sawFetchInTransport).toBe(true);
  });
});
