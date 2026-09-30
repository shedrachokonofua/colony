import {
  MAX_MAIN_PIPELINE_REPAIRS,
  TERMINAL_TASK_STATES,
  classifyMainPipeline,
  mainPipelineRepairOf,
  type MainPipelineClassification,
} from "@colony/core";
import type { Scope } from "@colony/core";
import {
  sanitizeTrace,
  type ProviderPipelineJob,
  type ProviderRepoRef,
} from "@colony/provider";
import type { ColonydContext } from "./context.js";
import { SERVICE_ACTOR } from "./context.js";

/** Repair-task evidence bounds: the failing jobs that matter, their tails. */
const REPAIR_TRACE_JOBS = 3;
const REPAIR_TRACE_LINES = 80;

/** Last provider call per scope: the watch is bounded, never poll-per-tick. */
const lastPollAt = new Map<string, number>();

/**
 * When colonyd first read each scope's head and found no pipeline. GitLab
 * creates a merge commit's pipeline a moment after the merge, and the watch
 * runs in the very tick that observes the merge: a missing pipeline is
 * "not created yet" until the head has gone without one for the grace
 * window, and only then "this repo has no CI for it". The commit's own
 * timestamp cannot be the clock — a fast-forward merge keeps the author's.
 * In memory: a restart only restarts the wait.
 */
const pipelineMissingSince = new Map<
  string,
  { readonly sha: string; readonly since: number }
>();

export interface MainPipelineObservation {
  readonly sha: string;
  readonly classification: MainPipelineClassification;
  /** The jobs the classification was derived from, pipeline order. */
  readonly jobs: readonly ProviderPipelineJob[];
}

export type MainPipelineGateDecision =
  | { readonly kind: "proceed" }
  /** The verdict is not in yet (or the provider could not answer): run
   *  validation again later, with no run row and no attempt spent. */
  | { readonly kind: "defer" }
  /** The scope was blocked for the operator; the reason names what to do. */
  | { readonly kind: "blocked"; readonly reason: string };

/** What the repair decision did, so the gate can map it to its verdict. */
type RepairDecision =
  | { readonly outcome: "repair_open" }
  | { readonly outcome: "repair_filed"; readonly task_id: string }
  | { readonly outcome: "blocked"; readonly reason: string }
  /** The provider failed transiently while gathering evidence; retry later. */
  | { readonly outcome: "deferred" };

/**
 * Phase: watch the default-branch pipeline of every scope that has landed a
 * merge, and act on what it says. Bounded twice: one provider pass per scope
 * per interval, and no job re-listing while the head and its settled verdict
 * stand. Classification changes are audited (`delivery.main_status`), polls
 * are not.
 */
export async function watchMainPipelines(
  ctx: ColonydContext,
  now: Date,
): Promise<void> {
  for (const scope of ctx.store.listScopes()) {
    if (ctx.draining.isDraining()) return;
    if (scope.status !== "active" && scope.status !== "validating") continue;
    if (
      !ctx.store.listTasks(scope.id).some((task) => task.state === "merged")
    ) {
      continue;
    }
    const last = lastPollAt.get(scope.id);
    if (
      last !== undefined &&
      now.getTime() - last < (ctx.env.mainWatchIntervalMs ?? 60_000)
    ) {
      continue;
    }
    lastPollAt.set(scope.id, now.getTime());

    let head: string;
    try {
      head = (
        await ctx.provider.commits.get(repoOf(scope), scope.default_branch)
      ).sha;
    } catch (error) {
      auditUnreachable(ctx, scope, "main_watch_head", error);
      continue;
    }
    const persisted = ctx.store.getMainCheck(scope.id);
    // A settled verdict for this exact head stands: only a new head (or a
    // verdict still in flight) is worth re-listing jobs for.
    if (
      persisted &&
      persisted.sha === head &&
      persisted.classification !== "running"
    ) {
      continue;
    }

    const observed = await classifyHead(ctx, scope, head);
    if (!observed) continue;
    if (observed.classification.kind === "failed_script") {
      // Evidence is provider-backed: a transient read failure retries the
      // whole pass later, it never files a repair on partial facts. The
      // claim is recorded (classification, audit) only once facts are whole.
      const decision = await fileMainRepairOrBlock(ctx, scope, head, observed);
      if (decision.outcome === "deferred") continue;
    }
    const { previous } = ctx.store.recordMainCheck({
      scope_id: scope.id,
      sha: head,
      classification: observed.classification.kind,
      job_names: jobNamesOf(observed.classification),
    });
    if (
      previous &&
      previous.sha === head &&
      previous.classification === observed.classification.kind
    ) {
      continue;
    }
    ctx.store.audit(SERVICE_ACTOR, "delivery.main_status", {
      scope_id: scope.id,
      detail: {
        sha: head,
        classification: observed.classification.kind,
        job_names: jobNamesOf(observed.classification),
        previous: previous
          ? {
              sha: previous.sha,
              classification: previous.classification,
            }
          : null,
      },
    });
  }
}

