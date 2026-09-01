import path from "node:path";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import {
  createBashTool,
  createFindTool,
  createLsTool,
  type BashOperations,
  type FindOperations,
  type LsOperations,
} from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { DEFAULT_EXEC_TIMEOUT_MS, type SandboxHandle } from "@colony/sandbox";
import type { RunAuditSink } from "./audit-sink.js";
import { redactText } from "./redact.js";
import type { PiRunnerLogger } from "./pi-runner-common.js";

/**
 * Sandbox-delegated tools for agent runs. `bash`, `find`, and `ls` keep the SDK's
 * canonical schemas and rendering with their `operations` seam routed through a
 * provisioned `SandboxHandle` instead of the local filesystem/child_process.
 *
 * `read`, `grep`, `write`, and `edit` are Colony's own. The SDK exposes no seam
 * for them — its read tool has none, and grep/write/edit reject one outright
 * because they touch the local filesystem natively. Shipping those versions
 * would let a run read and write the daemon's own disk, so Colony defines them
 * against the handle.
 *
 * The handle contract (packages/sandbox/src/exec-protocol.ts) requires
 * workspace-relative paths — absolute paths are rejected by the in-process
 * engine. The SDK hands every operation an absolute path resolved from the
 * tool's `cwd` (the run workspace), so each operation translates back to a
 * workspace-relative path first. Paths outside the workspace relativize to
 * `../...` and are rejected by the engine, which is exactly the boundary we
 * want.
 */

/** Cap on bytes returned by Colony's own read/grep tools. */
const MAX_TOOL_OUTPUT_BYTES = 128 * 1024;

/**
 * Raw captured exec output: per-stream byte counts plus the arrival-ordered
 * chunk list, so the combined buffer and the ledger tail reproduce the
 * interleaving the run actually saw (stderr before later stdout stays first).
 */
interface ExecCapture {
  readonly output: Buffer;
  readonly exitCode: number | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

/** ANSI escape / control sequences, stripped from the ledger tail. */
const ANSI_PATTERN =
  /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B[PX^_].*?\u001B\\|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Only the human-readable tail and strings in the ledger are redacted. */
const LEDGER_TAIL_CHARS = 1000;

/**
 * Relativize an absolute path against the run workspace so the handle resolves
 * it inside its own scratch root. `"."` represents the workspace root.
 */
function toWorkspaceRelative(base: string, absolutePath: string): string {
  const rel = path.relative(base, absolutePath);
  return rel === "" ? "." : rel;
}

/** Run a command through the handle and capture stdout/stderr plus byte counts. */
async function execCapture(
  handle: SandboxHandle,
  command: string,
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly execOptions?: {
      ledger?: ExecLedger;
      secrets?: readonly string[];
    };
  } = {},
): Promise<ExecCapture> {
  const chunks: { kind: "stdout" | "stderr"; buffer: Buffer }[] = [];
  const startedAt = Date.now();
  try {
    const output = await runWithSignal(
      handle,
      {
        command,
        cwd: options.cwd,
        env: toEnvRecord(options.env),
        timeoutMs: options.timeoutMs,
      },
      options.signal,
      (data, kind) => {
        chunks.push({ kind, buffer: Buffer.from(data) });
      },
    );
    const stdout = Buffer.concat(
      chunks.filter((c) => c.kind === "stdout").map((c) => c.buffer),
    );
    const stderr = Buffer.concat(
      chunks.filter((c) => c.kind === "stderr").map((c) => c.buffer),
    );
    emitLedger(
      options.execOptions,
      command,
      options.cwd,
      output.exitCode,
      Date.now() - startedAt,
      chunks,
    );
    return {
      output: Buffer.concat(chunks.map((c) => c.buffer)),
      exitCode: output.exitCode,
      stdoutBytes: stdout.byteLength,
      stderrBytes: stderr.byteLength,
    };
  } catch (err) {
    // Abort paths (pre-aborted signal, mid-exec cancel) leave no completed
    // exec to capture; anything else is a real failure and propagates.
    if (err instanceof Error && err.message === "aborted") {
      return {
        output: Buffer.alloc(0),
        exitCode: null,
        stdoutBytes: 0,
        stderrBytes: 0,
      };
    }
    throw err;
  }
}

