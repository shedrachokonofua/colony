import {
  parseFault,
  type Fault,
  type Run,
  type Scope,
  type Store,
  type Task,
} from "@colony/core";
import { sanitizeTrace } from "@colony/provider";
import { isTimeoutFault } from "./fault-budget.js";

/** The only two windows an operator page asks for; anything else is a 400. */
export const OPERATOR_SUMMARY_WINDOWS = ["24h", "7d"] as const;

export type OperatorSummaryWindow = (typeof OPERATOR_SUMMARY_WINDOWS)[number];

const WINDOW_MS: Record<OperatorSummaryWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export function windowMs(window: OperatorSummaryWindow): number {
  return WINDOW_MS[window];
}

/** Cap on each waiting_on_you list and on the unclassified tail. */
const LIST_CAP = 100;

/**
 * A run is stalled when it is running and its wall age exceeds its lease:
 * a leased run heartbeats (runs/adoption.ts, runs/implement.ts) well inside
 * the lease, so an age past the lease means no heartbeat landed — the
 * process holding it died or wedged. No new timeout knob: the lease the
 * dispatcher already granted IS the progress contract.
 */
const STALL_LEASE_MULTIPLIER = 2;

/**
 * Fault codes a restart left behind: the crash-reap path and the resume-
 * failure path in runs/adoption.ts. A restart incident is a minute bucket
 * holding at least one of them, so N runs that died together are one
 * incident (objective D: a deploy restart reaps a batch, not N outages).
 */
const RESTART_FAULT_CODES: ReadonlySet<string> = new Set([
  "crash_reaped",
  "process_restart",
]);

const MERGE_ACTION = "mr.merged";
const VERDICT_APPROVED_ACTION = "review.approved";
const VERDICT_CHANGES_ACTION = "review.changes_requested";
const VALIDATION_PASS_ACTION = "scope.validated";
const VALIDATION_FAIL_ACTION = "scope.validation_failed";

export interface PlanApproval {
  readonly scope_id: string;
}

export interface AwaitingMerge {
  readonly scope_id: string;
  readonly task_id: string;
  readonly head_sha: string;
}

export interface BlockedTask {
  readonly scope_id: string;
  readonly task_id: string;
  readonly blocked_reason: string | null;
  readonly age: string | null;
}

export interface BlockedScope {
  readonly scope_id: string;
  readonly blocked_reason: string | null;
  readonly age: string | null;
}

export interface LiveRun {
  readonly id: string;
  readonly kind: Run["kind"];
  readonly model_id: string | null;
  readonly scope_id: string;
  readonly task_id: string | null;
  readonly started_at: string;
  readonly last_progress_at: string | null;
  readonly active_tool: string | null;
  readonly stalled: boolean;
}

export interface ModelMetrics {
  readonly runs: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly timeouts: number;
  readonly completion_rate: number;
  readonly median_ms: number | null;
  readonly p90_ms: number | null;
}

export interface RestartIncidents {
  readonly incidents: number;
  readonly reaped_runs: number;
}

export interface ValidationCounts {
  readonly pass: number;
  readonly fail: number;
}

export interface Metrics {
  readonly runs_by_kind_status: Record<string, number>;
  readonly merges: number;
  readonly verdicts: number;
  readonly per_model: Record<string, ModelMetrics>;
  readonly faults_by_layer: Record<string, number>;
  readonly faults_by_layer_code: Record<string, number>;
  readonly restart_incidents: RestartIncidents;
  readonly validation: ValidationCounts;
}

export interface UnclassifiedRow {
  readonly run_id: string;
  readonly kind: Run["kind"];
  readonly model_id: string | null;
  readonly task_id: string | null;
  readonly finished_at: string | null;
  readonly detail: string;
}

export interface Deploy {
  readonly version: string;
  readonly started_at: string;
  readonly restart_incidents: RestartIncidents;
}

export interface WaitingOnYou {
  readonly plan_approvals: PlanApproval[];
  readonly awaiting_merge: AwaitingMerge[];
  readonly blocked_tasks: BlockedTask[];
  readonly blocked_scopes: BlockedScope[];
}

export interface OperatorSummary {
  readonly window: OperatorSummaryWindow;
  readonly window_start: string;
  readonly generated_at: string;
  readonly waiting_on_you: WaitingOnYou;
  readonly live: LiveRun[];
  readonly metrics: Metrics;
  readonly unclassified: UnclassifiedRow[];
  readonly deploy: Deploy;
}

export interface OperatorSummaryOptions {
  readonly window: OperatorSummaryWindow;
  /** Injected so the summary is a pure function of (store, now, window). */
  readonly now?: Date;
  /** Process start, for `deploy.started_at`; defaults to this process's boot. */
  readonly startedAt?: Date;
  /** Deploy label; defaults to COLONY_VERSION (unknown when unset). */
  readonly version?: string;
}

/** Minute bucket of an ISO instant — the restart-incident grouping key. */
function minuteBucket(at: string): string | null {
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return null;
  return String(Math.floor(parsed / 60_000));
}

