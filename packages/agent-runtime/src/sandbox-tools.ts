import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type EditOperations,
  type FindOperations,
  type GrepOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { SandboxHandle } from "@colony/sandbox";

/**
 * Sandbox-delegated base tools for pi runs. Each tool keeps pi-coding-agent's
 * canonical parameter schema and rendering, but its `operations` override
 * routes every underlying bash/file call through a provisioned `SandboxHandle`
 * instead of the local filesystem/child_process. This is what makes agent tool
 * execution actually run through the sandbox (env filtering included) while
 * leaving pi-model-fallback's default local tools untouched when no engine is
 * configured.
 *
 * The sandbox handle contract (packages/sandbox/src/exec-protocol.ts) requires
 * workspace-relative paths — absolute paths are rejected by the in-process
 * engine. pi-coding-agent hands every operation an absolute path resolved from
 * the tool's `cwd` (the run workspace), so each operation translates its
 * argument back to a workspace-relative path before calling into the handle.
 * Paths outside the workspace relativize to `../...` and are rejected by the
 * engine, which is exactly the sandbox boundary we want.
 */

/**
 * Base tools each role may expose. Only the tools registered in a profile's
 * `defaultTools`/`tools` are actually handed to the agent; this override map
 * is keyed by tool name so `createAgentSession` can substitute them.
 */
export type SandboxBaseTools = Record<string, AgentTool>;

interface ExecCapture {
  readonly output: Buffer;
  readonly exitCode: number | null;
}

/**
 * Relativize an absolute path against the run workspace so the handle resolves
 * it inside its own scratch root. `"."` represents the workspace root.
 */
function toWorkspaceRelative(base: string, absolutePath: string): string {
  const rel = path.relative(base, absolutePath);
  return rel === "" ? "." : rel;
}

/** Run a command through the handle and capture stdout/stderr as one buffer. */
async function execCapture(
  handle: SandboxHandle,
  command: string,
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<ExecCapture> {
  const chunks: Buffer[] = [];
  const output = await runWithSignal(
    handle,
    {
      command,
      cwd: options.cwd,
      env: toEnvRecord(options.env),
      timeoutMs: options.timeoutMs,
    },
    options.signal,
    (data) => chunks.push(Buffer.from(data)),
  );
  return { output: Buffer.concat(chunks), exitCode: output.exitCode };
}

function toEnvRecord(
  env: NodeJS.ProcessEnv | undefined,
): Record<string, string> {
  const record: Record<string, string> = {};
  if (env) {
    for (const [name, value] of Object.entries(env)) {
      if (value !== undefined) record[name] = String(value);
    }
  }
  return record;
}

/**
 * Execute a command through the handle, watching the caller's AbortSignal so a
 * mid-exec abort (run timeout, cancellation) surfaces promptly as a thrown
 * error instead of blocking the tool turn until the engine-side timeoutMs.
 */
function runWithSignal(
  handle: SandboxHandle,
  request: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  },
  signal: AbortSignal | undefined,
  onData: (data: string) => void,
): Promise<{ exitCode: number | null }> {
  if (signal?.aborted) {
    return Promise.reject(new Error("aborted"));
  }
  const exec = () =>
    handle.exec(request, (event) => {
      if (event.kind === "stdout" || event.kind === "stderr") {
        onData(event.data);
      }
    });
  if (!signal) return exec();

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    exec().then(
      (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      },
      (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      },
    );
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function bashOperations(handle: SandboxHandle, base: string): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const result = await runWithSignal(
        handle,
        {
          command,
          cwd: toWorkspaceRelative(base, cwd),
          env: toEnvRecord(env),
          timeoutMs: timeout !== undefined ? timeout * 1000 : undefined,
        },
        signal,
        (data) => onData(Buffer.from(data)),
      );
      return { exitCode: result.exitCode };
    },
  };
}

function readOperations(handle: SandboxHandle, base: string): ReadOperations {
  const rel = (p: string) => toWorkspaceRelative(base, p);
  return {
    readFile: (absolutePath) => handle.readFile(rel(absolutePath)),
    access: async (absolutePath) => {
      const { exitCode } = await execCapture(
        handle,
        `test -r ${shellQuote(rel(absolutePath))}`,
      );
      if (exitCode !== 0) {
        throw new Error(`not readable: ${absolutePath}`);
      }
    },
  };
}

function writeOperations(handle: SandboxHandle, base: string): WriteOperations {
  const rel = (p: string) => toWorkspaceRelative(base, p);
  return {
    writeFile: (absolutePath, content) =>
      handle.writeFile(rel(absolutePath), content),
    mkdir: async (dir) => {
      const { exitCode } = await execCapture(
        handle,
        `mkdir -p ${shellQuote(rel(dir))}`,
      );
      if (exitCode !== 0) {
        throw new Error(`cannot create directory: ${dir}`);
      }
    },
  };
}

