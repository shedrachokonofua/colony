import {
  isModelFault,
  parseFault,
  retryBackoffMs,
  type Fault,
  type Run,
  type Store,
} from "@colony/core";
import { SERVICE_ACTOR, type ColonydContext } from "./context.js";
import { sanitizeTrace } from "@colony/provider";
import { z } from "zod";

/** Detail retained on a synthesized fault; long enough to be actionable. */
const FAULT_DETAIL_LIMIT = 240;

const taskRetryResetDetail = z.object({
  from: z.enum(["blocked", "canceled"]),
  to: z.literal("queued"),
});

/**
 * Fault codes the runner emits when the model never submitted an envelope
 * before the run died: the wall timer's default, its tool-activity
 * refinement, and the legacy rejection reason the loop scripted before
 * faults existed. A timeout excludes its model from redispatch at the same
 * subject instead of charging any failure budget.
 */
const TIMEOUT_FAULT_CODES: ReadonlySet<string> = new Set([
  "wall_timeout",
  "timeout_no_envelope",
  "timeout_without_envelope",
]);

/**
 * True when a failed run charges an agent budget: only a model-layer fault
 * does. Every other layer (harness, sandbox, provider, colonyd, unknown)
 * and every faultless row requeues free. Faultless rows are legacy or
 * resume-path rows the producer never classified; the migration backfilled
 * history, so a new faultless failure is unclassified, never agent-blamed.
 */
export function isModelFailure(
  run: Pick<Run, "status" | "fault_json"> | null | undefined,
): boolean {
  return run?.status === "failed" && isModelFault(parseFault(run.fault_json));
}

/**
 * True when a failed run carries a concrete platform fault: any parsed fault
 * that is not the model's. Faultless failures are NOT platform failures —
 * admission paths (merge-gate streaks, validate re-runs) keep counting them
 * the way the legacy text fallback counted unclassified errors.
 */
export function isPlatformFailure(
  run: Pick<Run, "status" | "fault_json"> | null | undefined,
): boolean {
  if (run?.status !== "failed") return false;
  const fault = parseFault(run.fault_json);
  return fault !== null && !isModelFault(fault);
}

/**
 * The fault a colonyd-side rejection of the agent's own output carries: the
 * run succeeded at the runner and then failed a colonyd contract check (an
 * unparseable envelope, an unprovable head, a repair that moved nothing).
 * The model produced that output, so the model is accountable — the
 * {unknown,unknown} fallback below is reserved for a runner result that
 * carries no fault at all.
 */
export function modelFault(code: string, detail?: string): Fault {
  return {
    layer: "model",
    code,
    ...(detail === undefined
      ? {}
      : { detail: detail.slice(0, FAULT_DETAIL_LIMIT) }),
  };
}

/**
 * Resolve the fault for a failed run. The runner's own fault rides through
 * untouched; a failure with no fault at all — a runner result that predates
 * the contract, or a throw before any metadata existed — is unclassified,
 * never re-derived from its error text. It audits loudly (run.fault_unknown)
 * and requeues free under the tick's fault-only budgeting.
 */
export function faultForFailure(
  store: Pick<Store, "audit">,
  refs: {
    readonly scope_id?: string | null;
    readonly task_id?: string | null;
    readonly run_id?: string | null;
  },
  reason: string,
  fault: Fault | undefined,
): Fault {
  if (fault) return fault;
  const clean = sanitizeTrace(reason);
  const errorExcerpt = clean.slice(0, FAULT_DETAIL_LIMIT);
  console.error("[fault] unknown classification", clean);
  store.audit(SERVICE_ACTOR, "run.fault_unknown", {
    ...refs,
    detail: { errorExcerpt },
  });
  return { layer: "unknown", code: "unknown", detail: errorExcerpt };
}

/** True when a failed run died to a model timeout rather than a verdict. */
export function isTimeoutFault(
  run: Pick<Run, "status" | "fault_json"> | null | undefined,
): boolean {
  if (run?.status !== "failed") return false;
  const code = parseFault(run.fault_json)?.code;
  return code !== undefined && TIMEOUT_FAULT_CODES.has(code);
}

/**
 * Count accountable implementation failures in a caller-selected
 * chronological history. Only model faults charge the streak; platform and
 * unknown faults and canceled executions are ignored; a successful
 * implementation starts a fresh failure streak.
 */
