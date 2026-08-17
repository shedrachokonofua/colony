import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type {
  ExecEvent,
  ExecRequest,
  ExecResult,
  SandboxEngine,
  SandboxHandle,
  SandboxLaunchProfile,
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
    return this.runCommand(request, onEvent);
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
    await rm(this.scratchDir, { recursive: true, force: true });
  }

  /**
   * Builds the child env from allowlisted keys plus substrate variables.
   *
   * Rule: `envAllowlist` governs data/credential env vars only. The execution
   * substrate must always be functional, so PATH is provided unconditionally
   * from `process.env.PATH` and HOME/TMPDIR are set to the handle's scratch
   * directory — these are substrate, not data, and must not be allowlisted.
   *
   * Only allowlisted keys from process.env and allowlisted request overrides
   * are propagated as data — any process.env key absent from the allowlist is
   * invisible to the child.
   */
  private buildEnv(request: ExecRequest): NodeJS.ProcessEnv {
    const env: Record<string, string> = {};
    for (const name of this.envAllowlist) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const overrides = request.env ?? {};
    for (const [name, value] of Object.entries(overrides)) {
      if (this.envAllowlist.includes(name)) env[name] = value;
    }
    if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
    env.HOME = this.scratchDir;
    env.TMPDIR = this.scratchDir;
    return env;
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
    const child = spawn(request.command, {
      cwd,
      env: this.buildEnv(request),
      shell: true,
      detached: true,
    }) as ChildProcessWithoutNullStreams;

    let seq = 0;
    let timedOut = false;
    const timer =
      request.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            if (child.pid !== undefined) {
              try {
                // Negative pid signals the whole process group.
                process.kill(-child.pid, "SIGKILL");
              } catch {
                // Process group already gone.
              }
            }
          }, request.timeoutMs)
        : undefined;

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

/** Creates a fresh in-process sandbox engine. */
export function createInProcessEngine(): SandboxEngine {
  return {
    async provision(
      profile: SandboxLaunchProfile,
      workspace: string,
    ): Promise<SandboxHandle> {
      const scratchDir = await mkdtemp(join(tmpdir(), "colony-sandbox-"));
      return new InProcessSandboxHandle(
        workspace,
        scratchDir,
        profile.envAllowlist,
      );
    },
  };
}

export const inProcessEngine: SandboxEngine = createInProcessEngine();

export default createInProcessEngine;
