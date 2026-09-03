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

function createRecordingFetch(recorded: RecordedCall[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    recorded.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("notifier restart integration", () => {
  it("does not re-emit already-processed events after restart, and emits new rows after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "colonyd-notifier-restart-"));
    dirs.push(dir);
    const dbPath = join(dir, "restart.db");
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
        "      url: https://ntfy.sh/test-restart-topic",
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

    // First boot
    const recorded1: RecordedCall[] = [];
    let handle: ColonydHandle = await boot({
      headless: true,
      notifierFetchImpl: createRecordingFetch(recorded1),
    });

    const store = handle.ctx.store;
    const scope1 = store.createScope({
      goal: "scope before restart",
      title: "scope before restart",
      provider_repo_id: "1",
      provider_repo_path: "fake/repo",
    });

    store.audit("svc:colonyd", "scope.transition", {
      scope_id: scope1.id,
      detail: { to: "done" },
    });

    await handle.notifier!.run();
    expect(recorded1).toHaveLength(1);
    const firstBody =
      typeof recorded1[0].init?.body === "string" ? recorded1[0].init.body : "";
    expect(firstBody).toContain(`Scope ${scope1.id} transitioned to done.`);

    // Shut down first instance
    await handle.shutdown();

    // Second boot against the same database file
    const recorded2: RecordedCall[] = [];
    handle = await boot({
      headless: true,
      notifierFetchImpl: createRecordingFetch(recorded2),
    });

    try {
      // Run notifier immediately after restart without new rows
      await handle.notifier!.run();
      expect(recorded2).toHaveLength(0);

      // Now seed new row after restart
      const store2 = handle.ctx.store;
      const scope2 = store2.createScope({
        goal: "scope after restart",
        title: "scope after restart",
        provider_repo_id: "1",
        provider_repo_path: "fake/repo",
      });

      store2.audit("svc:colonyd", "scope.transition", {
        scope_id: scope2.id,
        detail: { to: "done" },
      });

      await handle.notifier!.run();
      expect(recorded2).toHaveLength(1);
      const secondBody =
        typeof recorded2[0].init?.body === "string"
          ? recorded2[0].init.body
          : "";
      expect(secondBody).toContain(`Scope ${scope2.id} transitioned to done.`);
      expect(secondBody).not.toContain(scope1.id);
    } finally {
      await handle.shutdown();
    }
  });
});