export function consecutiveModelFailures(runs: readonly Run[]): number {
  let failures = 0;
  for (const run of runs) {
    if (run.kind !== "implement") continue;
    if (run.status === "succeeded") {
      failures = 0;
      continue;
    }
    if (!isModelFailure(run)) continue;
    failures += 1;
  }
  return failures;
}

/** Find the latest explicit reset without losing it behind a noisy audit page. */
export function retryResetAt(
  store: Pick<Store, "listAudit">,
  kind: "task" | "scope",
  id: string,
): string | undefined {
  let beforeId: number | undefined;
  for (;;) {
    const page = store.listAudit({
      ...(kind === "task" ? { task_id: id } : { scope_id: id }),
      ...(beforeId === undefined ? {} : { before_id: beforeId }),
      limit: 200,
    });
    for (let index = page.events.length - 1; index >= 0; index -= 1) {
      const row = page.events[index]!;
      if (kind === "scope" && row.action === "scope.unblocked") return row.at;
      if (
        kind !== "task" ||
        row.action !== "task.transition" ||
        row.actor === SERVICE_ACTOR
      ) {
        continue;
      }
      try {
        const parsed = taskRetryResetDetail.safeParse(
          JSON.parse(row.detail_json),
        );
        if (parsed.success) return row.at;
      } catch {
        // Malformed historical detail cannot establish a reset boundary.
      }
    }
    if (!page.has_more || page.oldest_id === null) return undefined;
    beforeId = page.oldest_id;
  }
}

/**
 * Shared attempt-budget and retry helper for implementer execution and
 * repair-intent failures.
 *
 * Precondition: task must exist and be in "running". Returns early without
 * transition if not.
 *
 * Model-layer faults consume the attempt budget and increment consecutive
 * model failures. If failures >= maxAttempts, transitions the task to blocked.
 * Non-model faults (infra/platform/unknown/canceled) requeue free without
 * consuming the budget, clear any active repair intent run_id, and audit
 * task.infra_retry.
 */
export function retryOrFailTaskWithBudget(
  ctx: Pick<ColonydContext, "store" | "env">,
  taskId: string,
  reason: string,
  options?: {
    readonly fault?: Fault;
    readonly blockedReason?: (failures: number, maxAttempts: number) => string;
  },
): void {
  const task = ctx.store.getTask(taskId);
  if (!task || task.state !== "running") return;

  const last = ctx.store
    .runsForTask(taskId)
    .filter((r) => r.kind === "implement")
    .at(-1);

  // If explicit fault passed, check that; otherwise inspect last implement run.
  const consumes = options?.fault
    ? isModelFault(options.fault)
    : isModelFailure(last);

  const deferred = options?.fault
    ? !consumes
    : last?.status === "canceled" || (last?.status === "failed" && !consumes);

  const since = retryResetAt(ctx.store, "task", task.id);
  const failures = consecutiveModelFailures(
    ctx.store
      .runsForTask(task.id)
      .filter((run) => !since || run.started_at > since),
  );

  const attempt = consumes ? task.attempt + 1 : task.attempt;

  if (deferred) {
    // If this task was running an unresolved repair intent, unbind its run_id
    // so the retry can rebind and thread the repair traces.
    const unresolvedRepair = ctx.store
      .listRepairIntents(task.id)
      .filter((r) => r.resolved_head_sha === null)
      .at(-1);
    if (unresolvedRepair) {
      ctx.store.clearRepairIntentRunId(unresolvedRepair.fingerprint);
    }
    ctx.store.audit(SERVICE_ACTOR, "task.infra_retry", {
      scope_id: task.scope_id,
      task_id: task.id,
      detail: { reason },
    });
  }

  if (!deferred && failures >= ctx.env.maxAttempts) {
    const defaultBlockedReason = `${failures} consecutive implementation failures: ${reason}`;
    const blocked_reason = options?.blockedReason
      ? options.blockedReason(failures, ctx.env.maxAttempts)
      : defaultBlockedReason;

    ctx.store.transitionTask(
      task.id,
      task.state_version,
      "blocked",
      SERVICE_ACTOR,
      { blocked_reason },
    );
    return;
  }

  ctx.store.transitionTask(
    task.id,
    task.state_version,
    "queued",
    SERVICE_ACTOR,
    {
      attempt,
      next_retry_at: new Date(
        Date.now() + retryBackoffMs(Math.max(1, failures)),
      ).toISOString(),
    },
  );
}