/**
 * Last `LEDGER_TAIL_CHARS` chars of the arrival-ordered combined output,
 * ANSI-stripped and redacted. Byte counts above are the raw captured lengths;
 * only this human-readable tail is cleaned.
 */
function outputTail(
  chunks: readonly { kind: "stdout" | "stderr"; buffer: Buffer }[],
  secrets: readonly string[],
): string {
  const combined = stripAnsi(
    chunks.map((chunk) => chunk.buffer.toString("utf8")).join(""),
  );
  return redactText(combined.slice(-LEDGER_TAIL_CHARS), secrets);
}

function stripAnsi(text: string): string {
  return text.replaceAll(ANSI_PATTERN, "");
}

/** One `command` run event per sandbox exec, emitted at the exec boundary. */
interface ExecLedger {
  readonly command: (detail: {
    command: string;
    cwd: string | undefined;
    exit_code: number | null;
    duration_ms: number;
    stdout_bytes: number;
    stderr_bytes: number;
    truncated_tail: string;
  }) => void;
}

/**
 * Emit the exec's ledger entry: best-effort by construction (the sink's
 * appendEvent already swallows throws) and redacted for persistence.
 */
function emitLedger(
  execOptions: { ledger?: ExecLedger; secrets?: readonly string[] } | undefined,
  command: string,
  cwd: string | undefined,
  exitCode: number | null,
  durationMs: number,
  chunks: readonly { kind: "stdout" | "stderr"; buffer: Buffer }[],
): void {
  const secrets = execOptions?.secrets ?? [];
  execOptions?.ledger?.command({
    command: redactText(command, secrets),
    cwd: cwd === undefined ? undefined : redactText(cwd, secrets),
    exit_code: exitCode,
    duration_ms: durationMs,
    stdout_bytes: chunks
      .filter((chunk) => chunk.kind === "stdout")
      .reduce((total, chunk) => total + chunk.buffer.byteLength, 0),
    stderr_bytes: chunks
      .filter((chunk) => chunk.kind === "stderr")
      .reduce((total, chunk) => total + chunk.buffer.byteLength, 0),
    truncated_tail: outputTail(chunks, secrets),
  });
}

