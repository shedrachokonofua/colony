import { afterEach, describe, expect, it } from "bun:test";
import {
  isTracingEnabled,
  registerInMemorySpanExporter,
  startColonyRunSpan,
  startHttpServerSpan,
  startTelemetry,
  startTickSpan,
  startWebhookSpan,
  withSpanContext,
} from "./index.js";
import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

interface Seam {
  exporter: InMemorySpanExporter;
  shutdown: () => Promise<void>;
}

let seam: Seam | undefined;
let shutdownTelemetry: (() => Promise<void>) | undefined;

afterEach(async () => {
  await seam?.shutdown();
  seam = undefined;
  await shutdownTelemetry?.();
  shutdownTelemetry = undefined;
});

function startedSpans(name: string) {
  return seam!.exporter.getFinishedSpans().filter((span) => {
    return span.name === name;
  });
}

describe("tracing seam", () => {
  it("records colony.run spans with the required attributes", () => {
    seam = registerInMemorySpanExporter();
    const run = startColonyRunSpan({
      scope_id: "col-signalroom",
      task_id: "col-a95583ab.1",
      run_id: "run-123",
      kind: "implement",
      model_id: "mimo-v2.5-pro",
    });
    expect(run).toBeDefined();
    run!.end("succeeded");

    const [span] = startedSpans("colony.run");
    expect(span).toBeDefined();
    expect(span!.spanContext().traceId).toBe(run!.traceId);
    expect(span!.attributes["colony.scope_id"]).toBe("col-signalroom");
    expect(span!.attributes["colony.task_id"]).toBe("col-a95583ab.1");
    expect(span!.attributes["colony.run_id"]).toBe("run-123");
    expect(span!.attributes["colony.run.kind"]).toBe("implement");
    expect(span!.attributes["colony.model.id"]).toBe("mimo-v2.5-pro");
    expect(span!.attributes["colony.run.status"]).toBe("succeeded");
    // failure_reason must be absent when no reason was given.
    expect("colony.run.failure_reason" in span!.attributes).toBe(false);
  });

  it("omits colony.run.failure_reason unless a reason is provided", () => {
    seam = registerInMemorySpanExporter();
    const run = startColonyRunSpan({
      scope_id: "col-signalroom",
      task_id: null,
      run_id: "run-124",
      kind: "review",
      model_id: null,
    });
    run!.end("failed", "max_turns");

    const [span] = startedSpans("colony.run");
    expect(span!.attributes["colony.run.status"]).toBe("failed");
    expect(span!.attributes["colony.run.failure_reason"]).toBe("max_turns");
    expect(span!.attributes["colony.task_id"]).toBe("");
    expect(span!.attributes["colony.model.id"]).toBe("");
  });

  it("nests child spans under the run span's trace", () => {
    seam = registerInMemorySpanExporter();
    const run = startColonyRunSpan({
      scope_id: "col-signalroom",
      task_id: "t",
      run_id: "run-125",
      kind: "implement",
      model_id: null,
    });
    let childTraceId: string | undefined;
    withSpanContext(run!.spanContext, () => {
      const finish = startHttpServerSpan("GET", "/healthz");
      finish!(200);
      childTraceId =
        startedSpans("colony.http.server")[0]?.spanContext().traceId;
    });
    run!.end("succeeded");

    expect(childTraceId).toBe(run!.traceId);
  });

  it("keeps helpers as no-ops when tracing is disabled", async () => {
    expect(isTracingEnabled()).toBe(false);

    const run = startColonyRunSpan({
      scope_id: "col-signalroom",
      task_id: null,
      run_id: "run-126",
      kind: "implement",
      model_id: null,
    });
    expect(run).toBeUndefined();

    const http = startHttpServerSpan("POST", "/hooks");
    expect(http).toBeUndefined();

    const webhook = startWebhookSpan("task.created");
    webhook();

    const tick = startTickSpan();
    tick.end();

    // No tracer provider anywhere: starting a span through the API yields
    // non-recording no-op spans only.
    shutdownTelemetry = startTelemetry({ serviceName: "colony-test" });
    expect(isTracingEnabled()).toBe(false);
  });

  it("samples tick, webhook, POST, and runs regardless of the ratio", async () => {
    process.env["COLONY_TRACE_HTTP_RATIO"] = "0";
    seam = registerInMemorySpanExporter();

    startTickSpan().end();
    startWebhookSpan("scope.created")();
    startWebhookSpan("")(); // empty event type omits the attribute
    const post = startHttpServerSpan("POST", "/api/scopes");
    expect(post).toBeDefined();
    post!(200);
    const run = startColonyRunSpan({
      scope_id: "col-signalroom",
      task_id: null,
      run_id: "run-127",
      kind: "implement",
      model_id: null,
    });
    run!.end("succeeded");
    await flush();

    expect(startedSpans("colony.tick")).toHaveLength(1);
    expect(startedSpans("colony.webhook")).toHaveLength(2);
    expect(
      startedSpans("colony.webhook")[0].attributes["colony.webhook.event_type"],
    ).toBe("scope.created");
    expect(
      startedSpans("colony.webhook")[1].attributes["colony.webhook.event_type"],
    ).toBeUndefined();
    expect(startedSpans("colony.http.server")[0].name).toBe(
      "colony.http.server",
    );
    expect(startedSpans("colony.run")).toHaveLength(1);
  });

  it("drops GET server spans when the ratio is zero", async () => {
    process.env["COLONY_TRACE_HTTP_RATIO"] = "0";
    seam = registerInMemorySpanExporter();

    const finish = startHttpServerSpan("GET", "/projects");
    expect(finish).toBeDefined();
    finish!(200);

    expect(startedSpans("colony.http.server")).toHaveLength(0);
  });

  it("ratio-samples GET server spans deterministically at the configured cut", async () => {
    process.env["COLONY_TRACE_HTTP_RATIO"] = "1";
    seam = registerInMemorySpanExporter();

    const finish = startHttpServerSpan("GET", "/projects");
    finish!(200);
    await flush();

    expect(startedSpans("colony.http.server")).toHaveLength(1);
    expect(
      startedSpans("colony.http.server")[0].attributes["http.request.method"],
    ).toBe("GET");
    expect(startedSpans("colony.http.server")[0].attributes["http.route"]).toBe(
      "/projects",
    );
    expect(
      startedSpans("colony.http.server")[0].attributes[
        "http.response.status_code"
      ],
    ).toBe(200);
  });

  it("startTelemetry registers tracing when an OTLP endpoint is provided", () => {
    shutdownTelemetry = startTelemetry({
      serviceName: "colony-test",
      otlpTracesEndpoint: "http://127.0.0.1:4318/v1/traces",
      traceHttpSampleRatio: 1,
    });
    expect(isTracingEnabled()).toBe(true);
  });
});

async function flush(): Promise<void> {
  await Bun.sleep(10);
}
