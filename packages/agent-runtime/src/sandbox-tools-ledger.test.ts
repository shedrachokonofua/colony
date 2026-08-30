import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunAuditSink } from "./audit-sink.js";
import { buildSandboxTools } from "./sandbox-tools.js";
import { buildSandboxLaunchProfile } from "@colony/sandbox";
import { createInProcessEngine } from "@colony/sandbox-in-process";
import { afterEach, describe, expect, it } from "bun:test";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Sink stub capturing every appended event; `failing` throws on append. */
function recordingSink(failing = false): {
  sink: RunAuditSink;
  events: { runId: string; event: string; detail: Record<string, unknown> }[];
} {
  const events: {
    runId: string;
    event: string;
    detail: Record<string, unknown>;
  }[] = [];
  return {
    events,
    sink: {
      appendEvent(runId, event, detail) {
        if (failing) throw new Error("sink down");
        events.push({ runId, event, detail });
      },
      putArtifact: () => Promise.resolve(undefined),
      recordArtifactRef: () => {},
    },
  };
}

/** Minimal ToolDefinition execute shim matching the sandbox-wiring pattern. */
async function runTool(
  tool: { name: string; execute: (...args: never[]) => unknown },
  args: Record<string, unknown>,
): Promise<unknown> {
  return (tool.execute as (...a: unknown[]) => Promise<unknown>)(
    "call-1",
    args,
    undefined,
    undefined,
    {},
  );
}

describe("exec command ledger", () => {
  it("emits one command event per execCapture with byte counts and ANSI-stripped tail", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "colony-ledger-test-"));
    scratchDirs.push(workspace);
    const engine = createInProcessEngine();
    const handle = await engine.provision(
      buildSandboxLaunchProfile("developer"),
      workspace,
    );
    const { sink, events } = recordingSink();
    const tools = Object.fromEntries(
      buildSandboxTools(handle, workspace, {
        auditSink: sink,
        runId: "run-ledger",
        runToken: "glpat-run-secret-token-xyz",
      }).map((tool) => [tool.name, tool]),
    );
    try {
      // Output with ANSI escapes plus the run's own token: the tail must be
      // clean and redacted while the command itself is redacted too. The bash
      // shim throws on non-zero exit, so probe the exit through the ledger.
      try {
        await runTool(tools["bash"], {
          command: `printf 'a\\033[31mANSI\\033[0mb\\n'; echo glpat-run-secret-token-xyz; echo out; echo err 1>&2; exit 3`,
        });
        throw new Error("expected bash exit 3 to surface as a tool error");
      } catch (err) {
        if (!(err instanceof Error) || !/code 3/.test(err.message)) {
          throw err;
        }
      }

      const commandEvents = events.filter((e) => e.event === "command");
      expect(commandEvents.length).toBe(1);
      const detail = commandEvents[0]!.detail;
      expect(commandEvents[0]!.runId).toBe("run-ledger");
      expect(typeof detail["command"]).toBe("string");
      expect(String(detail["command"])).not.toContain(
        "glpat-run-secret-token-xyz",
      );
      expect(detail["exit_code"]).toBe(3);

      const tail = String(detail["truncated_tail"]);
      expect(tail).not.toContain("\u001B");
      expect(tail).toContain("aANSIb");
      expect(tail).toContain("[REDACTED]");
      expect(tail).toContain("out");
      expect(tail).toContain("err");
      expect(typeof detail["duration_ms"]).toBe("number");
      expect(detail["stdout_bytes"]).toBeGreaterThan(0);
      expect(detail["stderr_bytes"]).toBeGreaterThan(0);
    } finally {
      await handle.destroy();
    }
  });

  it("caps the tail at 1000 chars and emits one event per exec across several tools", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "colony-ledger-cap-"));
    scratchDirs.push(workspace);
    const engine = createInProcessEngine();
    const handle = await engine.provision(
      buildSandboxLaunchProfile("developer"),
      workspace,
    );
    const { sink, events } = recordingSink();
    const tools = Object.fromEntries(
      buildSandboxTools(handle, workspace, {
        auditSink: sink,
        runId: "run-ledger-cap",
      }).map((tool) => [tool.name, tool]),
    );
    try {
      // >1000 chars on stdout via the bash tool.
      await runTool(tools["bash"], {
        command: "seq 1 400",
      });
      // A non-bash tool's internal exec also lands in the ledger: write to
      // a nested path runs its mkdir through execCapture like any other.
      await runTool(tools["write"], {
        path: "nested/ledger.txt",
        content: "ledger body",
      });

      const commandEvents = events.filter((e) => e.event === "command");
      // bash + write's mkdir: every exec exactly once, regardless of which
      // tool triggered it.
      expect(commandEvents.length).toBe(2);
      expect(String(commandEvents[1]!.detail["command"])).toContain("mkdir -p");
      const big = String(commandEvents[0]!.detail["truncated_tail"]);
      expect(big.length).toBe(1000);
      // The final line of `seq 1 400` ends the captured output.
      expect(big.endsWith("400\n")).toBe(true);
      for (const event of commandEvents) {
        expect(event.runId).toBe("run-ledger-cap");
        expect(typeof event.detail["stdout_bytes"]).toBe("number");
        expect(typeof event.detail["stderr_bytes"]).toBe("number");
        expect(typeof event.detail["duration_ms"]).toBe("number");
      }
    } finally {
      await handle.destroy();
    }
  });

  it("emits nothing without an audit sink and survives a throwing sink", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "colony-ledger-none-"));
    scratchDirs.push(workspace);
    const engine = createInProcessEngine();
    const handle = await engine.provision(
      buildSandboxLaunchProfile("developer"),
      workspace,
    );
    const silent = Object.fromEntries(
      buildSandboxTools(handle, workspace).map((tool) => [tool.name, tool]),
    );
    const failing = Object.fromEntries(
      buildSandboxTools(handle, workspace, {
        auditSink: recordingSink(true).sink,
        runId: "run-ledger-throw",
      }).map((tool) => [tool.name, tool]),
    );
    try {
      await runTool(silent["bash"], { command: "echo no-sink" });
      await runTool(failing["bash"], { command: "echo sink-down" });
      // Neither call threw: a broken sink never breaks an exec.
    } finally {
      await handle.destroy();
    }
  });
});