/**
 * Age of a row as an ISO-8601 duration, or null when its timestamp is
 * unparseable. Whole seconds only: the field is an operator's "how long has
 * this been sitting here", not a timestamp to diff against.
 */
function ageOf(at: string | null | undefined, nowMs: number): string | null {
  if (!at) return null;
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return null;
  return `PT${Math.max(0, Math.floor((nowMs - parsed) / 1000))}S`;
}

/** Nearest-rank percentile of a sorted ascending sample; null when empty. */
function percentileAt(
  sorted: readonly number[],
  fraction: number,
): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index]!;
}

/** Read the `head_sha` an audit detail recorded; null when absent. */
function detailHeadSha(detailJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(detailJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const head = (parsed as Record<string, unknown>)["head_sha"];
    return typeof head === "string" && head.length > 0 ? head : null;
  } catch {
    return null;
  }
}

/** A fault's layer/code pair, or null for a faultless run. */
function faultOf(run: Run): Fault | null {
  return parseFault(run.fault_json);
}

/**
 * The whole fleet-health summary, computed server-side from SQLite alone:
 * no provider call, no HTTP, deterministic in (store, now, window).
 *
 * Every metric and every row below it comes from ONE window read, so a count
 * can never disagree with the rows beside it. The window binds
 * COALESCE(finished_at, started_at) — the same predicate GET /runs uses —
 * so a running run windows by its start and a finished run by its finish.
 */
export function buildOperatorSummary(
  store: Store,
  opts: OperatorSummaryOptions,
): OperatorSummary {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const sinceMs = nowMs - windowMs(opts.window);
  const since = new Date(sinceMs).toISOString();
  const until = now.toISOString();

  // ONE read of the window: every metric and row below is derived from it,
  // never from a second, differently-filtered query.
  const windowRuns = store.runsInWindow(since, until);
  const live = store.activeRuns();

  const planApprovals: PlanApproval[] = [];
  const awaitingMerge: AwaitingMerge[] = [];
  const blockedTasks: BlockedTask[] = [];
  const blockedScopes: BlockedScope[] = [];

  const mrOpen: { task: Task; scope: Scope }[] = [];
  for (const scope of store.listScopes()) {
    if (scope.status === "planning" && scope.plan_json) {
      planApprovals.push({ scope_id: scope.id });
    }
    if (scope.status === "blocked") {
      blockedScopes.push({
        scope_id: scope.id,
        blocked_reason: scope.blocked_reason,
        age: ageOf(scope.updated_at, nowMs),
      });
    }
    if (
      scope.status === "active" ||
      scope.status === "validating" ||
      scope.status === "blocked"
    ) {
      for (const task of store.listTasks(scope.id)) {
        if (task.state === "blocked") {
          blockedTasks.push({
            scope_id: scope.id,
            task_id: task.id,
            blocked_reason: task.blocked_reason,
            age: ageOf(task.updated_at, nowMs),
          });
        }
        if (task.state === "mr_open" && scope.approvals === "manual") {
          mrOpen.push({ task, scope });
        }
      }
    }
  }

  // The head an awaiting-merge task offers is the one its latest review
  // approved: tasks carry no head_sha column, and review.ts writes that sha
  // into the review.approved audit detail. Newest-first per task, bounded to
  // the mr_open task set — never a scan of the audit log.
  const approvedHeads = store.latestAuditByTask(
    VERDICT_APPROVED_ACTION,
    mrOpen.map(({ task }) => task.id),
  );
  for (const { task } of mrOpen) {
    const head = approvedHeads.get(task.id);
    const headSha = head ? detailHeadSha(head.detail_json) : null;
    // No approval recorded, or the operator already approved this very head:
    // either way there is nothing waiting on them.
    if (headSha === null || headSha === task.merge_approved_sha) continue;
    awaitingMerge.push({
      scope_id: task.scope_id,
      task_id: task.id,
      head_sha: headSha,
    });
  }

  const auditCounts = store.countAuditByAction(
    [
      MERGE_ACTION,
      VERDICT_APPROVED_ACTION,
      VERDICT_CHANGES_ACTION,
      VALIDATION_PASS_ACTION,
      VALIDATION_FAIL_ACTION,
    ],
    since,
    until,
  );

  const runsByKindStatus: Record<string, number> = {};
  const faultsByLayer: Record<string, number> = {};
  const faultsByLayerCode: Record<string, number> = {};
  const unclassified: UnclassifiedRow[] = [];
  const restartBuckets = new Set<string>();
  let reapedRuns = 0;

  for (const run of windowRuns) {
    const key = `${run.kind}:${run.status}`;
    runsByKindStatus[key] = (runsByKindStatus[key] ?? 0) + 1;

    const fault = faultOf(run);
    if (fault) {
      faultsByLayer[fault.layer] = (faultsByLayer[fault.layer] ?? 0) + 1;
      const codeKey = `${fault.layer}:${fault.code}`;
      faultsByLayerCode[codeKey] = (faultsByLayerCode[codeKey] ?? 0) + 1;
      if (RESTART_FAULT_CODES.has(fault.code)) {
        reapedRuns += 1;
        // A deploy restart reaps a batch of runs inside one minute: the
        // incident is the outage, the runs are its victims. Counted on
        // finished_at because a reaped run is by definition finished.
        const bucketKey = run.finished_at
          ? minuteBucket(run.finished_at)
          : null;
        if (bucketKey !== null) restartBuckets.add(bucketKey);
      }
      if (fault.layer === "unknown") {
        unclassified.push({
          run_id: run.id,
          kind: run.kind,
          model_id: run.model_id,
          task_id: run.task_id,
          finished_at: run.finished_at,
          // The stored detail is whatever the runner threw, credentials
          // included; only the served copy is redacted.
          detail: sanitizeTrace(fault.detail ?? run.error ?? ""),
        });
      }
    }
  }

  return {
    window: opts.window,
    window_start: since,
    generated_at: until,
    waiting_on_you: {
      plan_approvals: cap(planApprovals),
      awaiting_merge: cap(awaitingMerge),
      blocked_tasks: cap(blockedTasks),
      blocked_scopes: cap(blockedScopes),
    },
    live: live.map((run) => ({
      id: run.id,
      kind: run.kind,
      model_id: run.model_id,
      scope_id: run.scope_id,
      task_id: run.task_id,
      started_at: run.started_at,
      last_progress_at: run.last_progress_at,
      active_tool: run.active_tool,
      stalled: isStalled(run, nowMs),
    })),
    metrics: {
      runs_by_kind_status: runsByKindStatus,
      merges: auditCounts.get(MERGE_ACTION) ?? 0,
      verdicts:
        (auditCounts.get(VERDICT_APPROVED_ACTION) ?? 0) +
        (auditCounts.get(VERDICT_CHANGES_ACTION) ?? 0),
      per_model: perModelMetrics(windowRuns),
      faults_by_layer: faultsByLayer,
      faults_by_layer_code: faultsByLayerCode,
      restart_incidents: {
        incidents: restartBuckets.size,
        reaped_runs: reapedRuns,
      },
      validation: {
        pass: auditCounts.get(VALIDATION_PASS_ACTION) ?? 0,
        fail: auditCounts.get(VALIDATION_FAIL_ACTION) ?? 0,
      },
    },
    unclassified: cap(unclassified.slice().reverse()),
    deploy: {
      version: opts.version ?? process.env["COLONY_VERSION"] ?? "unknown",
      started_at: (opts.startedAt ?? processStart()).toISOString(),
      restart_incidents: {
        incidents: restartBuckets.size,
        reaped_runs: reapedRuns,
      },
    },
  };
}

