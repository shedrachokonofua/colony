import { readSessionHeader } from "@colony/agent-runtime/session-store";
import { heartbeatIntervalMs, type Run, type Store } from "@colony/core";
import type { ProviderAdapter } from "@colony/provider";
import type { SandboxHandle } from "@colony/sandbox";
import { SERVICE_ACTOR } from "../context.js";
import type { Logger } from "../logging.js";
import { destroyRunSandbox } from "./sandboxes.js";
import { trackRun } from "./registry.js";
import { revokeTokensForRuns } from "./tokens.js";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export interface AdoptionDeps {
  readonly store: Store;
  readonly provider: ProviderAdapter;
  readonly logger: Logger;
  readonly sessionsDir: string;
  readonly probeTimeoutMs?: number; // default 10_000
  readonly connect: (sandboxId: string) => Promise<SandboxHandle>;
}

export interface Classification {
  readonly adoptable: Run[];
  readonly orphans: Run[];
}

export interface AdoptionResult extends Classification {
  /**
   * Gates passed but the claim is held by a live claimant. Held claims
   * become re-issuable when the holder stops heartbeating (or releases at
   * its drain); the tick retries them via {@link retryDeferredAdoptions}.
   */
  readonly deferred: Run[];
}

export type AdoptionRunDeps = AdoptionDeps & {
  readonly resume: (run: Run, signal: AbortSignal) => Promise<void>;
  readonly cancel: (run: Run) => Promise<void>;
  readonly resumeLeaseTtlMs: number;
};

/** Gate evaluation + bounded sandbox probe; performs NO writes. */
export async function classifyRuns(
  deps: AdoptionDeps,
  runs: readonly Run[],
): Promise<Classification> {
  const adoptable: Run[] = [];
  const orphans: Run[] = [];
  const probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const nowIso = new Date().toISOString();

  for (const run of runs) {
    // Gate a: lease is live
    if (!(run.lease_expires_at > nowIso)) {
      orphans.push(run);
      continue;
    }

    // Gate b: kind is one of "architect" | "implement" | "review"
    if (
      run.kind !== "architect" &&
      run.kind !== "implement" &&
      run.kind !== "review"
    ) {
      orphans.push(run);
      continue;
    }

    // Gate c: readSessionHeader(deps.sessionsDir, run.id).ok === true
    const sessionHeader = readSessionHeader(deps.sessionsDir, run.id);
    if (!sessionHeader.ok) {
      orphans.push(run);
      continue;
    }

    // Gate d: run.sandbox_id is non-null AND connect resolves AND exec("test -e /workspace") exits 0 within probeTimeoutMs
    if (!run.sandbox_id) {
      orphans.push(run);
      continue;
    }

    let probePassed = false;
    try {
      const probePromise = (async () => {
        const handle = await deps.connect(run.sandbox_id!);
        const res = await handle.exec(
          { command: "test -e /workspace" },
          () => {},
        );
        return res.exitCode === 0 && !res.timedOut;
      })();

      const timeoutPromise = new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), probeTimeoutMs),
      );

      probePassed = await Promise.race([probePromise, timeoutPromise]);
    } catch {
      probePassed = false;
    }

    if (probePassed) {
      adoptable.push(run);
    } else {
      orphans.push(run);
    }
  }

  return { adoptable, orphans };
}

/** Claim resumable work before scheduling tracked background execution. */
export async function adoptOrExpireRuns(
  deps: AdoptionRunDeps,
): Promise<AdoptionResult> {
  const active = deps.store.activeRuns();
  const classification = await classifyRuns(deps, active);

  for (const orphan of classification.orphans) {
    // The crash reaped these: the run was in flight when the process died
    // and nothing survived to resume it. Distinct from process_restart
    // below, where the run WAS adopted and its resume broke.
    deps.store.finishRun(orphan.id, "failed", {
      error: "crash_reaped",
      fault: { layer: "colonyd", code: "crash_reaped" },
    });
    await revokeTokensForRuns(deps.store, deps.provider, [orphan]);
    // The run is terminal and has no handler left to tear down its sandbox.
    await destroyRunSandbox(deps.connect, orphan, deps.logger);
  }

  const deferred: Run[] = [];
  for (const adoptable of classification.adoptable) {
    if (!claimAndTrackRun(deps, adoptable)) deferred.push(adoptable);
  }

  return { ...classification, deferred };
}