function toEnvRecord(
  env: NodeJS.ProcessEnv | undefined,
): Record<string, string> {
  // TMPDIR-honoring temp files (mktemp, os.tmpdir(), test scratch DBs) go to
  // the kata guest's tmpfs: fsync through the VM block layer is the sandbox's
  // one pathological cost (measured 88x on the SQLite-heavy store suite,
  // 2026-08-30). Explicit /tmp/... paths are unaffected and stay on disk;
  // callers may still override TMPDIR per exec.
  const record: Record<string, string> = { TMPDIR: "/dev/shm" };
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
  onData: (data: string, kind: "stdout" | "stderr") => void,
): Promise<{ exitCode: number | null; timedOut?: boolean }> {
  if (signal?.aborted) {
    return Promise.reject(new Error("aborted"));
  }
  const exec = () =>
    handle.exec(request, (event) => {
      if (event.kind === "stdout" || event.kind === "stderr") {
        onData(event.data, event.kind);
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

function bashOperations(
  handle: SandboxHandle,
  base: string,
  execOptions: { ledger?: ExecLedger; secrets?: readonly string[] },
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const chunks: { kind: "stdout" | "stderr"; buffer: Buffer }[] = [];
      const startedAt = Date.now();
      const result = await runWithSignal(
        handle,
        {
          command,
          cwd: toWorkspaceRelative(base, cwd),
          env: toEnvRecord(env),
          timeoutMs: timeout !== undefined ? timeout * 1000 : undefined,
        },
        signal,
        (data, kind) => {
          const buffer = Buffer.from(data);
          chunks.push({ kind, buffer });
          onData(buffer);
        },
      );
      emitLedger(
        execOptions,
        command,
        toWorkspaceRelative(base, cwd),
        result.exitCode,
        Date.now() - startedAt,
        chunks,
      );
      if (result.timedOut) {
        // The shim's `timeout:<seconds>` contract renders as "Command timed
        // out after N seconds" - an actionable tool error the agent can react
        // to (rerun with an explicit longer timeout) instead of the shim's
        // exitCode-null path, which it would report as success.
        const seconds = timeout ?? Math.round(DEFAULT_EXEC_TIMEOUT_MS / 1000);
        throw new Error(`timeout:${seconds}`);
      }
      return { exitCode: result.exitCode };
    },
  };
}

/**
 * Colony's `read`: line-addressable file read executed inside the sandbox.
 * Mirrors the SDK tool's shape (path plus optional window) because the role
 * prompts tell agents to read before editing.
 */
function sandboxReadTool(
  handle: SandboxHandle,
  base: string,
  execOptions: { ledger?: ExecLedger; secrets?: readonly string[] },
): ToolDefinition {
  const parameters = Type.Object(
    {
      path: Type.String({
        description: "Workspace-relative path to read.",
      }),
      offset: Type.Optional(
        Type.Integer({ minimum: 1, description: "First line, 1-indexed." }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, description: "Maximum lines to return." }),
      ),
    },
    { additionalProperties: false },
  );
  return {
    name: "read",
    label: "Read file",
    description:
      "Read a file from the run workspace. Returns numbered lines; use offset/limit for a window instead of reading huge files whole.",
    parameters,
    approval: "read",
    execute: async (_toolCallId, rawParams) => {
      // The SDK validates against `parameters` before calling execute; this cast
      // just names the validated shape.
      const params = rawParams as {
        path: string;
        offset?: number;
        limit?: number;
      };
      const relative = toWorkspaceRelative(
        base,
        path.resolve(base, params.path),
      );
      const buffer = await handle.readFile(relative);
      const text = buffer.subarray(0, MAX_TOOL_OUTPUT_BYTES).toString("utf8");
      const lines = text.split("\n");
      const start = (params.offset ?? 1) - 1;
      const end =
        params.limit === undefined ? lines.length : start + params.limit;
      const window = lines.slice(start, end);
      const numbered = window
        .map((line, index) => `${start + index + 1}:${line}`)
        .join("\n");
      const truncated =
        buffer.byteLength > MAX_TOOL_OUTPUT_BYTES || end < lines.length;
      return {
        content: [
          {
            type: "text" as const,
            text: truncated ? `${numbered}\n… truncated` : numbered,
          },
        ],
        details: { path: params.path, lines: window.length, truncated },
      };
    },
  };
}

/**
 * Colony's `write`: create or overwrite a workspace file inside the sandbox.
 * The SDK's write tool rejects an operations seam outright ("writes the local
 * filesystem natively"), so a sandboxed run needs Colony's own.
 */
function sandboxWriteTool(
  handle: SandboxHandle,
  base: string,
  execOptions: { ledger?: ExecLedger; secrets?: readonly string[] },
): ToolDefinition {
  const parameters = Type.Object(
    {
      path: Type.String({ description: "Workspace-relative path to write." }),
      content: Type.String({ description: "Full file content." }),
    },
    { additionalProperties: false },
  );
  return {
    name: "write",
    label: "Write file",
    description:
      "Create or overwrite a file in the run workspace with the exact content given.",
    parameters,
    approval: "write",
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { path: string; content: string };
      const relative = toWorkspaceRelative(
        base,
        path.resolve(base, params.path),
      );
      const parent = path.posix.dirname(relative);
      if (parent && parent !== "." && parent !== "/") {
        const { exitCode } = await execCapture(
          handle,
          `mkdir -p ${shellQuote(parent)}`,
          { execOptions },
        );
        if (exitCode !== 0) {
          throw new Error(`cannot create directory: ${parent}`);
        }
      }
      await handle.writeFile(relative, params.content);
      return {
        content: [
          {
            type: "text" as const,
            text: `wrote ${params.path} (${Buffer.byteLength(params.content)} bytes)`,
          },
        ],
        details: {
          path: params.path,
          bytes: Buffer.byteLength(params.content),
        },
      };
    },
  };
}

/**
 * Colony's `edit`: exact-string replacements inside a workspace file. Each
 * `oldText` must appear exactly once, so an ambiguous edit fails loudly instead
 * of silently patching the wrong occurrence.
 */
