import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { resetEnvCache } from "@colony/config";
import { boot, type ColonydHandle } from "../src/main.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function createRecordingFetch(
  recorded: RecordedCall[],
  shouldFail = false,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (shouldFail) {
      throw new Error("sink network failure");
    }
    recorded.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("notifier loop (unit/headless)", () => {
  it("delivers notifications, handles blocked reason, persists cursor, and second run sends nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-notifier-test-"));
    dirs.push(dir);
    const dbPath = join(dir, "test.db");
    const configPath = join(dir, "colony.yaml");

    writeFileSync(
      configPath,
      [
        "agent_runtime: fake",
        "allow_literal_keys: true",
        "hitl:",
        "  mode: yolo",
        "notifications:",
        "  cooldown_s: 300",
        "  digest_window_s: 300",
        "  sinks:",
        "    - kind: ntfy",
        "      url: https://ntfy.sh/test-topic-123",
        "      min_severity: info",
      ].join("\n"),
      "utf8",
    );

    process.env["NODE_ENV"] = "test";
    process.env["AGENT_RUNTIME"] = "fake";
    process.env["COLONYD_DB_PATH"] = dbPath;
    process.env["COLONY_CONFIG_PATH"] = configPath;
    process.env["COLONY_CONSOLE_BASE_URL"] = "https://console.example.com";
    resetEnvCache();

    const recorded: RecordedCall[] = [];
    const handle: ColonydHandle = await boot({
      headless: true,
      notifierFetchImpl: createRecordingFetch(recorded),
    });

    try {
      expect(handle.notifier).toBeDefined();

      const store = handle.ctx.store;
      const scope = store.createScope({
        goal: "test scope",
        title: "test scope",
        provider_repo_id: "1",
        provider_repo_path: "fake/repo",
      });
      store.setScopeStatus(scope.id, "planning", "svc:colonyd");

      const [task] = store.materializePlan(
        scope.id,
        {
          kind: "architect_decomposition",
          summary: "test plan",
          acceptance: [{ description: "ok", command: "true" }],
          tasks: [{ title: "Test Task", spec: "Do something", depends_on: [] }],
        },
        "svc:colonyd",
      );

      // Transition queued -> running -> blocked
      store.transitionTask(
        task.id,
        task.state_version,
        "running",
        "svc:colonyd",
      );
      const runningTask = store.getTask(task.id)!;
      store.transitionTask(
        task.id,
        runningTask.state_version,
        "blocked",
        "svc:colonyd",
        {
          blocked_reason: "Dependencies unavailable",
        },
      );

      // Seed audit row for task.transition to blocked
      store.audit("svc:colonyd", "task.transition", {
        scope_id: scope.id,
        task_id: task.id,
        detail: {
          from: "queued",
          to: "blocked",
        },
      });

      const lastAuditId = store.db
        .prepare("SELECT MAX(id) as max_id FROM audit")
        .get() as { max_id: number };

      await handle.notifier!.run();

      expect(recorded.length).toBeGreaterThanOrEqual(1);
      const lastPayload = recorded[recorded.length - 1];
      expect(lastPayload.url).toBe("https://ntfy.sh/test-topic-123");
      const bodyText =
        typeof lastPayload.init?.body === "string" ? lastPayload.init.body : "";
      expect(bodyText).toContain("Dependencies unavailable");

      // Verify cursor is persisted
      const cursor = store.getMetaValue("notifier_cursor");
      expect(cursor).toBe(String(lastAuditId.max_id));

      // Second run without new audit rows produces no deliveries
      const recordedCountBefore = recorded.length;
      await handle.notifier!.run();
      expect(recorded.length).toBe(recordedCountBefore);
    } finally {
      await handle.shutdown();
    }
  });

  it("booted without a notifications block, handle.notifier is undefined and cursor stays null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-notifier-disabled-"));
    dirs.push(dir);
    const dbPath = join(dir, "test.db");
    const configPath = join(dir, "colony.yaml");

    writeFileSync(
      configPath,
      [
        "agent_runtime: fake",
        "allow_literal_keys: true",
        "hitl:",
        "  mode: yolo",
      ].join("\n"),
      "utf8",
    );

    process.env["NODE_ENV"] = "test";
    process.env["AGENT_RUNTIME"] = "fake";
    process.env["COLONYD_DB_PATH"] = dbPath;
    process.env["COLONY_CONFIG_PATH"] = configPath;
    resetEnvCache();

    const handle = await boot({
      headless: true,
    });

    try {
      expect(handle.notifier).toBeUndefined();
      const cursor = handle.ctx.store.getMetaValue("notifier_cursor");
      expect(cursor).toBeNull();
    } finally {
      await handle.shutdown();
    }
  });

  it("a sink whose recording fetch rejects is logged without throwing and the cursor still advances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-notifier-fail-"));
    dirs.push(dir);
    const dbPath = join(dir, "test.db");
    const configPath = join(dir, "colony.yaml");

    writeFileSync(
      configPath,
      [
        "agent_runtime: fake",
        "allow_literal_keys: true",
        "hitl:",
        "  mode: yolo",
        "notifications:",
        "  cooldown_s: 300",
        "  digest_window_s: 300",
        "  sinks:",
        "    - kind: ntfy",
        "      url: https://ntfy.sh/test-topic-failing",
        "      min_severity: info",
      ].join("\n"),
      "utf8",
    );

    process.env["NODE_ENV"] = "test";
    process.env["AGENT_RUNTIME"] = "fake";
    process.env["COLONYD_DB_PATH"] = dbPath;
    process.env["COLONY_CONFIG_PATH"] = configPath;
    resetEnvCache();

    const recorded: RecordedCall[] = [];
    const handle = await boot({
      headless: true,
      notifierFetchImpl: createRecordingFetch(recorded, true),
    });

    try {
      expect(handle.notifier).toBeDefined();
      const store = handle.ctx.store;

      const scope = store.createScope({
        goal: "fail scope",
        title: "fail scope",
        provider_repo_id: "1",
        provider_repo_path: "fake/repo",
      });

      store.audit("svc:colonyd", "scope.transition", {
        scope_id: scope.id,
        detail: {
          to: "done",
        },
      });

      const lastAuditId = store.db
        .prepare("SELECT MAX(id) as max_id FROM audit")
        .get() as { max_id: number };

      // Should not throw even though fetch rejected
      await handle.notifier!.run();

      const cursor = store.getMetaValue("notifier_cursor");
      expect(cursor).toBe(String(lastAuditId.max_id));
    } finally {
      await handle.shutdown();
    }
  });

  it("single-flight guard coalesces concurrent runs and avoids cursor regression", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-notifier-single-flight-"));
    dirs.push(dir);
    const dbPath = join(dir, "test.db");
    const configPath = join(dir, "colony.yaml");

    writeFileSync(
      configPath,
      [
        "agent_runtime: fake",
        "allow_literal_keys: true",
        "hitl:",
        "  mode: yolo",
        "notifications:",
        "  cooldown_s: 300",
        "  digest_window_s: 300",
        "  sinks:",
        "    - kind: ntfy",
        "      url: https://ntfy.sh/test-topic-slow",
        "      min_severity: info",
      ].join("\n"),
      "utf8",
    );

    process.env["NODE_ENV"] = "test";
    process.env["AGENT_RUNTIME"] = "fake";
    process.env["COLONYD_DB_PATH"] = dbPath;
    process.env["COLONY_CONFIG_PATH"] = configPath;
    resetEnvCache();

    let fetchCalls = 0;
    const { promise: fetchGate, resolve: resolveFetchGate } =
      Promise.withResolvers<void>();
    const slowFetch: typeof fetch = (async () => {
      fetchCalls++;
      await fetchGate;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const handle = await boot({
      headless: true,
      notifierFetchImpl: slowFetch,
    });

    try {
      const store = handle.ctx.store;
      const scope = store.createScope({
        goal: "slow scope",
        title: "slow scope",
        provider_repo_id: "1",
        provider_repo_path: "fake/repo",
      });

      store.audit("svc:colonyd", "scope.transition", {
        scope_id: scope.id,
        detail: { to: "done" },
      });

      // Launch multiple concurrent run() calls
      const p1 = handle.notifier!.run();
      const p2 = handle.notifier!.run();
      const p3 = handle.notifier!.run();

      // Release the fetch in flight
      resolveFetchGate();

      await Promise.all([p1, p2, p3]);

      // Exactly 1 delivery should happen (second runs coalesced / saw cursor updated)
      expect(fetchCalls).toBe(1);
    } finally {
      await handle.shutdown();
    }
  });
});
