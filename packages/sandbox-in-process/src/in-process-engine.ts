import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  buildIsolatedCommandEnv,
  DEFAULT_EXEC_TIMEOUT_MS,
  type ExecEvent,
  ExecRequestSchema,
  type ExecRequest,
  type ExecResult,
  type SandboxEngine,
  type SandboxHandle,
  type SandboxLaunchProfile,
} from "@colony/sandbox";

/**
 * In-process sandbox engine: today's execution mode formalized behind the
 * `SandboxEngine` contract. Each handle is rooted at the run's *workspace*
 * (the prepared repo clone) — exec cwd, readFile, and writeFile all resolve
 * workspace-relative paths there. A separate per-handle scratch directory
 * under the OS tmpdir backs HOME/TMPDIR so temp junk never lands inside the
 * repo; only that scratch dir is removed on destroy. The workspace belongs
 * to the runner, which provisions and cleans it.
 *
 * The scratch dir MUST live outside the workspace: anything inside the clone
 * shows up as untracked noise that agents legitimately clean up (`git clean`,
 * `rm -rf`), and deleting the exec cwd out from under the handle breaks every
 * subsequent spawn with ENOENT.
 */

class InProcessSandboxHandle implements SandboxHandle {
  private destroyed = false;

  constructor(
    readonly sandboxId: string,
    private readonly workspaceDir: string,
    private readonly scratchDir: string,
    private readonly envAllowlist: readonly string[],
  ) {}

  async exec(
    request: ExecRequest,
    onEvent: (event: ExecEvent) => void,
  ): Promise<ExecResult> {
    if (this.destroyed) {
      throw new Error("exec after destroy");
    }
    // The wire contract owns cwd semantics (workspace-relative); parsing
    // here rejects host-absolute paths instead of silently using them.
    return this.runCommand(ExecRequestSchema.parse(request), onEvent);
  }

  async readFile(path: string): Promise<Buffer> {
    if (this.destroyed) throw new Error("readFile after destroy");
    return readFile(this.resolveWithinWorkspace(path));
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (this.destroyed) throw new Error("writeFile after destroy");
    await writeFile(this.resolveWithinWorkspace(path), content, "utf8");
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    sandboxRegistry.delete(this.sandboxId);
    await rm(this.scratchDir, { recursive: true, force: true });
  }

  /** Resolves a relative path under the workspace, rejecting escapes. */
  private resolveWithinWorkspace(path: string): string {
    if (path.startsWith("/") || isAbsoluteWindowsPath(path)) {
      throw new Error("absolute paths are not allowed in the sandbox");
    }
    const resolved = resolve(this.workspaceDir, path);
    if (
      resolved !== this.workspaceDir &&
      !resolved.startsWith(`${this.workspaceDir}${sep}`)
    ) {
      throw new Error("path escapes the sandbox workspace");
    }
    return resolved;
  }

  private runCommand(
    request: ExecRequest,
    onEvent: (event: ExecEvent) => void,
  ): Promise<ExecResult> {
    const {
      promise,
      resolve: resolveResult,
      reject,
    } = Promise.withResolvers<ExecResult>();
    const cwd = this.resolveExecCwd(request);
    // detached:true puts the shell (and everything it spawns) in its own
    // process group so a timeout can kill the entire tree, not just the
    // shell, via `process.kill(-child.pid, ...)`.
    // In containerized engines (k8s), the workspace is mounted at /workspace.
    // In the in-process engine, commands referencing /workspace (such as the
    // boot adoption liveness probe `test -e /workspace`) map to the handle's
    // actual workspaceDir so they behave identically across host substrates.
    const command = request.command.replace(
      /(^|\s)\/workspace(\b|$)/g,
      `$1'${this.workspaceDir}'$2`,
    );
    const child = spawn(command, {
      cwd,
      env: buildIsolatedCommandEnv(
        this.envAllowlist,
        this.scratchDir,
        process.env,
        request.env,
      ),
      shell: true,
      detached: true,
    }) as ChildProcessWithoutNullStreams;

    let seq = 0;
    let timedOut = false;
    const timeoutMs = request.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          // Negative pid signals the whole process group.
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Process group already gone.
        }
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: string | Buffer) => {
      seq += 1;
      onEvent({ kind: "stdout", seq, data: String(chunk) });
    });
    child.stderr.on("data", (chunk: string | Buffer) => {
      seq += 1;
      onEvent({ kind: "stderr", seq, data: String(chunk) });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      seq += 1;
      onEvent({ kind: "exit", seq, exitCode: code });
      resolveResult({ exitCode: code, timedOut });
    });
    return promise;
  }

  /** Resolves the exec working directory, rooting relative `cwd` in the workspace. */
  private resolveExecCwd(request: ExecRequest): string {
    if (request.cwd === undefined) return this.workspaceDir;
    return this.resolveWithinWorkspace(request.cwd);
  }
}

function isAbsoluteWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path);
}

/**
 * Module-level registry of live handles, keyed by the sandbox id each handle
 * carries. It is deliberately shared across every engine instance this module
 * creates: a daemon that rebuilds its object graph (fresh engine, same
 * process) must still be able to `connect` to a sandbox an earlier instance
 * provisioned — that is exactly the restart-adoption path.
 */
const sandboxRegistry = new Map<string, InProcessSandboxHandle>();

/** Creates a fresh in-process sandbox engine. */
export function createInProcessEngine(): SandboxEngine {
  return {
    async provision(
      profile: SandboxLaunchProfile,
      workspace: string,
    ): Promise<SandboxHandle> {
      const scratchDir = await mkdtemp(join(tmpdir(), "colony-sandbox-"));
      const handle = new InProcessSandboxHandle(
        `in-process-${randomUUID()}`,
        workspace,
        scratchDir,
        profile.envAllowlist,
      );
      sandboxRegistry.set(handle.sandboxId, handle);
      return handle;
    },
    async connect(sandboxId: string): Promise<SandboxHandle> {
      const handle = sandboxRegistry.get(sandboxId);
      if (handle === undefined) {
        throw new Error(`sandbox not found: ${sandboxId}`);
      }
      return handle;
    },
  };
}

export const inProcessEngine: SandboxEngine = createInProcessEngine();

export default createInProcessEngine;
