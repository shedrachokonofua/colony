import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunAuditSink } from "./audit-sink.js";
import { buildSandboxTools } from "./sandbox-tools.js";
import { toolText } from "./sandbox-wiring.test.js";
import { buildSandboxLaunchProfile, type SandboxHandle } from "@colony/sandbox";
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
  it("a limited read window reports what remains, and never calls it truncation", async () => {
    // "… truncated" on every windowed read convinced grok a file was corrupt
    // ("run-resume.ts is truncated, I'll rewrite it", 44 turns, 2026-09-02).
    const workspace = mkdtempSync(join(tmpdir(), "colony-read-window-"));
    scratchDirs.push(workspace);
    const engine = createInProcessEngine();
    const handle = await engine.provision(
      buildSandboxLaunchProfile("developer"),
      workspace,
    );
    const tools = Object.fromEntries(
      buildSandboxTools(handle, workspace).map((tool) => [tool.name, tool]),
    );
    try {
      await handle.writeFile(
        "long.ts",
        Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n"),
      );
      const windowed = toolText(
        (await runTool(tools["read"], {
          path: "long.ts",
          offset: 1,
          limit: 50,
        })) as { content: { type: string; text?: string }[] },
      );
      expect(windowed).toContain("50:line 50");
      expect(windowed).not.toContain("truncated");
      expect(windowed).toContain(
        "70 more line(s) not shown (file has 120); read offset=51 to continue.",
      );
      const whole = toolText(
        (await runTool(tools["read"], { path: "long.ts" })) as {
          content: { type: string; text?: string }[];
        },
      );
      expect(whole).toContain("120:line 120");
      expect(whole).not.toContain("…");
    } finally {
      await handle.destroy();
    }
  });

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
        runToken: "glpat-run-secret-xyz",
      }).map((tool) => [tool.name, tool]),
    );
    try {
      // Output with ANSI escapes plus the run's own token: the tail must be
      // clean and redacted while the command itself is redacted too. The bash
      // shim throws on non-zero exit, so probe the exit through the ledger.
      const stdoutPayload = "a\u001B[31mANSI\u001B[0mb\n";
      const stderrPayload = "e\u001B[32mRR\u001B[0mf\n";
      try {
        await runTool(tools["bash"], {
          command: `printf 'a\\033[31mANSI\\033[0mb\\n'; echo glpat-run-secret-xyz; echo out; printf 'e\\033[32mRR\\033[0mf\\n' 1>&2; exit 3`,
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
      expect(String(detail["command"])).not.toContain("glpat-run-secret-xyz");
      expect(detail["exit_code"]).toBe(3);
      // Byte counts are the RAW captured stdout/stderr lengths, computed
      // before any redaction: a regression that redacts first (or swaps the
      // counters) flips these exact integers.
      expect(detail["stdout_bytes"]).toBe(
        Buffer.byteLength(`${stdoutPayload}glpat-run-secret-xyz\nout\n`),
      );
      expect(detail["stderr_bytes"]).toBe(Buffer.byteLength(stderrPayload));
      // The exec ran in the workspace root ("." is the workspace-relative
      // form of the run cwd the tools were built with).
      expect(String(detail["cwd"])).toBe(".");

      const tail = String(detail["truncated_tail"]);
      expect(tail).not.toContain("\u001B");
      expect(tail).toContain("aANSIb");
      expect(tail).toContain("[REDACTED]");
      expect(tail).toContain("out");
      expect(tail).toContain("eRRf");
      expect(typeof detail["duration_ms"]).toBe("number");
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

      // Arrival order, not stream-partitioned order: stderr is emitted (and
      // arrives) before the later stdout line; the sleep makes the pipe
      // arrival gap deterministic. Stream-partitioned output would always
      // append stderr after stdout.
      await runTool(tools["bash"], {
        command: "echo err-first 1>&2; sleep 0.2; echo out-later",
      });

      const commandEvents = events.filter((e) => e.event === "command");
      // bash + write's mkdir: every exec exactly once, regardless of which
      // tool triggered it.
      expect(commandEvents.length).toBe(3);
      expect(String(commandEvents[1]!.detail["command"])).toContain("mkdir -p");
      const big = String(commandEvents[0]!.detail["truncated_tail"]);
      expect(big.length).toBe(1000);
      // The final line of `seq 1 400` ends the captured output.
      expect(big.endsWith("400\n")).toBe(true);
      // Arrival order, not stream-partitioned order: the stderr line appears
      // where it was emitted, before the later stdout line.
      const interleaved = String(commandEvents[2]!.detail["truncated_tail"]);
      expect(interleaved.indexOf("err-first")).toBeLessThan(
        interleaved.indexOf("out-later"),
      );
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

  it("logs swallowed ledger sink failures via the runner logger", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "colony-ledger-log-"));
    scratchDirs.push(workspace);
    const engine = createInProcessEngine();
    const handle = await engine.provision(
      buildSandboxLaunchProfile("developer"),
      workspace,
    );
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const tools = Object.fromEntries(
      buildSandboxTools(handle, workspace, {
        auditSink: recordingSink(true).sink,
        runId: "run-ledger-logged",
        logger: {
          warn: (fields, message) => warnings.push({ fields, message }),
        },
      }).map((tool) => [tool.name, tool]),
    );
    try {
      await runTool(tools["bash"], { command: "echo logged-swallow" });
      expect(warnings.length).toBe(1);
      expect(warnings[0]!.message).toBe("sandbox_ledger_append_event_failed");
      expect(warnings[0]!.fields["runId"]).toBe("run-ledger-logged");
    } finally {
      await handle.destroy();
    }
  });

  it("propagates non-abort exec failures out of probe helpers", async () => {
    // A probe helper (find/ls exists, grep) shells out through execCapture.
    // A handle failure (exec after destroy, engine IO error) must surface as
    // a rejection, not masquerade as a completed run with empty output
    // ("not found" / "no matches").
    const broken: SandboxHandle = {
      sandboxId: "sandbox-broken",
      exec: () => Promise.reject(new Error("exec after destroy")),
      readFile: () => Promise.reject(new Error("unused")),
      writeFile: () => Promise.reject(new Error("unused")),
      destroy: () => Promise.resolve(),
    };
    const tools = Object.fromEntries(
      buildSandboxTools(broken, "/workspace").map((tool) => [tool.name, tool]),
    );
    await expect(
      runTool(tools["grep"], { pattern: "anything" }),
    ).rejects.toThrow("exec after destroy");
    await expect(
      runTool(tools["find"], { pattern: "**/*.ts" }),
    ).rejects.toThrow("exec after destroy");
  });

  it("keeps the bash seam's mid-exec abort semantics", async () => {
    // Only the bash operations seam forwards the tool's AbortSignal; a
    // mid-exec abort (run timeout, cancellation) must still surface as the
    // shim's "Command aborted" tool error, never a silent empty success.
    const controller = new AbortController();
    const { promise, reject } = Promise.withResolvers<{
      exitCode: number | null;
      timedOut?: boolean;
    }>();
    const pending: SandboxHandle = {
      sandboxId: "sandbox-pending",
      exec: () => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
        return promise;
      },
      readFile: () => Promise.reject(new Error("unused")),
      writeFile: () => Promise.reject(new Error("unused")),
      destroy: () => Promise.resolve(),
    };
    const tools = Object.fromEntries(
      buildSandboxTools(pending, "/workspace").map((tool) => [tool.name, tool]),
    );
    const bashExec = tools["bash"].execute as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const pendingExec = bashExec(
      "b-abort",
      { command: "sleep 999" },
      controller.signal,
    );
    // The stub's exec promise settles only when the signal aborts — no
    // wall-clock wait is needed; abort deterministically settles it.
    controller.abort();
    await expect(pendingExec).rejects.toThrow("Command aborted");
  });
});
