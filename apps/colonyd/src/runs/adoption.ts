import { readSessionHeader } from "@colony/agent-runtime/session-store";
import type { Run, Store } from "@colony/core";
import type { ProviderAdapter } from "@colony/provider";
import type { SandboxHandle } from "@colony/sandbox";
import { SERVICE_ACTOR } from "../context.js";
import type { Logger } from "../logging.js";
import { revokeTokensForRuns } from "./tokens.js";
import { trackRun } from "./registry.js";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export interface AdoptionDeps {
  readonly store: Store;
  readonly provider: ProviderAdapter;
  readonly logger: Logger;
  readonly sessionsDir: string;
  readonly probeTimeoutMs?: number; // default 10_000
  readonly connect: (sandboxId: string) => Promise<SandboxHandle>;
}

export interface AdoptionResult {
  readonly adoptable: Run[];
  readonly orphans: Run[];
}

/** Gate evaluation + bounded sandbox probe; performs NO writes. */
export async function classifyRuns(
  deps: AdoptionDeps,
  runs: readonly Run[],
): Promise<AdoptionResult> {
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
  deps: AdoptionDeps & {
    readonly resume: (run: Run, signal: AbortSignal) => Promise<void>;
    readonly cancel: (run: Run) => Promise<void>;
    readonly resumeLeaseTtlMs: number;
  },
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
  }

  for (const adoptable of classification.adoptable) {
    if (!deps.store.adoptRun(adoptable.id, deps.resumeLeaseTtlMs)) continue;
    const controller = new AbortController();
    let detached = false;
    const heartbeat = setInterval(
      () => deps.store.heartbeatRun(adoptable.id, deps.resumeLeaseTtlMs),
      Math.min(60_000, Math.max(1, Math.floor(deps.resumeLeaseTtlMs / 3))),
    );
    heartbeat.unref();
    // The microtask starts after every claim has been recorded. Agent wiring
    // can therefore preserve the complete sandbox set before provisioning.
    const execution = Promise.resolve()
      .then(async () => {
        controller.signal.throwIfAborted();
        await deps.resume(adoptable, controller.signal);
        controller.signal.throwIfAborted();
      })
      .catch(async (err: unknown) => {
        if (detached) return;
        if (controller.signal.aborted) {
          deps.store.finishRun(adoptable.id, "canceled", { error: "aborted" });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        deps.store.appendRunEvent(adoptable.id, "run_resume_failed", {
          error: message,
        });
        deps.store.finishRun(adoptable.id, "failed", {
          error: "process_restart",
          fault: { layer: "colonyd", code: "process_restart" },
        });
        deps.store.audit(SERVICE_ACTOR, "run.restart_failed", {
          run_id: adoptable.id,
          scope_id: adoptable.scope_id,
          task_id: adoptable.task_id,
          detail: { reason: message },
        });
      })
      .finally(async () => {
        clearInterval(heartbeat);
        if (!detached) {
          await revokeTokensForRuns(deps.store, deps.provider, [
            deps.store.getRun(adoptable.id) ?? adoptable,
          ]);
        }
      });
    trackRun(
      adoptable.id,
      execution,
      async () => {
        controller.abort();
        await deps.cancel(adoptable);
      },
      () => {
        detached = true;
        clearInterval(heartbeat);
        controller.abort();
      },
    );
  }

  return classification;
}
