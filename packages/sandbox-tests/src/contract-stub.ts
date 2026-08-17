import { isAbsolute, normalize, sep } from "node:path";
import type {
  ExecEvent,
  ExecRequest,
  ExecResult,
  SandboxHandle,
} from "@colony/sandbox";

/**
 * A recording stub handle that ENFORCES the SandboxHandle contract instead of
 * accepting anything. Wiring tests must use this (not a permissive fake):
 * a permissive stub once green-lit tools that passed absolute paths to a
 * workspace-relative contract, which only the real engine rejected.
 *
 * Enforced invariants:
 * - readFile/writeFile paths must be workspace-relative and must not escape
 *   (`..`), mirroring the real engines' resolution rules.
 * - exec cwd, when given, must be workspace-relative and contained.
 * - exec/readFile/writeFile reject after destroy(); destroy() is idempotent.
 */
export interface ContractStubHandle extends SandboxHandle {
  readonly execs: { command: string; cwd?: string }[];
  readonly reads: string[];
  readonly writes: { path: string; content: string }[];
  readonly destroyCalls: number;
}

export interface ContractStubOptions {
  /** stdout returned for every exec (default empty). */
  readonly execStdout?: string;
  /** Content returned by readFile (default "stub file content\n"). */
  readonly fileContent?: string;
}

function assertContained(path: string, api: string): void {
  if (isAbsolute(path)) {
    throw new Error(
      `${api}: absolute path violates the workspace-relative contract: ${path}`,
    );
  }
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error(`${api}: path escapes the workspace: ${path}`);
  }
}

export function createContractStubHandle(
  options: ContractStubOptions = {},
): ContractStubHandle {
  const execs: { command: string; cwd?: string }[] = [];
  const reads: string[] = [];
  const writes: { path: string; content: string }[] = [];
  let destroyCalls = 0;
  let destroyed = false;

  const assertLive = (api: string): void => {
    if (destroyed) throw new Error(`${api} after destroy`);
  };

  return {
    execs,
    reads,
    writes,
    get destroyCalls() {
      return destroyCalls;
    },
    async exec(
      request: ExecRequest,
      onEvent: (event: ExecEvent) => void,
    ): Promise<ExecResult> {
      assertLive("exec");
      if (request.cwd !== undefined) assertContained(request.cwd, "exec cwd");
      execs.push({ command: request.command, cwd: request.cwd });
      let seq = 0;
      const stdout = options.execStdout ?? "";
      if (stdout) {
        seq += 1;
        onEvent({ kind: "stdout", seq, data: stdout });
      }
      seq += 1;
      onEvent({ kind: "exit", seq, exitCode: 0 });
      return { exitCode: 0, timedOut: false };
    },
    async readFile(path: string): Promise<Buffer> {
      assertLive("readFile");
      assertContained(path, "readFile");
      reads.push(path);
      return Buffer.from(options.fileContent ?? "stub file content\n");
    },
    async writeFile(path: string, content: string): Promise<void> {
      assertLive("writeFile");
      assertContained(path, "writeFile");
      writes.push({ path, content });
    },
    async destroy(): Promise<void> {
      destroyCalls += 1;
      destroyed = true;
    },
  };
}
