import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { resetEnvCache } from "@colony/config";
import { Store } from "@colony/core";
import { createLocalArtifactStore } from "@colony/core";
import {
  isTracingEnabled,
  registerInMemorySpanExporter,
} from "@colony/observability";
import type { ColonydContext } from "../src/context.js";
import { SERVICE_ACTOR } from "../src/context.js";
import { buildApp } from "../src/http.js";
import { boot, type ColonydHandle } from "../src/main.js";
import { awaitPendingRuns } from "../src/runs/registry.js";

/**
 * Control-plane tracing end to end. COLONY_TRACE_HTTP_RATIO must be fixed
 * BEFORE the in-memory provider is registered (the sampler reads it at
 * construction), so ratio-sampled GET spans behave deterministically; the
 * explicit =0 case below re-registers a fresh provider after unsetting it.
 *
 * boot() must run while tracing is still OFF (no OTLP endpoint configured):
 * startTelemetryFromEnv refuses a second provider under a different service
 * name. Boot-based tests therefore boot first and only then swap in the
 * in-memory exporter, and every registration is undone before returning so
 * tests stay order-independent.
 */
const RATIO_ENV = "COLONY_TRACE_HTTP_RATIO";
const OTEL_TRACES_ENV = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";
const OTEL_BASE_ENV = "OTEL_EXPORTER_OTLP_ENDPOINT";

process.env[RATIO_ENV] = "1";
delete process.env[OTEL_TRACES_ENV];
delete process.env[OTEL_BASE_ENV];

let exporter: InMemorySpanExporter | undefined;
let shutdownTracing: (() => Promise<void>) | undefined;
let dir: string;

afterAll(async () => {
  // The global telemetry registration must not outlive this file (bun runs
  // all test files in one process).
  await shutdownTracing?.();
  shutdownTracing = undefined;
  exporter = undefined;
  delete process.env[RATIO_ENV];
  process.env["GITLAB_WEBHOOK_SECRET"] = "";
});

function spans(name: string) {
  return (
    exporter?.getFinishedSpans().filter((span) => span.name === name) ?? []
  );
}

/** Registers the test exporter against the fixed ratio; tracing must be off. */
function registerExporter(): void {
  const registration = registerInMemorySpanExporter();
  exporter = registration.exporter;
  shutdownTracing = registration.shutdown;
}

async function unregisterExporter(): Promise<void> {
  await shutdownTracing?.();
  shutdownTracing = undefined;
  exporter = undefined;
  expect(isTracingEnabled()).toBe(false);
}

const ACTOR = { headers: { "X-Actor-Id": "human:tracing" } };

/** Minimal colonyd app over a throwaway store; no agent is ever invoked. */
function appWith(traceUiBaseUrl = "") {
  const dbDir = mkdtempSync(join(tmpdir(), "colonyd-tracing-"));
  const store = new Store(join(dbDir, "test.db"));
  const ctx: ColonydContext = {
    store,
    provider: {} as ColonydContext["provider"],
    config: {
      reviewMode: "required",
      hitlMode: "yolo",
    } as ColonydContext["config"],
    agents: {} as ColonydContext["agents"],
    artifacts: createLocalArtifactStore(
      mkdtempSync(join(tmpdir(), "colonyd-artifacts-")),
    ),
    logger: { info() {}, warn() {}, error() {} },
    env: {
      gitlabBaseUrl: "https://gitlab.example.com",
      gitlabToken: "",
      webhookSecret: "",
      singleToken: true,
      maxConcurrent: 1,
      maxAttempts: 3,
      oidcIssuer: "",
      oidcClientId: "colony",
      oidcRequiredRole: "",
      traceUiBaseUrl,
    },
    requestTick() {},
  };
  return { app: buildApp(ctx), store };
}