function editOperations(handle: SandboxHandle, base: string): EditOperations {
  const rel = (p: string) => toWorkspaceRelative(base, p);
  return {
    readFile: (absolutePath) => handle.readFile(rel(absolutePath)),
    writeFile: (absolutePath, content) =>
      handle.writeFile(rel(absolutePath), content),
    access: async (absolutePath) => {
      const { exitCode } = await execCapture(
        handle,
        `test -w ${shellQuote(rel(absolutePath))}`,
      );
      if (exitCode !== 0) {
        throw new Error(`not writable: ${absolutePath}`);
      }
    },
  };
}

function findOperations(handle: SandboxHandle, base: string): FindOperations {
  const rel = (p: string) => toWorkspaceRelative(base, p);
  return {
    exists: async (absolutePath) => {
      const { exitCode } = await execCapture(
        handle,
        `test -e ${shellQuote(rel(absolutePath))}`,
      );
      return exitCode === 0;
    },
    glob: async (pattern, searchPath, { limit }) => {
      const relSearch = rel(searchPath);
      const { output, exitCode } = await execCapture(
        handle,
        `find ${shellQuote(relSearch)} -type f`,
      );
      if (exitCode !== 0) return [];
      const matcher = globToRegExp(pattern);
      const matched: string[] = [];
      for (const line of output.toString("utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const relative = trimmed
          .slice(relSearch.length === 1 ? 1 : relSearch.length)
          .replace(/^[/\\]+/, "");
        if (!matcher.test(relative)) continue;
        matched.push(trimmed);
        if (matched.length >= limit) break;
      }
      return matched;
    },
  };
}

function grepOperations(handle: SandboxHandle, base: string): GrepOperations {
  const rel = (p: string) => toWorkspaceRelative(base, p);
  return {
    isDirectory: async (absolutePath) => {
      const { exitCode } = await execCapture(
        handle,
        `test -d ${shellQuote(rel(absolutePath))}`,
      );
      return exitCode === 0;
    },
    readFile: async (absolutePath) => {
      const buffer = await handle.readFile(rel(absolutePath));
      return buffer.toString("utf8");
    },
  };
}

function lsOperations(handle: SandboxHandle, base: string): LsOperations {
  const rel = (p: string) => toWorkspaceRelative(base, p);
  return {
    exists: async (absolutePath) => {
      const { exitCode } = await execCapture(
        handle,
        `test -e ${shellQuote(rel(absolutePath))}`,
      );
      return exitCode === 0;
    },
    stat: async (absolutePath) => {
      const { exitCode } = await execCapture(
        handle,
        `test -d ${shellQuote(rel(absolutePath))}`,
      );
      return { isDirectory: () => exitCode === 0 };
    },
    readdir: async (absolutePath) => {
      const { output, exitCode } = await execCapture(
        handle,
        `ls -1 ${shellQuote(rel(absolutePath))}`,
      );
      if (exitCode !== 0) {
        throw new Error(`cannot read directory: ${absolutePath}`);
      }
      return output
        .toString("utf8")
        .split("\n")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    },
  };
}

/** Minimal glob matcher supporting `**`, `*`, and `?` (path separators respected). */
function globToRegExp(glob: string): RegExp {
  let source = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (
      char === "." ||
      char === "[" ||
      char === "]" ||
      char === "(" ||
      char === ")" ||
      char === "{" ||
      char === "}" ||
      char === "+" ||
      char === "^" ||
      char === "$" ||
      char === "|" ||
      char === "\\"
    ) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  source += "$";
  return new RegExp(source);
}

/**
 * Build the `baseToolsOverride` map for `createAgentSession`. Every tool is
 * created with pi-coding-agent's standard `cwd` (the run workspace) and the
 * sandbox-delegating operations above, so parameter schemas and rendering are
 * preserved exactly while execution routes through `handle`.
 */
export function buildSandboxBaseTools(
  handle: SandboxHandle,
  cwd: string,
): SandboxBaseTools {
  return {
    bash: createBashTool(cwd, { operations: bashOperations(handle, cwd) }),
    read: createReadTool(cwd, { operations: readOperations(handle, cwd) }),
    write: createWriteTool(cwd, { operations: writeOperations(handle, cwd) }),
    edit: createEditTool(cwd, { operations: editOperations(handle, cwd) }),
    find: createFindTool(cwd, { operations: findOperations(handle, cwd) }),
    grep: createGrepTool(cwd, { operations: grepOperations(handle, cwd) }),
    ls: createLsTool(cwd, { operations: lsOperations(handle, cwd) }),
  };
}
