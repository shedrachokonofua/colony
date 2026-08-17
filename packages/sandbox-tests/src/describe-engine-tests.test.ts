import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExecEvent,
  ExecRequest,
  ExecResult,
  SandboxEngine,
  SandboxHandle,
  SandboxLaunchProfile,
} from "@colony/sandbox";
import {
  describeEngineTests,
  runSandboxEngineChecks,
} from "./describe-engine-tests.js";

/**
 * Minimal workspace-backed engine. It honors the launch profile's
 * `envAllowlist` (only those vars from `process.env` become visible to
 * `exec`), blocks workspace-escape paths (`../`, escaping `cwd`), and reads
 * and writes real files under the provisioned workspace so the suite's
 * visibility checks are exercised against genuine filesystem state.
 */
class CorrectFakeHandle implements SandboxHandle {
  private destroyed = false;

  constructor(
    private readonly env: Readonly<Record<string, string>>,
    private readonly workspaceDir: string,
  ) {}

  async exec(
    request: ExecRequest,
    onEvent: (event: ExecEvent) => void,
  ): Promise<ExecResult> {
    if (this.destroyed) throw new Error("exec after destroy");
    if (request.cwd !== undefined && request.cwd.startsWith("..")) {
      throw new Error("cwd escapes workspace");
    }
    return this.runCommand(request.command, onEvent);
  }

  private runCommand(
    command: string,
    onEvent: (event: ExecEvent) => void,
  ): ExecResult {
    if (command.startsWith("printenv ")) {
      const name = command.slice("printenv ".length).trim();
      const value = this.env[name];
      if (value === undefined) {
        onEvent({ kind: "exit", seq: 1, exitCode: 1 });
        return { exitCode: 1 };
      }
      onEvent({ kind: "stdout", seq: 1, data: `${value}\n` });
      onEvent({ kind: "exit", seq: 2, exitCode: 0 });
      return { exitCode: 0 };
    }

    if (command.startsWith("cat ")) {
      const path = command.slice("cat ".length).trim();
      if (path.startsWith("../")) {
        onEvent({ kind: "exit", seq: 1, exitCode: 1 });
        return { exitCode: 1 };
      }
      let content: string;
      try {
        content = readFileSync(join(this.workspaceDir, path), "utf8");
      } catch {
        onEvent({ kind: "exit", seq: 1, exitCode: 1 });
        return { exitCode: 1 };
      }
      onEvent({ kind: "stdout", seq: 1, data: content });
      onEvent({ kind: "exit", seq: 2, exitCode: 0 });
      return { exitCode: 0 };
    }

    if (command === "true") {
      onEvent({ kind: "exit", seq: 1, exitCode: 0 });
      return { exitCode: 0 };
    }

    if (command.includes("printf a1")) {
      onEvent({ kind: "stdout", seq: 1, data: "a1" });
      onEvent({ kind: "stderr", seq: 2, data: "b1" });
      onEvent({ kind: "stdout", seq: 3, data: "a2" });
      onEvent({ kind: "stderr", seq: 4, data: "b2" });
      onEvent({ kind: "exit", seq: 5, exitCode: 0 });
      return { exitCode: 0 };
    }

    throw new Error(`unsupported command: ${command}`);
  }

  async readFile(path: string): Promise<Buffer> {
    if (this.destroyed) throw new Error("readFile after destroy");
    if (path.startsWith("../")) {
      throw new Error("path escapes workspace");
    }
    return readFile(join(this.workspaceDir, path));
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (this.destroyed) throw new Error("writeFile after destroy");
    if (path.startsWith("../")) {
      throw new Error("path escapes workspace");
    }
    await writeFile(join(this.workspaceDir, path), content, "utf8");
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

class CorrectFakeEngine implements SandboxEngine {
  async provision(
    profile: SandboxLaunchProfile,
    workspace: string,
  ): Promise<SandboxHandle> {
    const env: Record<string, string> = {};
    for (const name of profile.envAllowlist) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return new CorrectFakeHandle(env, workspace);
  }
}

/**
 * Deliberately leaks the canary env var by exposing the entire parent
 * `process.env` regardless of the `envAllowlist`. Everything else matches the
 * correct fake, so only the env-filtering check should trip on it.
 */
class LeakingFakeEngine implements SandboxEngine {
  async provision(
    _profile: SandboxLaunchProfile,
    workspace: string,
  ): Promise<SandboxHandle> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) env[name] = value;
    }
    return new CorrectFakeHandle(env, workspace);
  }
}

describe("sandbox-tests self-test", () => {
  // The correct fake must pass the full conformance suite when registered as
  // a real describe block.
  describeEngineTests("correct in-memory fake", () => new CorrectFakeEngine());

  it("passes every conformance check against a correct fake", async () => {
    await expect(
      runSandboxEngineChecks(() => new CorrectFakeEngine()),
    ).resolves.toBeUndefined();
  });

  it("catches a fake that leaks the canary env var", async () => {
    await expect(
      runSandboxEngineChecks(() => new LeakingFakeEngine()),
    ).rejects.toThrow();
  });
});
