import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { RunAuditSink } from "./audit-sink.js";
import {
  armGatewayObserver,
  classifyGatewayExchange,
  parseTierExhaustedRefusal,
  type GatewayExchange,
} from "./gateway-observer.js";
import { RunEvidenceCollector } from "./run-evidence.js";
import {
  PiBaseAgentRunner,
  REVIEWER_ROLE_PROFILE,
} from "./pi-base-agent-runner.js";
import type { PiModelSpec } from "./pi-runner-common.js";

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

/**
 * The production refusal body, exactly as LiteLLM's envelope carried it for
 * `moira/flash` on 2026-10-03: the hook's structured error object nested
 * under `error.provider_specific_fields`, with the top-level `error.type`
 * normalized to `"None"`.
 */
const WRAPPED_TIER_BODY = {
  error: {
    message: "moira/flash at effort=null: no eligible model has quota",
    type: "None",
    param: "None",
    code: "429",
    provider_specific_fields: {
      type: "tier_exhausted",
      message: "moira/flash at effort=null: no eligible model has quota",
      tier: "flash",
      effort: null,
      earliest_reset: "2026-10-03T23:00:00Z",
      excluded: [{ model: "zai/glm-5.3", reason: "no effort in tier band" }],
    },
  },
};

/** The hook's own body shape (Moira's README: `error.type` at the top). */
const RAW_TIER_BODY = {
  error: {
    type: "tier_exhausted",
    message: "moira/strong at effort=high: no eligible model has quota",
    tier: "strong",
    effort: "high",
    earliest_reset: null,
    excluded: [],
  },
};

describe("tier_exhausted structured classification", () => {
  it("classifies the production wrapped body as provider quota with the provider's retry hint", () => {
    const atMs = Date.parse("2026-10-03T21:00:00Z");
    const fault = classifyGatewayExchange({
      atMs,
      status: 429,
      retryAfterSeconds: 120,
      errorBody: WRAPPED_TIER_BODY,
    });
    expect(fault?.layer).toBe("provider");
    expect(fault?.code).toBe("quota_exhausted");
    // The later of Retry-After (21:02) and earliest_reset (23:00) wins.
    expect(fault?.retryNotBefore).toBe("2026-10-03T23:00:00.000Z");
  });

  it("classifies the hook's raw body shape and honors a Retry-After later than earliest_reset", () => {
    const atMs = Date.parse("2026-10-03T21:00:00Z");
    const fault = classifyGatewayExchange({
      atMs,
      status: 429,
      retryAfterSeconds: 60,
      errorBody: {
        error: {
          ...RAW_TIER_BODY.error,
          earliest_reset: "2026-10-03T21:00:30Z",
        },
      },
    });
    expect(fault?.code).toBe("quota_exhausted");
    expect(fault?.retryNotBefore).toBe("2026-10-03T21:01:00.000Z");
  });

  it("classifies on the structured type alone, never message text", () => {
    // A refusal whose human message names nothing recognizable still
    // classifies as quota...
    const quiet = classifyGatewayExchange({
      atMs: Date.now(),
      status: 429,
      errorBody: {
        error: { type: "tier_exhausted", message: "florps", tier: "flash" },
      },
    });
    expect(quiet?.code).toBe("quota_exhausted");
    // ...and a body whose message merely mentions the words is not a
    // refusal: no structured type, no structured fault.
    const chatty = classifyGatewayExchange({
      atMs: Date.now(),
      status: 429,
      errorBody: {
        error: {
          type: "None",
          message: "tier_exhausted: no eligible model has quota",
          provider_specific_fields: { type: "server_error" },
        },
      },
    });
    expect(chatty).toBeUndefined();
    expect(parseTierExhaustedRefusal(WRAPPED_TIER_BODY)?.tier).toBe("flash");
    expect(parseTierExhaustedRefusal(RAW_TIER_BODY)?.effort).toBe("high");
  });

  it("carries no retry hint when both Retry-After and earliest_reset are absent", () => {
    const fault = classifyGatewayExchange({
      atMs: Date.now(),
      status: 429,
      errorBody: RAW_TIER_BODY,
    });
    expect(fault?.code).toBe("quota_exhausted");
    expect(fault?.retryNotBefore).toBeUndefined();
  });
});

