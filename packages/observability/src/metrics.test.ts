import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "bun:test";
import {
  beginAgentRun,
  instrumentFetch,
  recordAgentMessage,
  recordAgentToolCall,
  recordEmptyCompletion,
  startTelemetry,
} from "./metrics.js";

let shutdown: (() => Promise<void>) | undefined;

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
});

describe("Colony telemetry", () => {
  it("exposes bounded HTTP and model metrics in Prometheus format", async () => {
    const port = await availablePort();
    shutdown = startTelemetry({
      serviceName: "colony-test",
      serviceVersion: "test-sha",
      environment: "test",
      metricsPort: port,
    });

    const fetchHandler = instrumentFetch("api", async () =>
      Promise.resolve(new Response("ok", { status: 201 })),
    );
    await fetchHandler(
      new Request("http://localhost/scopes/col-signalroom/tasks/123"),
    );

    const labels = {
      role: "developer",
      provider: "openai_compatible",
      model: "mimo-v2.5-pro",
    };
    const finish = beginAgentRun(labels);
    recordAgentMessage(labels, {
      input: 120,
      output: 30,
      cacheRead: 10,
      costUsd: 0.04,
      turnDurationSeconds: 2.5,
    });
    recordAgentToolCall(labels, "bash", false);
    finish("succeeded");

    const failedRunFinish = beginAgentRun(labels);
    failedRunFinish("failed", "test_failure", {
      layer: "sandbox",
      code: "oom_killed",
    });

    const envelopeRejectedRunFinish = beginAgentRun(labels);
    envelopeRejectedRunFinish("envelope_rejected", "envelope failed schema parse", {
      layer: "model",
      code: "envelope_invalid",
    });

    const canceledRunFinish = beginAgentRun(labels);
    canceledRunFinish("canceled", "canceled by user", {
      layer: "unknown",
      code: "unknown",
    });

    recordEmptyCompletion("mimo-v2.5-pro");

    const body = await fetch(`http://127.0.0.1:${port}/metrics`).then(
      (response) => response.text(),
    );

    expect(body).toContain("colony_http_server_requests_total");
    expect(body).toContain('http_route="/scopes/:scope_id/tasks/:id"');
    expect(body).toContain("colony_agent_run_duration_bucket");
    expect(body).toContain('model="mimo-v2.5-pro"');
    expect(body).toContain('type="input"');
    expect(body).not.toContain("col-signalroom");

    // Success carries no fault attributes
    expect(body).toMatch(
      /colony_agent_runs_total\{[^}]*status="succeeded"[^}]*\}/,
    );
    expect(body).not.toMatch(
      /colony_agent_runs_total\{[^}]*status="succeeded"[^}]*fault_layer=/,
    );
    // Canceled carries no fault attributes
    expect(body).toMatch(
      /colony_agent_runs_total\{[^}]*status="canceled"[^}]*\}/,
    );
    expect(body).not.toMatch(
      /colony_agent_runs_total\{[^}]*status="canceled"[^}]*fault_layer=/,
    );
    // Failed carries fault.layer and fault.code (Prometheus converts dots to underscores)
    expect(body).toMatch(
      /colony_agent_runs_total\{[^}]*status="failed"[^}]*fault_layer="sandbox"[^}]*fault_code="oom_killed"[^}]*\}/,
    );
    // Envelope rejected carries fault.layer and fault.code
    expect(body).toMatch(
      /colony_agent_runs_total\{[^}]*status="envelope_rejected"[^}]*fault_layer="model"[^}]*fault_code="envelope_invalid"[^}]*\}/,
    );
    // Empty completion counter increments with model attribute
    expect(body).toMatch(
      /colony_agent_empty_completions_total\{[^}]*model="mimo-v2\.5-pro"[^}]*\} 1/,
    );
  });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate metrics test port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}
