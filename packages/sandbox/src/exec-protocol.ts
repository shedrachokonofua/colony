import { z } from "zod";
import type { SandboxLaunchProfile } from "./sandbox-profile.js";

// --- Exec wire protocol ---
//
// Everything crossing the engine boundary is JSON-serializable (strings and
// numbers, never Buffers). Agents stream ordered stdout/stderr through
// `ExecEvent`s carrying a monotonic `seq` so the consumer can reconstruct the
// original stream ordering across a channel that may reorder payloads.

export const ExecRequestSchema = z.object({
  command: z.string(),
  /**
   * WORKSPACE-RELATIVE working directory; omitted = workspace root. Host
   * paths are meaningless inside an engine, so absolute paths are rejected
   * at the contract, not per-engine (a host-absolute cwd here killed every
   * run via the workspace probe on 2026-08-31).
   */
  cwd: z
    .string()
    .refine((p) => !p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p), {
      message: "cwd must be workspace-relative (host-absolute path rejected)",
    })
    .optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().optional(),
});
export type ExecRequest = z.infer<typeof ExecRequestSchema>;

/**
 * Default deadline for a single exec when the request carries no `timeoutMs`
 * (Temporal start_to_close analog). Engines MUST apply it: the transport under
 * an exec (pods/exec WebSocket, child process pipe) has no heartbeat, so an
 * unbounded exec turns one silently dropped connection into a hung run.
 * Callers pass an explicit `timeoutMs` for commands that legitimately run
 * longer. A timed-out exec resolves `{ exitCode: null, timedOut: true }`.
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;

export const ExecEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stdout"),
    seq: z.number().int(),
    data: z.string(),
  }),
  z.object({
    kind: z.literal("stderr"),
    seq: z.number().int(),
    data: z.string(),
  }),
  z.object({
    kind: z.literal("exit"),
    seq: z.number().int(),
    exitCode: z.number().int().nullable(),
  }),
]);
export type ExecEvent = z.infer<typeof ExecEventSchema>;

export const ExecResultSchema = z.object({
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean().optional(),
});
export type ExecResult = z.infer<typeof ExecResultSchema>;

// --- Swappable engine contract ---

/**
 * A live handle into a provisioned sandbox workspace. Implementations own the
 * scratch-directory lifecycle; `destroy()` must release all engine resources
 * (containers, processes, temp files).
 *
 * Paths passed to `readFile`/`writeFile` are relative to the handle's
 * workspace. Paths escaping the workspace (`../`) must be rejected.
 */
export interface SandboxHandle {
  exec(
    request: ExecRequest,
    onEvent: (event: ExecEvent) => void,
  ): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: string): Promise<void>;
  destroy(): Promise<void>;
}

/**
 * Provisions a sandbox engine confined to `workspace`. The engine returns a
 * handle whose readFile/writeFile/exec are scoped to `workspace`; the engine
 * owns the scratch-directory lifecycle via the returned handle.
 */
export interface SandboxEngine {
  provision(
    profile: SandboxLaunchProfile,
    workspace: string,
  ): Promise<SandboxHandle>;
}

/**
 * Marker prefixing every quota-refusal message. One constant shared by the
 * engine that raises the refusal and the orchestrator that defers on it:
 * a producer/consumer pair is only trustworthy when both spellings come from
 * the same source.
 */
export const SANDBOX_QUOTA_EXHAUSTED = "sandbox_quota_exhausted";

/**
 * Provisioning refused for a reason the caller cannot fix: the cluster has
 * no room for another sandbox (namespace ResourceQuota). The sandbox was
 * never created, so the failure is a scheduling condition rather than an
 * agent failure — callers must defer the work, not charge it an attempt.
 *
 * The marker is part of the message by construction, so a producer cannot
 * raise this class and escape detection by {@link isQuotaDeferred}.
 */
export class SandboxQuotaError extends Error {
  constructor(detail: string) {
    super(`${SANDBOX_QUOTA_EXHAUSTED}: ${detail}`);
    this.name = "SandboxQuotaError";
  }
}

/**
 * True when a run's stored error records a quota refusal. Run errors cross
 * the process/database boundary as strings, so detection is textual and
 * matches what {@link SandboxQuotaError} writes.
 */
export function isQuotaDeferred(error: string | null | undefined): boolean {
  return typeof error === "string" && error.includes(SANDBOX_QUOTA_EXHAUSTED);
}