describe("gateway exchange observation", () => {
  it("extracts the concrete served model from response headers and structured refusals from error bodies", async () => {
    const notes: GatewayExchange[] = [];
    const bodyTexts: string[] = [];
    let innerCalls = 0;
    const inner = (async (
      _model: unknown,
      _context: unknown,
      options: unknown,
    ) => {
      innerCalls += 1;
      const streamOptions = options as {
        fetch?: (url: string) => Promise<Response>;
      };
      const fetchImpl = streamOptions.fetch;
      if (!fetchImpl) throw new Error("observer did not install a fetch");
      const res = await fetchImpl("http://gateway/v1/chat/completions");
      bodyTexts.push(await res.text());
      return { ok: res } as never;
    }) as unknown as StreamFn;
    const agent = { streamFn: inner };
    armGatewayObserver(agent, (exchange) => notes.push(exchange));

    const failing = agent.streamFn as unknown as (
      model: unknown,
      context: unknown,
      options: unknown,
    ) => Promise<unknown>;
    // The wrapped fetch answers the call: first a served success, then a
    // tier refusal. The observer must see both exchanges untouched.
    const responses = [
      new Response("{}", {
        status: 200,
        headers: {
          "x-litellm-model-group": "ollama-cloud/glm-5.3-flash",
          "x-litellm-model-name": "ollama_chat/glm-5.3-flash",
          "x-litellm-model-id": "59dd17867abe",
          "x-litellm-model-api-base": "https://ollama.com",
          "x-litellm-call-id": "call-1",
        },
      }),
      new Response(JSON.stringify(WRAPPED_TIER_BODY), {
        status: 429,
        headers: {
          "retry-after": "120",
          "content-type": "application/json",
        },
      }),
    ];
    const options = {
      fetch: async () => responses.shift()!,
    };
    await failing({ id: "m" }, {}, options);
    await failing({ id: "m" }, {}, options);

    expect(innerCalls).toBe(2);
    expect(notes).toHaveLength(2);
    expect(notes[0]!.servedModel).toEqual({
      model: "ollama-cloud/glm-5.3-flash",
      modelId: "59dd17867abe",
      modelName: "ollama_chat/glm-5.3-flash",
      apiBase: "https://ollama.com",
      callId: "call-1",
    });
    expect(notes[1]!.status).toBe(429);
    expect(notes[1]!.retryAfterSeconds).toBe(120);
    expect(parseTierExhaustedRefusal(notes[1]!.errorBody)?.tier).toBe("flash");
    // Both bodies streamed to their consumer untouched.
    expect(bodyTexts).toHaveLength(2);
    expect(bodyTexts[0]).toBe("{}");
    expect(JSON.parse(bodyTexts[1]!)).toEqual(WRAPPED_TIER_BODY);
  });

  it("emits one pi_served_model evidence row per served model, deduplicated", () => {
    const events: { event: string; detail: Record<string, unknown> }[] = [];
    const sink: RunAuditSink = {
      appendEvent: (_runId, event, detail) => {
        events.push({ event, detail });
      },
      putArtifact: () => Promise.resolve(undefined),
    };
    const evidence = new RunEvidenceCollector("run-1", sink, []);
    evidence.servedModel({ model: "zai/glm-5.3" });
    evidence.servedModel({ model: "zai/glm-5.3" });
    evidence.servedModel({ model: "ollama-cloud/glm-5.3-flash" });
    const served = events.filter((row) => row.event === "pi_served_model");
    expect(served.map((row) => row.detail.model)).toEqual([
      "zai/glm-5.3",
      "ollama-cloud/glm-5.3-flash",
    ]);
  });
});

const modelSpec = (baseUrl: string, id: string): PiModelSpec => ({
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

const respondTierExhausted = (
  response: ServerResponse,
  body: unknown,
  retryAfter?: string,
): void => {
  response.writeHead(429, {
    "content-type": "application/json",
    ...(retryAfter !== undefined ? { "retry-after": retryAfter } : {}),
  });
  response.end(JSON.stringify(body));
};

describe("runner fault seam", () => {
  it("ends a tier_exhausted run as provider quota with the provider's retry hint", async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        respondTierExhausted(response, WRAPPED_TIER_BODY, "120");
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
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-tier-fault-test-"));
    scratchDirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        defaultTools: [],
      },
      {
        model: modelSpec(baseUrl, "moira/flash"),
        scratchDir,
        broker: { resolve: () => "test-key" },
        jiggleBackoffMs: 1,
        connectionRetryBackoffMs: 1,
        maxTurns: 2,
        runTimeoutMs: 10_000,
      },
    );

    const startedAt = performance.now();
    const result = await runner.run({
      runId: "tier-fault-contract",
      packet: { goal: "Review the change", head_sha: "a".repeat(40) },
      environment: { role: "reviewer" },
    });

    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(result.fault?.layer).toBe("provider");
    expect(result.fault?.code).toBe("quota_exhausted");
    const notBefore = Date.parse(result.fault?.retryNotBefore ?? "");
    expect(Number.isFinite(notBefore)).toBe(true);
    expect(notBefore).toBeGreaterThan(Date.now());
  });

  it("never classifies a lookalike message without the structured type", async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        respondTierExhausted(
          response,
          {
            error: {
              type: "None",
              message: "429 tier_exhausted: no eligible model has quota",
              code: "429",
              provider_specific_fields: { type: "server_error" },
            },
          },
          "600",
        );
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
    const scratchDir = mkdtempSync(join(tmpdir(), "colony-tier-lookalike-"));
    scratchDirs.push(scratchDir);
    const runner = new PiBaseAgentRunner(
      {
        ...REVIEWER_ROLE_PROFILE,
        workspaceMode: "scratch",
        requireRepositoryInspection: false,
        defaultTools: [],
      },
      {
        model: modelSpec(baseUrl, "moira/flash"),
        scratchDir,
        broker: { resolve: () => "test-key" },
        jiggleBackoffMs: 1,
        connectionRetryBackoffMs: 1,
        maxTurns: 2,
        runTimeoutMs: 10_000,
      },
    );

    const result = await runner.run({
      runId: "tier-lookalike-contract",
      packet: { goal: "Review the change", head_sha: "b".repeat(40) },
      environment: { role: "reviewer" },
    });

    // Without a structured tier_exhausted type the ordinary 429 text
    // classifier stands: http_429, and no provider-directed retry delay.
    expect(result.fault?.code).toBe("http_429");
    expect(result.fault?.retryNotBefore).toBeUndefined();
  });
});
