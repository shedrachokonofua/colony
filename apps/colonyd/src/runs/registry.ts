/**
 * In-process run tracking: colonyd executes agent and gate runs inside the
 * same process. The registry tracks pending promises (for test draining)
 * and abort handles (for shutdown / task cancel / scope abandon).
 */

interface TrackedRun {
  readonly promise: Promise<unknown>;
  readonly abort: () => Promise<void> | void;
}

const tracked = new Map<string, TrackedRun>();

export function trackRun(
  runId: string,
  promise: Promise<unknown>,
  abort: () => Promise<void> | void,
): void {
  tracked.set(runId, { promise, abort });
  void promise.finally(() => {
    // Drop once settled unless replaced by a re-registration.
    const current = tracked.get(runId);
    if (current?.promise === promise) tracked.delete(runId);
  });
}

export async function abortRun(runId: string): Promise<boolean> {
  const entry = tracked.get(runId);
  if (!entry) return false;
  await entry.abort();
  return true;
}

export async function abortRuns(runIds: readonly string[]): Promise<void> {
  await Promise.all(runIds.map((id) => abortRun(id)));
}

export function activeTrackedRunIds(): string[] {
  return [...tracked.keys()];
}

/** Await every in-flight run until the registry drains. */
export async function awaitPendingRuns(): Promise<void> {
  for (;;) {
    const pending = [...tracked.values()].map((entry) => entry.promise);
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}
