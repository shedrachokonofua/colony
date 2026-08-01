import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginAgentRun,
  instrumentFetch,
  recordAgentMessage,
  recordAgentToolCall,
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

    const body = await fetch(`http://127.0.0.1:${port}/metrics`).then(
      (response) => response.text(),
    );

    expect(body).toContain("colony_http_server_requests_total");
    expect(body).toContain('http_route="/scopes/:scope_id/tasks/:id"');
    expect(body).toContain("colony_agent_run_duration_bucket");
    expect(body).toContain('model="mimo-v2.5-pro"');
    expect(body).toContain('type="input"');
    expect(body).not.toContain("col-signalroom");
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
