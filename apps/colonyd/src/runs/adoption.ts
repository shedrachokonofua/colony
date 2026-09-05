import { readSessionHeader } from "@colony/agent-runtime/session-store";
import type { Run, Store } from "@colony/core";
import type { ProviderAdapter } from "@colony/provider";
import type { SandboxHandle } from "@colony/sandbox";
import { SERVICE_ACTOR } from "../context.js";
import type { Logger } from "../logging.js";
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

/** Boot replacement for expireOrphanedRuns: fail+revoke orphans, adopt+resume the rest. */
export async function adoptOrExpireRuns(
  deps: AdoptionDeps & {
    readonly resume: (run: Run) => Promise<void>;
    readonly resumeLeaseTtlMs: number;
  },
): Promise<AdoptionResult> {
  const active = deps.store.activeRuns();
  const classification = await classifyRuns(deps, active);

  // For orphans replicate today's behavior exactly:
  // store.finishRun(run.id, "failed", { error: "process_restart" }) then await revokeTokensForRuns(store, provider, [run])
  for (const orphan of classification.orphans) {
    deps.store.finishRun(orphan.id, "failed", {
      error: "process_restart",
      fault: { layer: "colonyd", code: "process_restart" },
    });
    await revokeTokensForRuns(deps.store, deps.provider, [orphan]);
  }

  // For each adoptable run, in order:
  // if (!store.adoptRun(run.id, deps.resumeLeaseTtlMs)) continue;
  // then await deps.resume(run) wrapped in try/catch
  for (const adoptable of classification.adoptable) {
    if (!deps.store.adoptRun(adoptable.id, deps.resumeLeaseTtlMs)) {
      continue;
    }

    try {
      await deps.resume(adoptable);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.store.appendRunEvent(adoptable.id, "run_resume_failed", {
        error: message,
      });
      deps.store.finishRun(adoptable.id, "failed", {
        error: "process_restart",
        fault: { layer: "colonyd", code: "process_restart" },
      });
      await revokeTokensForRuns(deps.store, deps.provider, [adoptable]);
      deps.store.audit(SERVICE_ACTOR, "run.restart_failed", {
        run_id: adoptable.id,
        scope_id: adoptable.scope_id,
        task_id: adoptable.task_id,
        detail: { reason: message },
      });
    }
  }

  return classification;
}