/**
 * Validation gate: classify the default-branch HEAD pipeline fresh and let
 * validation start only behind a quiet pipeline. Runs before any validate
 * run row exists, so a deferred or blocked start costs nothing — and covers
 * every dispatch site, including POST /scopes/:id/unblock's direct call.
 */
export async function mainPipelineValidationGate(
  ctx: ColonydContext,
  scope: Scope,
): Promise<MainPipelineGateDecision> {
  let head: string;
  let observed: {
    classification: MainPipelineClassification;
    jobs: readonly ProviderPipelineJob[];
  };
  try {
    head = (await ctx.provider.commits.get(repoOf(scope), scope.default_branch))
      .sha;
    const read = await classifyHead(ctx, scope, head);
    if (!read) return { kind: "defer" };
    observed = read;
  } catch (error) {
    auditUnreachable(ctx, scope, "main_gate", error);
    return { kind: "defer" };
  }
  switch (observed.classification.kind) {
    case "none":
    case "success":
    case "canceled":
      return { kind: "proceed" };
    case "running":
      return { kind: "defer" };
    case "failed_script": {
      // The repair — or the operator block behind an exhausted streak — is
      // filed here as it would be by the watch: either way validation waits.
      const decision = await fileMainRepairOrBlock(ctx, scope, head, observed);
      return decision.outcome === "blocked"
        ? { kind: "blocked", reason: decision.reason }
        : { kind: "defer" };
    }
    case "failed_infra":
    case "awaiting_manual": {
      const reason = operatorReason(head, scope, observed.classification);
      blockForOperator(ctx, scope, reason);
      return { kind: "blocked", reason };
    }
  }
}

/** The job names a classification carries for operator surfaces. */
function jobNamesOf(
  classification: MainPipelineClassification,
): readonly string[] {
  switch (classification.kind) {
    case "failed_script":
    case "failed_infra":
      return classification.failed_jobs;
    case "awaiting_manual":
      return [...classification.manual_jobs, ...classification.waiting_jobs];
    default:
      return [];
  }
}

function repoOf(scope: Scope): ProviderRepoRef {
  return {
    id: scope.provider_repo_id,
    path: scope.provider_repo_path,
  };
}

/** Read the head's pipeline and classify it. Null when the provider could
 *  not answer (audited): nothing is decided from silence. A head without a
 *  pipeline reads as `running` until the grace window has passed. */
async function classifyHead(
  ctx: ColonydContext,
  scope: Scope,
  sha: string,
): Promise<MainPipelineObservation | null> {
  try {
    const repo = repoOf(scope);
    let status: string | null;
    let jobs: readonly ProviderPipelineJob[] = [];
    try {
      const pipeline = await ctx.provider.pipelines.getStatus(repo, sha);
      status = pipeline.status;
      jobs = await ctx.provider.pipelines.listAllJobs(repo, pipeline.id);
    } catch (error) {
      if (isPipelineNotFound(error)) {
        status = null;
      } else {
        throw error;
      }
    }
    const classification = classifyMainPipeline(status, jobs);
    return {
      sha,
      classification: withinCreationGrace(ctx, scope, sha, classification)
        ? { kind: "running" }
        : classification,
      jobs,
    };
  } catch (error) {
    auditUnreachable(ctx, scope, "main_pipeline", error);
    return null;
  }
}