function sandboxEditTool(
  handle: SandboxHandle,
  base: string,
  execOptions: { ledger?: ExecLedger; secrets?: readonly string[] },
): ToolDefinition {
  const parameters = Type.Object(
    {
      path: Type.String({ description: "Workspace-relative path to edit." }),
      edits: Type.Array(
        Type.Object(
          {
            oldText: Type.String({ minLength: 1 }),
            newText: Type.String(),
          },
          { additionalProperties: false },
        ),
        { minItems: 1 },
      ),
    },
    { additionalProperties: false },
  );
  return {
    name: "edit",
    label: "Edit file",
    description:
      "Replace exact strings in a workspace file. Every oldText must occur exactly once in the file.",
    parameters,
    approval: "write",
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        path: string;
        edits: ReadonlyArray<{ oldText: string; newText: string }>;
      };
      const relative = toWorkspaceRelative(
        base,
        path.resolve(base, params.path),
      );
      const before = (await handle.readFile(relative)).toString("utf8");
      let after = before;
      for (const edit of params.edits) {
        const occurrences = after.split(edit.oldText).length - 1;
        if (occurrences === 0) {
          throw new Error(
            `edit rejected: oldText not found in ${params.path}: ${edit.oldText.slice(0, 80)}`,
          );
        }
        if (occurrences > 1) {
          throw new Error(
            `edit rejected: oldText occurs ${occurrences} times in ${params.path}; include more surrounding context to make it unique`,
          );
        }
        after = after.replace(edit.oldText, edit.newText);
      }
      await handle.writeFile(relative, after);
      return {
        content: [
          {
            type: "text" as const,
            text: `applied ${params.edits.length} edit(s) to ${params.path}`,
          },
        ],
        details: { path: params.path, edits: params.edits.length },
      };
    },
  };
}