/** Writes the fake-runtime fixture config and boots a headless colonyd. */
async function bootHeadless(dbName: string): Promise<ColonydHandle> {
  dir ??= mkdtempSync(join(tmpdir(), "colonyd-tracing-boot-"));
  writeFileSync(
    join(dir, "colony.yaml"),
    [
      "agent_runtime: fake",
      "allow_literal_keys: true",
      "hitl:",
      "  mode: yolo",
      "providers:",
      "  fake_llm:",
      "    api: openai-completions",
      "    base_url: http://localhost:9/v1",
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
  process.env["GITLAB_WEBHOOK_SECRET"] = "whsec-tracing";
  process.env["COLONY_CONFIG_PATH"] = join(dir, "colony.yaml");
  process.env["NODE_ENV"] ||= "test";
  process.env["AGENT_RUNTIME"] ||= "fake";
  process.env["COLONYD_DB_PATH"] = join(dir, dbName);
  resetEnvCache();
  return boot({ headless: true });
}

describe("control-plane tracing", () => {
  it("records an http.server span for GET /scopes with method, route, and status", async () => {
    registerExporter();
    try {
      const { app } = appWith();
      const res = await app.request("/scopes", ACTOR);
      expect(res.status).toBe(200);

      const httpSpans = spans("colony.http.server");
      expect(httpSpans).toHaveLength(1);
      expect(httpSpans[0].attributes["http.request.method"]).toBe("GET");
      expect(httpSpans[0].attributes["http.route"]).toBe("/scopes");
      expect(httpSpans[0].attributes["http.response.status_code"]).toBe(200);
    } finally {
      await unregisterExporter();
    }
  });

  it("never records a span for /health", async () => {
    registerExporter();
    try {
      const { app } = appWith();
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(spans("colony.http.server")).toHaveLength(0);
    } finally {
      await unregisterExporter();
    }
  });

  it("excludes static /ui assets but traces / and /ui/config", async () => {
    registerExporter();
    try {
      const asset = await appWith().app.request("/ui/styles.css");
      expect(asset.status).toBe(200);

      const shell = await appWith().app.request("/");
      expect(shell.status).toBe(200);

      const cfg = await appWith().app.request("/ui/config");
      expect(cfg.status).toBe(200);

      const routes = spans("colony.http.server").map(
        (span) => span.attributes["http.route"],
      );
      expect(routes).toEqual(["/", "/ui/config"]);
    } finally {
      await unregisterExporter();
    }
  });

  it("drops ratio-sampled GET spans at ratio 0 but keeps POST spans", async () => {
    await unregisterExporter();
    process.env[RATIO_ENV] = "0";
    try {
      registerExporter();

      const { app } = appWith();
      await app.request("/scopes", ACTOR); // GET, dropped at ratio 0
      await app.request("/scopes", { ...ACTOR, method: "POST" }); // always kept

      const httpSpans = spans("colony.http.server");
      expect(httpSpans).toHaveLength(1);
      expect(httpSpans[0].attributes["http.request.method"]).toBe("POST");
    } finally {
      process.env[RATIO_ENV] = "1";
      await unregisterExporter();
    }
  });

  it("records the X-Gitlab-Event header on webhook intake spans", async () => {
    const handle = await bootHeadless("webhook.db");
    try {
      registerExporter();

      const app = buildApp(handle.ctx);
      const denied = await app.request("/webhook/gitlab", {
        method: "POST",
        headers: { "X-Gitlab-Token": "wrong" },
        body: "{}",
      });
      expect(denied.status).toBe(401);

      const accepted = await app.request("/webhook/gitlab", {
        method: "POST",
        headers: {
          "X-Gitlab-Token": "whsec-tracing",
          "X-Gitlab-Event": "Push Hook",
        },
        body: "{}",
      });
      expect(accepted.status).toBe(200);

      // The rejected delivery never reached intake; exactly one span exists.
      const webhookSpans = spans("colony.webhook");
      expect(webhookSpans).toHaveLength(1);
      expect(webhookSpans[0].attributes["colony.webhook.event_type"]).toBe(
        "Push Hook",
      );

      // Intake over the real boot surfaces an unset trace UI base as null.
      const config = await app.request("/ui/config");
      expect(await config.json()).toMatchObject({ trace_ui_base_url: null });
    } finally {
      await unregisterExporter();
      await handle.shutdown();
    }
  });

  it("returns COLONY_TRACE_UI_BASE_URL on /ui/config through the real env path", async () => {
    process.env["COLONY_TRACE_UI_BASE_URL"] = "https://traces.example.com";
    resetEnvCache();
    const booted = await bootHeadless("config.db");
    try {
      const res = await buildApp(booted.ctx).request("/ui/config");
      expect(await res.json()).toMatchObject({
        trace_ui_base_url: "https://traces.example.com",
      });
    } finally {
      await booted.shutdown();
      delete process.env["COLONY_TRACE_UI_BASE_URL"];
      resetEnvCache();
    }
  });

  it("produces a colony.tick span only for ticks that dispatch runs", async () => {
    const handle = await bootHeadless("tick.db");
    try {
      registerExporter();
      const store = handle.ctx.store;

      // A tick over an empty store dispatches nothing: no span.
      await handle.tick();
      await awaitPendingRuns();
      expect(spans("colony.tick")).toHaveLength(0);

      // Seed an active scope with a queued task: the next tick dispatches an
      // implement run and must record exactly one tick span.
      const scope = store.createScope({
        goal: "traced dispatch",
        provider_repo_id: "fake-repo",
        provider_repo_path: "so/fake-e2e",
      });
      store.setScopeStatus(scope.id, "planning", SERVICE_ACTOR);
      const task = store.materializePlan(
        scope.id,
        {
          kind: "architect_decomposition",
          summary: "one task",
          acceptance: [{ description: "holds", command: "true" }],
          tasks: [{ title: "t", spec: "s", depends_on: [] }],
        },
        SERVICE_ACTOR,
      )[0];
      // materializePlan already moved the scope to active.
      expect(task).toBeDefined();

      await handle.tick();
      await awaitPendingRuns();
      const tickSpans = spans("colony.tick");
      expect(tickSpans).toHaveLength(1);
      expect(store.getTask(task!.id)?.state).toBe("running");

      // Park the scope (readyTasks only considers active scopes) and verify
      // the final tick is quiet again.
      store.setScopeStatus(scope.id, "done", SERVICE_ACTOR);
      await handle.tick();
      await awaitPendingRuns();
      expect(spans("colony.tick")).toHaveLength(1);
    } finally {
      await unregisterExporter();
      await handle.shutdown();
    }
  });
});