function isStalled(run: Run, nowMs: number): boolean {
  const progressMs = Date.parse(run.last_progress_at ?? run.started_at);
  if (Number.isNaN(progressMs)) return false;
  const leaseMs = Date.parse(run.lease_expires_at) - Date.parse(run.started_at);
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) return false;
  return nowMs - progressMs > leaseMs * STALL_LEASE_MULTIPLIER;
}

function cap<T>(rows: readonly T[]): T[] {
  return rows.length > LIST_CAP ? rows.slice(0, LIST_CAP) : [...rows];
}

/** This process's boot instant, for `deploy.started_at`. */
function processStart(): Date {
  return new Date(Date.now() - Math.floor(process.uptime() * 1000));
}

function perModelMetrics(runs: readonly Run[]): Record<string, ModelMetrics> {
  const durations = new Map<string, number[]>();
  const counters = new Map<
    string,
    { runs: number; succeeded: number; failed: number; timeouts: number }
  >();
  for (const run of runs) {
    const model = run.model_id ?? "unknown";
    const counter = counters.get(model) ?? {
      runs: 0,
      succeeded: 0,
      failed: 0,
      timeouts: 0,
    };
    counter.runs += 1;
    if (run.status === "succeeded") counter.succeeded += 1;
    if (run.status === "failed") counter.failed += 1;
    // Deliberate deviation from objective D's literal 'timeout_no_envelope':
    // isTimeoutFault is the one predicate that decides timeouts everywhere
    // else in colonyd, and it covers wall_timeout/timeout_no_envelope/
    // timeout_without_envelope — the last of which the fault backfill maps
    // onto wall_timeout (packages/core/src/fault.ts). Its code set is
    // module-private and must not be duplicated here.
    if (isTimeoutFault(run)) counter.timeouts += 1;
    counters.set(model, counter);

    if (run.finished_at) {
      const ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
      if (Number.isFinite(ms) && ms >= 0) {
        const sample = durations.get(model) ?? [];
        sample.push(ms);
        durations.set(model, sample);
      }
    }
  }
  const out: Record<string, ModelMetrics> = {};
  for (const model of [...counters.keys()].sort()) {
    const counter = counters.get(model)!;
    const sample = (durations.get(model) ?? []).slice().sort((a, b) => a - b);
    out[model] = {
      runs: counter.runs,
      succeeded: counter.succeeded,
      failed: counter.failed,
      timeouts: counter.timeouts,
      completion_rate:
        counter.runs === 0 ? 0 : counter.succeeded / counter.runs,
      median_ms: percentileAt(sample, 0.5),
      p90_ms: percentileAt(sample, 0.9),
    };
  }
  return out;
}
