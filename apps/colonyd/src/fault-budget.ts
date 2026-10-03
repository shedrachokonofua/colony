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
import { GitLabProviderError } from "@colony/provider-gitlab";
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

/**
 * The fault a deterministic provider rejection carries: an HTTP 4xx the
 * provider will answer identically on retry (a MR title GitLab caps at 255
 * characters retried for hours, col-79c7045a.7), so it must never fall
 * through to the free unknown fallback. Returns undefined for everything
 * that is not such a rejection, keeping the caller's fallback untouched.
 */
export function providerRejectionFault(error: unknown): Fault | undefined {
  if (!(error instanceof GitLabProviderError)) return undefined;
  const { status } = error;
  if (status < 400 || status > 499) return undefined;
  // The transient 4xx can still succeed on retry — 408 timeout, 409
  // conflict, 425 too-early, 429 rate limit — like every 5xx and every
  // non-HTTP failure: they stay on the free-retry path.
  if (status === 408 || status === 409 || status === 425 || status === 429) {
    return undefined;
  }
  return {
    layer: "provider",
    code: "provider_rejected",
    detail: sanitizeTrace(error.message).slice(0, FAULT_DETAIL_LIMIT),
  };
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

/**
 * The trailing consecutive identical unclassified implementation failures:
 * walking back over implement runs, failed runs whose fault layer is unknown
 * with the same detail, stopped by the first run that is not one. A
 * non-failed run (succeeded, canceled), a faulted run of any other layer and
 * a divergent detail all break the streak; runs of other kinds are ignored.
 */
function identicalUnknownFailureStreak(runs: readonly Run[]):
  | {
      readonly count: number;
      readonly detail: string;
    }
  | undefined {
  let detail: string | undefined;
  let count = 0;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (run.kind !== "implement") continue;
    if (run.status !== "failed") break;
    const fault = parseFault(run.fault_json);
    if (fault?.layer !== "unknown" || typeof fault.detail !== "string") break;
    if (detail === undefined) {
      detail = fault.detail;
    } else if (fault.detail !== detail) {
      break;
    }
    count += 1;
  }
  return detail === undefined ? undefined : { count, detail };
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
 * A provider_rejected fault — a deterministic provider HTTP rejection that
 * cannot succeed on retry — blocks the task immediately with the sanitized
 * provider message as the blocked_reason. As a backstop, when the trailing
 * consecutive implement runs since the last retry reset are failed runs
 * whose faults are all layer unknown with the identical detail and that
 * streak reaches maxAttempts, the task blocks too, with a blocked_reason
 * naming the repetition and the detail. Any other non-model fault
 * (infra/platform/unknown/canceled) requeues free without consuming the
 * budget, clears any active repair intent run_id, and audits
 * task.infra_retry; a non-failed run (succeeded, canceled) or a divergent
 * fault detail breaks the unclassified streak.
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

  const fault =
    options?.fault ??
    (last?.status === "failed"
      ? (parseFault(last.fault_json) ?? undefined)
      : undefined);

  if (fault?.layer === "provider" && fault.code === "provider_rejected") {
    // The provider answered deterministically: retrying cannot succeed.
    ctx.store.transitionTask(
      task.id,
      task.state_version,
      "blocked",
      SERVICE_ACTOR,
      {
        blocked_reason: `provider rejected this task: ${sanitizeTrace(
          fault.detail ?? reason,
        )}`,
      },
    );
    return;
  }

  const since = retryResetAt(ctx.store, "task", task.id);
  const window = ctx.store
    .runsForTask(task.id)
    .filter((run) => !since || run.started_at > since);
  const failures = consecutiveModelFailures(window);

  const attempt = consumes ? task.attempt + 1 : task.attempt;

  const streak = identicalUnknownFailureStreak(window);
  if (streak && streak.count >= ctx.env.maxAttempts) {
    ctx.store.transitionTask(
      task.id,
      task.state_version,
      "blocked",
      SERVICE_ACTOR,
      {
        blocked_reason: `the same unclassified failure repeated ${streak.count} times: ${sanitizeTrace(
          streak.detail,
        )}`,
      },
    );
    return;
  }

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

  // A provider-directed retry hint on the fault (an HTTP Retry-After or a
  // quota window's earliest reset) may only push the retry later than the
  // ordinary backoff, never earlier.
  const providerNotBefore = fault?.retryNotBefore
    ? Date.parse(fault.retryNotBefore)
    : Number.NaN;
  const retryAtMs = Date.now() + retryBackoffMs(Math.max(1, failures));
  ctx.store.transitionTask(
    task.id,
    task.state_version,
    "queued",
    SERVICE_ACTOR,
    {
      attempt,
      next_retry_at: new Date(
        Number.isFinite(providerNotBefore)
          ? Math.max(retryAtMs, providerNotBefore)
          : retryAtMs,
      ).toISOString(),
    },
  );
}
