/**
 * Bounded graceful drain: on shutdown the process stops dispatching new runs,
 * waits for in-flight runs until the timeout cap, then aborts the remainder
 * exactly once. The clock and sleep are injected so tests never wait real
 * milliseconds.
 */

export interface DrainDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs: number;
  readonly timeoutMs: number;
  readonly activeRunIds: () => readonly string[];
  readonly abortAll: (ids: readonly string[]) => Promise<void>;
  readonly awaitSettled: () => Promise<void>;
}

export interface DrainController {
  /** Flip the dispatch gate synchronously; idempotent. */
  beginDrain(): void;
  readonly isDraining: () => boolean;
  /**
   * Poll `activeRunIds()` every `pollMs` until the registry is empty
   * ('drained', `abortAll` never called; resolves immediately when no runs
   * are active) or the cap elapses ('aborted', after aborting the surviving
   * ids once and awaiting their settle).
   */
  wait(): Promise<"drained" | "aborted">;
}

export function createDrainController(deps: DrainDeps): DrainController {
  let draining = false;
  return {
    beginDrain(): void {
      draining = true;
    },
    isDraining: () => draining,
    async wait(): Promise<"drained" | "aborted"> {
      const start = deps.now();
      for (;;) {
        // Empty wins over the cap: runs that settle on the boundary are
        // drained, not aborted.
        if (deps.activeRunIds().length === 0) return "drained";
        if (deps.now() - start >= deps.timeoutMs) {
          await deps.abortAll(deps.activeRunIds());
          await deps.awaitSettled();
          return "aborted";
        }
        await deps.sleep(deps.pollMs);
      }
    },
  };
}