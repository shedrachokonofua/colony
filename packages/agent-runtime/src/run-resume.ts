import { context, type Context } from "@opentelemetry/api";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { SandboxHandle } from "@colony/sandbox";
import type { AgentRunMetadata, AgentRuntimePacket } from "./adapter.js";
import {
  createFileSessionManager,
  readSessionHeader,
} from "./session-store.js";

/**
 * Continues a run whose sandbox SURVIVED the daemon that started it.
 *
 * The conversation is reloaded from the run's persisted session journal and
 * re-attached to the SAME sandbox, so the agent sees its own history and its
 * workspace. One thing cannot survive: shell state. The agent's cwd, exported
 * variables, and background processes died with the old process while the
 * transcript still shows them as live, so the resumed segment opens with a
 * fixed steer telling it to re-verify rather than trust them.
 */
export const RESUME_STEER_PROMPT =
  "colonyd restarted while you were working. The conversation and workspace are intact, but your shell state (cwd, exported vars, background processes) was reset. Re-verify with git status and continue the task.";

/**
 * A FRESH root span for the resumed segment — never the pre-restart trace
 * context. Continuing the old trace would splice two processes' spans into
 * one timeline and attribute the new process's work to a trace whose parent
 * span is already ended.
 */
export interface ResumeSpan {
  readonly traceId: string;
  /** The context the resumed work must nest under. */
  readonly spanContext: Context;
  end(status: string, reason?: string): void;
}

/** The reloaded journal and re-attached sandbox the continuation drives. */
export interface ResumeSession {
  readonly handle: SandboxHandle;
  readonly sessionManager: SessionManager;
  /** The fixed steer that opens the resumed segment. */
  readonly steerPrompt: string;
  /** The fresh span context; prompts must nest under it, not the old trace. */
  readonly traceContext: Context | undefined;
  /**
   * The driver MUST call this exactly once, when the resumed agent loop is
   * actually running. It is what makes "resumed" a statement about a live
   * continuation rather than about a function that returned successfully.
   */
  readonly onRunning: () => void;
}

/**
 * Rebuilds the session and drives it to a submission. The seam colonyd's
 * adapter fills with the role runner: session construction, the steer turn,
 * and the prompt loop are the runner's job, and only the runner has the
 * role's models, tools, and guards.
 */
export type ResumeDriver = (
  session: ResumeSession,
) => Promise<AgentRunMetadata>;

export interface ResumeRequest {
  readonly runId: string;
  readonly sandboxId: string;
  /** Session root; the journal is `sessionFilePath(sessionsDir, runId)`. */
  readonly sessionsDir: string;
  readonly packet: AgentRuntimePacket;
  readonly connect: (sandboxId: string) => Promise<SandboxHandle>;
  /**
   * Required, and required to report the loop running: a resumed run without
   * one is a run nobody steers, so there is no success path that skips it.
   */
  readonly drive: ResumeDriver;
  readonly emitEvent: (
    event: "run_resumed" | "run_resume_failed",
    detail: Record<string, unknown>,
  ) => void;
  /** Supplies a `startColonyRunSpan`-shaped fresh root span. */
  readonly startSpan: () => ResumeSpan | undefined;
}

/**
 * Resumes a checkpointed run on its surviving sandbox.
 *
 * The sequence is: reload the journal, re-attach the sandbox, then hand both
 * to the driver, which rebuilds the session and runs the loop. Every failure
 * in it — a missing journal, a sandbox that no longer answers, a driver that
 * throws, a driver that never starts the loop — emits `run_resume_failed`
 * and rethrows, so the caller fails the run and requeues it. A run is never
 * left without a driver: either this returns a live continuation's metadata,
 * or the caller sees a throw and owns the failure.
 */
export async function resumeRun(
  request: ResumeRequest,
): Promise<AgentRunMetadata> {
  const span = request.startSpan();
  let running = false;
  const onRunning = (): void => {
    if (running) return;
    running = true;
    // The continuation is live only once the loop is actually running: a
    // reloaded journal on a re-attached sandbox that never got prompted is
    // not a resumed run, it is a run waiting for a driver.
    request.emitEvent("run_resumed", {
      sandbox_id: request.sandboxId,
      entries_loaded: readSessionHeader(request.sessionsDir, request.runId)
        .entries,
    });
  };
  try {
    // The journal must exist and parse: a run whose transcript cannot be
    // reloaded has no conversation to continue, and silently starting a fresh
    // session would look to the agent like a brand-new task.
    const header = readSessionHeader(request.sessionsDir, request.runId);
    if (!header.ok) {
      throw new Error(
        `session journal missing or unreadable for run ${request.runId}`,
      );
    }
    const sessionManager = await createFileSessionManager(
      request.sessionsDir,
      request.runId,
    );
    const handle = await request.connect(request.sandboxId);
    const drive = (): Promise<AgentRunMetadata> =>
      request.drive({
        handle,
        sessionManager,
        steerPrompt: RESUME_STEER_PROMPT,
        traceContext: span?.spanContext,
        onRunning,
      });
    // The whole continuation runs inside the fresh span's context, so the
    // SDK's GenAI spans nest under THIS process's root instead of floating
    // on whatever context happened to be active — the pre-restart trace's
    // spans belong to a process that no longer exists.
    const result =
      span === undefined
        ? await drive()
        : await context.with(span.spanContext, drive);
    if (!running) {
      throw new Error(
        `resume driver for run ${request.runId} returned without starting the agent loop`,
      );
    }
    span?.end("succeeded");
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    request.emitEvent("run_resume_failed", { error });
    span?.end("failed", error);
    throw err;
  }
}
