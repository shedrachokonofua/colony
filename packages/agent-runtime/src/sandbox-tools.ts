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

/** Run a command through the handle and capture stdout/stderr as one buffer. */
async function execCapture(
  handle: SandboxHandle,
  command: string,
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  } = {},
): Promise<ExecCapture> {
  const env: Record<string, string> = {};
  if (options.env) {
    for (const [name, value] of Object.entries(options.env)) {
      if (value !== undefined) env[name] = String(value);
    }
  }
  const chunks: Buffer[] = [];
  const result = await handle.exec(
    { command, cwd: options.cwd, env, timeoutMs: options.timeoutMs },
    (event) => {
      if (event.kind === "stdout" || event.kind === "stderr") {
        chunks.push(Buffer.from(event.data));
      }
    },
  );
  return { output: Buffer.concat(chunks), exitCode: result.exitCode };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function bashOperations(handle: SandboxHandle): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (signal?.aborted) throw new Error("aborted");
      const envRecord: Record<string, string> = {};
      if (env) {
        for (const [name, value] of Object.entries(env)) {
          if (value !== undefined) envRecord[name] = String(value);
        }
      }
      const result = await handle.exec(
        {
          command,
          cwd,
          env: envRecord,
          timeoutMs: timeout !== undefined ? timeout * 1000 : undefined,
        },
        (event) => {
          if (event.kind === "stdout" || event.kind === "stderr") {
            onData(Buffer.from(event.data));
          }
        },
      );
      return { exitCode: result.exitCode };
    },
  };
}

function readOperations(handle: SandboxHandle): ReadOperations {
  return {
    readFile: (absolutePath) => handle.readFile(absolutePath),
    access: async (absolutePath) => {
      const { exitCode } = await execCapture(
        handle,
        `test -r ${shellQuote(absolutePath)}`,
      );
      if (exitCode !== 0) {
        throw new Error(`not readable: ${absolutePath}`);
      }
    },
  };
}

function writeOperations(handle: SandboxHandle): WriteOperations {
  return {
    writeFile: (absolutePath, content) =>
      handle.writeFile(absolutePath, content),
    mkdir: async (dir) => {
      const { exitCode } = await execCapture(
        handle,
        `mkdir -p ${shellQuote(dir)}`,
      );
      if (exitCode !== 0) {
        throw new Error(`cannot create directory: ${dir}`);
      }
    },
  };
}

function editOperations(handle: SandboxHandle): EditOperations {
  return {
    readFile: (absolutePath) => handle.readFile(absolutePath),
    writeFile: (absolutePath, content) =>
      handle.writeFile(absolutePath, content),
    access: async (absolutePath) => {
      const { exitCode } = await execCapture(
        handle,
        `test -w ${shellQuote(absolutePath)}`,
      );
      if (exitCode !== 0) {
        throw new Error(`not writable: ${absolutePath}`);
      }
    },
  };
}

function findOperations(handle: SandboxHandle): FindOperations {
  return {
    exists: async (absolutePath) => {
      const { exitCode } = await execCapture(
        handle,
        `test -e ${shellQuote(absolutePath)}`,
      );
      return exitCode === 0;
    },
    glob: async (pattern, searchPath, { limit }) => {
      const { output, exitCode } = await execCapture(
        handle,
        `find ${shellQuote(searchPath)} -type f`,
      );
      if (exitCode !== 0) return [];
      const matcher = globToRegExp(pattern);
      const matched: string[] = [];
      for (const line of output.toString("utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const relative = trimmed
          .slice(searchPath.length)
          .replace(/^[/\\]+/, "");
        if (!matcher.test(relative)) continue;
        matched.push(trimmed);
        if (matched.length >= limit) break;
      }
      return matched;
    },
  };
}

function grepOperations(handle: SandboxHandle): GrepOperations {
  return {
    isDirectory: async (absolutePath) => {
      const { exitCode } = await execCapture(
        handle,
        `test -d ${shellQuote(absolutePath)}`,
      );
      return exitCode === 0;
    },
    readFile: async (absolutePath) => {
      const { output } = await execCapture(
        handle,
        `cat ${shellQuote(absolutePath)}`,
      );
      return output.toString("utf8");
    },
  };
}

function lsOperations(handle: SandboxHandle): LsOperations {
  return {
    exists: async (absolutePath) => {
      const { exitCode } = await execCapture(
        handle,
        `test -e ${shellQuote(absolutePath)}`,
      );
      return exitCode === 0;
    },
    stat: async (absolutePath) => {
      const { exitCode } = await execCapture(
        handle,
        `test -d ${shellQuote(absolutePath)}`,
      );
      return { isDirectory: () => exitCode === 0 };
    },
    readdir: async (absolutePath) => {
      const { output, exitCode } = await execCapture(
        handle,
        `ls -1 ${shellQuote(absolutePath)}`,
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
 * created with pi-coding-agent's standard `cwd` (the agent's workspace) and
 * the sandbox-delegating operations above, so parameter schemas and rendering
 * are preserved exactly while execution routes through `handle`.
 */
export function buildSandboxBaseTools(
  handle: SandboxHandle,
  cwd: string,
): SandboxBaseTools {
  return {
    bash: createBashTool(cwd, { operations: bashOperations(handle) }),
    read: createReadTool(cwd, { operations: readOperations(handle) }),
    write: createWriteTool(cwd, { operations: writeOperations(handle) }),
    edit: createEditTool(cwd, { operations: editOperations(handle) }),
    find: createFindTool(cwd, { operations: findOperations(handle) }),
    grep: createGrepTool(cwd, { operations: grepOperations(handle) }),
    ls: createLsTool(cwd, { operations: lsOperations(handle) }),
  };
}