/** True while a pipeline-less head may still be waiting for its pipeline. */
function withinCreationGrace(
  ctx: ColonydContext,
  scope: Scope,
  sha: string,
  classification: MainPipelineClassification,
): boolean {
  if (classification.kind !== "none") {
    pipelineMissingSince.delete(scope.id);
    return false;
  }
  const now = Date.now();
  const seen = pipelineMissingSince.get(scope.id);
  if (!seen || seen.sha !== sha) {
    pipelineMissingSince.set(scope.id, { sha, since: now });
  }
  const since = pipelineMissingSince.get(scope.id)!.since;
  return now - since < (ctx.env.mainPipelineGraceMs ?? 300_000);
}

/**
 * File the one repair task a red default branch earns, or stop and hand the
 * scope to the operator. Idempotent per head: an open repair holds the line,
 * a head whose repair already came and went (or two merged repairs with no
 * green in between) blocks instead of looping.
 */
async function fileMainRepairOrBlock(
  ctx: ColonydContext,
  scope: Scope,
  sha: string,
  observed: {
    readonly classification: MainPipelineClassification;
    readonly jobs: readonly ProviderPipelineJob[];
  },
): Promise<RepairDecision> {
  const failed =
    observed.classification.kind === "failed_script"
      ? observed.classification
      : {
          kind: "failed_script" as const,
          failed_jobs: [] as readonly string[],
        };
  const sha7 = sha.slice(0, 7);
  const names =
    failed.failed_jobs.length > 0 ? failed.failed_jobs.join(", ") : "pipeline";
  const tasks = ctx.store.listTasks(scope.id);
  if (
    tasks.some(
      (task) =>
        mainPipelineRepairOf(task) !== null &&
        !TERMINAL_TASK_STATES.has(task.state),
    )
  ) {
    return { outcome: "repair_open" };
  }
  if (tasks.some((task) => mainPipelineRepairOf(task) === sha7)) {
    return {
      outcome: "blocked",
      ...blockForOperator(
        ctx,
        scope,
        `main pipeline ${sha7} still fails CI job(s) ${names} after its repair task; fix CI on ${scope.default_branch}, then unblock the scope`,
      ),
    };
  }
  const streak = ctx.store.mainRepairStreak(scope.id);
  if (streak >= MAX_MAIN_PIPELINE_REPAIRS) {
    return {
      outcome: "blocked",
      ...blockForOperator(
        ctx,
        scope,
        `main pipeline ${sha7} fails CI job(s) ${names} and ${streak} repair tasks have merged without a green pipeline; fix CI on ${scope.default_branch}, then unblock the scope`,
      ),
    };
  }
  const evidence = await repairEvidence(ctx, scope, observed.jobs);
  if (evidence === null) return { outcome: "deferred" };
  const task = ctx.store.addTask(
    scope.id,
    {
      title: `Main pipeline repair for ${sha7}: ${names}`,
      spec: repairSpec(scope, sha, names, evidence),
      depends_on: [],
    },
    SERVICE_ACTOR,
    { main_pipeline_repair_for: sha, failed_jobs: failed.failed_jobs },
  );
  ctx.store.audit(SERVICE_ACTOR, "delivery.main_repair_filed", {
    scope_id: scope.id,
    task_id: task.id,
    detail: { sha, failed_jobs: failed.failed_jobs },
  });
  // The repair runs before anything else the scope holds, and it can only
  // run from `active`: a validating scope goes back to work and re-reaches
  // validation — with a fresh gate check — once the repair lands.
  const current = ctx.store.getScope(scope.id);
  if (current?.status === "validating") {
    ctx.store.setScopeStatus(scope.id, "active", SERVICE_ACTOR, {
      reason: "main pipeline repair filed",
    });
  }
  return { outcome: "repair_filed", task_id: task.id };
}

