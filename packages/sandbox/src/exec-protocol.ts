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
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().optional(),
});
export type ExecRequest = z.infer<typeof ExecRequestSchema>;

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