/**
 * Re-attempt the claims a prior pass lost to a live claimant. Claim holders
 * release at their drain (`handoffRun`) or become re-claimable when their
 * lease stops moving (see `Store.adoptRun`), so a retrying daemon picks the
 * run up as soon as either happens. Ids are pruned once their run leaves
 * `running`: nothing to claim, nothing to retry.
 */
export async function retryDeferredAdoptions(
  deps: AdoptionRunDeps,
  deferredIds: Set<string>,
): Promise<Run[]> {
  const claimed: Run[] = [];
  for (const id of [...deferredIds]) {
    const run = deps.store.getRun(id);
    if (!run || run.status !== "running") {
      deferredIds.delete(id);
      continue;
    }
    if (claimAndTrackRun(deps, run)) {
      deferredIds.delete(id);
      claimed.push(run);
    }
  }
  return claimed;
}

/** Claim a run and schedule its tracked resume. True only for the winner. */
function claimAndTrackRun(deps: AdoptionRunDeps, run: Run): boolean {
  if (!deps.store.adoptRun(run.id, deps.resumeLeaseTtlMs)) return false;
  const controller = new AbortController();
  let detached = false;
  const heartbeat = setInterval(
    () => deps.store.heartbeatRun(run.id, deps.resumeLeaseTtlMs),
    heartbeatIntervalMs(deps.resumeLeaseTtlMs),
  );
  heartbeat.unref();
  // The microtask starts after every claim has been recorded. Agent wiring
  // can therefore preserve the complete sandbox set before provisioning.
  const execution = Promise.resolve()
    .then(async () => {
      controller.signal.throwIfAborted();
      await deps.resume(run, controller.signal);
      controller.signal.throwIfAborted();
    })
    .catch(async (err: unknown) => {
      if (detached) return;
      if (controller.signal.aborted) {
        deps.store.finishRun(run.id, "canceled", { error: "aborted" });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      deps.store.appendRunEvent(run.id, "run_resume_failed", {
        error: message,
      });
      deps.store.finishRun(run.id, "failed", {
        error: "process_restart",
        fault: { layer: "colonyd", code: "process_restart" },
      });
      deps.store.audit(SERVICE_ACTOR, "run.restart_failed", {
        run_id: run.id,
        scope_id: run.scope_id,
        task_id: run.task_id,
        detail: { reason: message },
      });
    })
    .finally(async () => {
      clearInterval(heartbeat);
      if (!detached) {
        await revokeTokensForRuns(deps.store, deps.provider, [
          deps.store.getRun(run.id) ?? run,
        ]);
        // A resumed segment deliberately keeps its sandbox when it does not
        // complete (the next daemon requeues against it), so a run that
        // ended failed/canceled here has no handler left to tear it down —
        // the daemon must, or the sandbox outlives the run and holds its
        // namespace slot until some startup sweep (production 2026-09-26:
        // until an operator deleted it by hand). A succeeded segment's
        // teardown is the runner's own.
        const settled = deps.store.getRun(run.id);
        if (
          settled &&
          settled.status !== "running" &&
          settled.status !== "succeeded"
        ) {
          await destroyRunSandbox(deps.connect, settled, deps.logger);
        }
      }
    });
  trackRun(
    run.id,
    execution,
    async () => {
      controller.abort();
      await deps.cancel(run);
    },
    () => {
      detached = true;
      clearInterval(heartbeat);
      controller.abort();
    },
  );
  return true;
}