function blockForOperator(
  ctx: ColonydContext,
  scope: Scope,
  reason: string,
): { reason: string } {
  // Concurrent gate callers (the tick's dispatch and a requestTick fired by
  // an unblock) may both block; the first write owns the reason.
  if (ctx.store.getScope(scope.id)?.status === "blocked") return { reason };
  ctx.store.setScopeStatus(scope.id, "blocked", SERVICE_ACTOR, {
    blocked_reason: reason,
  });
  ctx.store.audit(SERVICE_ACTOR, "scope.human_required", {
    scope_id: scope.id,
    detail: { reason },
  });
  return { reason };
}

function operatorReason(
  sha: string,
  scope: Scope,
  classification: Extract<
    MainPipelineClassification,
    { kind: "failed_infra" | "awaiting_manual" }
  >,
): string {
  const sha7 = sha.slice(0, 7);
  if (classification.kind === "failed_infra") {
    const names =
      classification.failed_jobs.length > 0
        ? classification.failed_jobs.join(", ")
        : "pipeline";
    return `main pipeline ${sha7} failed on infrastructure (job(s) ${names}); retry those jobs or push the fix to ${scope.default_branch}, then unblock the scope`;
  }
  const manual =
    classification.manual_jobs.length > 0
      ? classification.manual_jobs.join(", ")
      : "its manual job(s)";
  const waiting =
    classification.waiting_jobs.length > 0
      ? ` (waiting: ${classification.waiting_jobs.join(", ")})`
      : "";
  return `main pipeline ${sha7} is waiting on manual job(s) ${manual}${waiting}; run them, then unblock the scope`;
}

/**
 * Sanitized trace tails of the blocking failures, bounded to the jobs that
 * matter. Null when a trace read fails transiently: evidence is gathered
 * whole or not at all.
 */
async function repairEvidence(
  ctx: ColonydContext,
  scope: Scope,
  jobs: readonly ProviderPipelineJob[],
): Promise<string[] | null> {
  const repo = repoOf(scope);
  const failed = jobs.filter(
    (job) => job.status === "failed" && job.allow_failure !== true,
  );
  const sections: string[] = [];
  for (const job of failed.slice(0, REPAIR_TRACE_JOBS)) {
    let text: string;
    try {
      const trace = await ctx.provider.pipelines.getTrace(repo, job.id);
      text = trace.text;
    } catch (error) {
      if (isMissingLog(error)) {
        text = "trace unavailable (not found)";
      } else {
        auditUnreachable(ctx, scope, "repair_evidence", error);
        return null;
      }
    }
    const tail = sanitizeTrace(text)
      .split("\n")
      .slice(-REPAIR_TRACE_LINES)
      .map((line) => `    ${line}`);
    sections.push(`### ${job.name}`, ...tail);
  }
  return sections;
}

function repairSpec(
  scope: Scope,
  sha: string,
  names: string,
  evidence: readonly string[],
): string {
  return [
    "## Goal",
    `The default branch \`${scope.default_branch}\` at \`${sha}\` fails CI job(s) ${names}. Fix the cause on the default branch: the pipeline must be green at the merge that carries the fix.`,
    "",
    "## Failure evidence",
    ...(evidence.length > 0 ? evidence : ["(no job trace available)"]),
    "",
    "## Required evidence",
    "- The job passes on the task branch pipeline.",
    "",
    "## Invariants",
    "- Change only what the failure needs.",
  ].join("\n");
}

function isPipelineNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    (error as { status: unknown }).status === 404 &&
    "body" in error &&
    (error as { body: unknown }).body === "pipeline_not_found"
  );
}

function isMissingLog(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  if ("status" in error && (error as { status: unknown }).status === 404) {
    return true;
  }
  return error instanceof Error && /\b404\b|not found/i.test(error.message);
}

function auditUnreachable(
  ctx: ColonydContext,
  scope: Scope,
  stage: string,
  error: unknown,
): void {
  ctx.store.audit(SERVICE_ACTOR, "provider.unreachable", {
    scope_id: scope.id,
    detail: {
      stage,
      error: error instanceof Error ? error.message : String(error),
    },
  });
}