function findOperations(
  handle: SandboxHandle,
  base: string,
  execOptions: { ledger?: ExecLedger; secrets?: readonly string[] },
): FindOperations {
  const rel = (p: string) => toWorkspaceRelative(base, p);
  return {
    exists: async (absolutePath) => {
      const { exitCode } = await execCapture(
        handle,
        `test -e ${shellQuote(rel(absolutePath))}`,
        { execOptions },
      );
      return exitCode === 0;
    },
    glob: async (pattern, searchPath, { limit }) => {
      const relSearch = rel(searchPath);
      const { output, exitCode } = await execCapture(
        handle,
        `find ${shellQuote(relSearch)} -type f`,
        { execOptions },
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

/**
 * Colony's `grep`: pattern search executed inside the sandbox. The SDK's grep
 * runs ripgrep on the local filesystem with no seam to redirect, so Colony runs
 * the search in the workspace instead.
 */
function sandboxGrepTool(
  handle: SandboxHandle,
  base: string,
  execOptions: { ledger?: ExecLedger; secrets?: readonly string[] },
): ToolDefinition {
  const parameters = Type.Object(
    {
      pattern: Type.String({ description: "Extended regular expression." }),
      path: Type.Optional(
        Type.String({
          description:
            "Workspace-relative file or directory. Defaults to the workspace root.",
        }),
      ),
      case_sensitive: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  );
  return {
    name: "grep",
    label: "Search workspace",
    description:
      "Search the run workspace for a regular expression. Returns file:line:text matches from inside the sandbox.",
    parameters,
    approval: "read",
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        pattern: string;
        path?: string;
        case_sensitive?: boolean;
      };
      const target = toWorkspaceRelative(
        base,
        path.resolve(base, params.path ?? "."),
      );
      const flags = params.case_sensitive === false ? "-rInE" : "-rnIE";
      const { output, exitCode } = await execCapture(
        handle,
        `grep ${flags} -- ${shellQuote(params.pattern)} ${shellQuote(target)} || true`,
        { execOptions },
      );
      const text = output.subarray(0, MAX_TOOL_OUTPUT_BYTES).toString("utf8");
      const matches = text.split("\n").filter((line) => line.length > 0);
      return {
        content: [
          {
            type: "text" as const,
            text: matches.length ? matches.join("\n") : "no matches",
          },
        ],
        details: {
          matchCount: matches.length,
          truncated: output.byteLength > MAX_TOOL_OUTPUT_BYTES,
          exitCode,
        },
      };
    },
  };
}

function lsOperations(
  handle: SandboxHandle,
  base: string,
  execOptions: { ledger?: ExecLedger; secrets?: readonly string[] },
): LsOperations {
  const rel = (p: string) => toWorkspaceRelative(base, p);
  return {
    exists: async (absolutePath) => {
      const { exitCode } = await execCapture(
        handle,
        `test -e ${shellQuote(rel(absolutePath))}`,
        { execOptions },
      );
      return exitCode === 0;
    },
    stat: async (absolutePath) => {
      const { exitCode } = await execCapture(
        handle,
        `test -d ${shellQuote(rel(absolutePath))}`,
        { execOptions },
      );
      return { isDirectory: () => exitCode === 0 };
    },
    readdir: async (absolutePath) => {
      const { output, exitCode } = await execCapture(
        handle,
        `ls -1 ${shellQuote(rel(absolutePath))}`,
        { execOptions },
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
 * Every tool a sandboxed run may call, ready to hand to `createAgentSession` as
 * `customTools` under `restrictToolNames`. The SDK-backed tools keep their
 * canonical schemas via the `operations` seam; `read` and `grep` are Colony's,
 * because the SDK offers no seam for them.
 *
 * `audit` receives one `command` run event per exec regardless of which tool
 * triggered it (independent of SDK tool semantics); `runToken` is redacted
 * from the ledger alongside the well-known token patterns, and sink failures
 * are logged via `logger` (best-effort: never into the run path).
 */
export function buildSandboxTools(
  handle: SandboxHandle,
  cwd: string,
  audit?: {
    readonly auditSink?: RunAuditSink;
    readonly runId?: string;
    readonly runToken?: string;
    readonly logger?: PiRunnerLogger;
  },
): readonly ToolDefinition[] {
  const ledger: ExecLedger | undefined =
    audit?.auditSink && audit.runId
      ? {
          command: (detail) => {
            try {
              audit.auditSink!.appendEvent(audit.runId!, "command", detail);
            } catch (err) {
              // The ledger must never break an exec; say why it went missing.
              audit.logger?.warn?.(
                {
                  runId: audit.runId,
                  event: "command",
                  error: err instanceof Error ? err.message : String(err),
                },
                "sandbox_ledger_append_event_failed",
              );
            }
          },
        }
      : undefined;
  const secrets = audit?.runToken ? [audit.runToken] : [];
  const execOptions = { ledger, secrets };
  return [
    createBashTool(cwd, {
      operations: bashOperations(handle, cwd, execOptions),
    }),
    createFindTool(cwd, {
      operations: findOperations(handle, cwd, execOptions),
    }),
    createLsTool(cwd, { operations: lsOperations(handle, cwd, execOptions) }),
    sandboxReadTool(handle, cwd, execOptions),
    sandboxGrepTool(handle, cwd, execOptions),
    sandboxWriteTool(handle, cwd, execOptions),
    sandboxEditTool(handle, cwd, execOptions),
  ];
}

/**
 * Is `headSha` what `origin/<branch>` points at, as seen from inside the
 * sandbox? Used by the implementer's submit gate: three implementers on
 * 2026-09-01 submitted envelopes naming commits that were never pushed
 * (one SHA visibly synthetic); colonyd's fact check caught each, but only
 * after the run had ended and its attempt was burned. Checking in-session
 * turns that into a tool error the model can still act on.
 *
 * `undefined` means the check could not run (no network, no remote); the
 * caller must not block on that - colonyd still verifies after the run.
 */
export async function verifyPushedHead(
  handle: SandboxHandle,
  branch: string,
  headSha: string,
): Promise<{ ok: boolean; remoteHead: string | null } | undefined> {
  if (!/^[A-Za-z0-9._\/-]+$/.test(branch))
    return { ok: false, remoteHead: null };
  const capture = await execCapture(
    handle,
    `git ls-remote --heads origin ${JSON.stringify(branch)}`,
    { cwd: ".", timeoutMs: 30_000 },
  );
  if (capture.exitCode !== 0) return undefined;
  const line = capture.output
    .toString("utf8")
    .split("\n")
    .find((row) => row.trim().endsWith(`refs/heads/${branch}`));
  const remoteHead = line ? (line.split(/\s+/)[0] ?? null) : null;
  return { ok: remoteHead === headSha, remoteHead };
}
