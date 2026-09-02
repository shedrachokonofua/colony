import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import type { ResolvedNotificationSink } from "@colony/config";
import { NTFY_PRIORITY, send } from "./ntfy.js";
import type { NotificationPayload } from "./types.js";

describe("ntfy sender", () => {
  let server: Server | null = null;
  let receivedRequests: Array<{
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }> = [];
  let responseStatusCode = 200;

  afterEach(async () => {
    if (server) {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await promise;
      server = null;
    }
    receivedRequests = [];
    responseStatusCode = 200;
  });

  async function startServer(): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        receivedRequests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        });
        res.writeHead(responseStatusCode);
        res.end("ok");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      if (typeof addr === "object" && addr) {
        resolve(`http://127.0.0.1:${addr.port}/test-topic`);
      } else {
        reject(new Error("Unable to determine server port"));
      }
    });
    return promise;
  }

  it("exports correct NTFY_PRIORITY mapping", () => {
    expect(NTFY_PRIORITY.info).toBe(2);
    expect(NTFY_PRIORITY.warning).toBe(4);
    expect(NTFY_PRIORITY.critical).toBe(5);
  });

  it("POSTs message with Title, Click, Priority headers to configured topic URL", async () => {
    const url = await startServer();
    const sink: ResolvedNotificationSink = {
      kind: "ntfy",
      url,
      minSeverity: "warning",
    };

    const payload: NotificationPayload = {
      title: "Task col-1.0 blocked",
      body: "Dependency build failed",
      severity: "critical",
      scope_id: "col-1",
      task_id: "col-1.0",
      url: "http://console.example.com/#/col-1",
    };

    await send(payload, sink);

    expect(receivedRequests).toHaveLength(1);
    const req = receivedRequests[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/test-topic");
    expect(req.headers.title).toBe("Task col-1.0 blocked");
    expect(req.headers.click).toBe("http://console.example.com/#/col-1");
    expect(req.headers.priority).toBe("5");
    expect(req.body).toBe("Dependency build failed");
  });

  it("maps severity levels to correct Priority headers", async () => {
    const url = await startServer();
    const sink: ResolvedNotificationSink = {
      kind: "ntfy",
      url,
      minSeverity: "info",
    };

    const severities = [
      { severity: "info", expectedPriority: "2" },
      { severity: "warning", expectedPriority: "4" },
      { severity: "critical", expectedPriority: "5" },
    ] as const;

    for (const { severity, expectedPriority } of severities) {
      receivedRequests = [];
      const payload: NotificationPayload = {
        title: `Title for ${severity}`,
        body: `Body for ${severity}`,
        severity,
        scope_id: "scope-1",
        url: "http://localhost/#/scope-1",
      };

      await send(payload, sink);
      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0].headers.priority).toBe(expectedPriority);
    }
  });

  it("rejects when the server returns non-2xx status", async () => {
    const url = await startServer();
    responseStatusCode = 500;
    const sink: ResolvedNotificationSink = {
      kind: "ntfy",
      url,
      minSeverity: "warning",
    };

    const payload: NotificationPayload = {
      title: "Test Error",
      body: "Error message",
      severity: "warning",
      scope_id: "scope-1",
      url: "http://localhost/#/scope-1",
    };

    expect(send(payload, sink)).rejects.toThrow(/ntfy send failed: HTTP 500/);
  });
});
