/**
 * Classification of the default branch's CI pipeline — the fact the main
 * pipeline watch persists and acts on after task merges land. Pure: it maps
 * (pipeline status, jobs) to one verdict with no I/O and no clock.
 *
 * Precedence, resolved from the rules' essentials (a doomed pipeline is
 * `failed` even while sibling jobs still run; jobs created behind a manual
 * job are "waiting", not "running"):
 *
 *   1. no pipeline for the SHA                       -> none
 *   2. a job failed with allow_failure=false         -> failed_script|failed_infra
 *      (a failed pipeline with no failed job counts as unknown -> failed_script)
 *   3. the pipeline stopped (canceled)               -> canceled
 *   4. a manual action gates completion              -> awaiting_manual
 *   5. work still in flight                          -> running
 *   6. everything non-manual finished                -> success
 *
 * Job order matters for "waiting behind a manual job": stages are ordered by
 * first appearance in `jobs`, so callers hand the jobs in pipeline order
 * (the GitLab adapter sorts by job id, the creation order).
 */

/** One pipeline job as the classifier needs it. `ProviderPipelineJob` from
 *  @colony/provider is structurally assignable to this. */
export interface MainPipelineJobFact {
  readonly name: string;
  readonly status: string;
  readonly stage?: string;
  readonly allow_failure?: boolean;
  readonly failure_reason?: string;
}

export type MainPipelineClassification =
  /** No pipeline exists for the SHA (provider 404 `pipeline_not_found`). */
  | { readonly kind: "none" }
  /** The pipeline cannot have settled yet; decide again when it does. */
  | { readonly kind: "running" }
  /** A blocking job failed on the change itself (or with unknown cause). */
  | { readonly kind: "failed_script"; readonly failed_jobs: readonly string[] }
  /** Every blocking failure is infrastructure: retry, do not repair code. */
  | { readonly kind: "failed_infra"; readonly failed_jobs: readonly string[] }
  /** The pipeline cannot finish without an operator running a manual job. */
  | {
      readonly kind: "awaiting_manual";
      readonly manual_jobs: readonly string[];
      readonly waiting_jobs: readonly string[];
    }
  /** Everything non-manual finished; trailing manual jobs do not block. */
  | { readonly kind: "success" }
  /** The pipeline was canceled with no blocking failure. */
  | { readonly kind: "canceled" };

/** The verdict word persisted per scope and surfaced to operators. */
export type MainPipelineClassificationKind = MainPipelineClassification["kind"];

/** GitLab failure reasons that are infrastructure, not the change under
 *  test. Anything absent or unrecognized stays with the code (failed_script):
 *  a repair task may waste an implementer's time, an infra verdict hides a
 *  real regression forever. */
const INFRA_FAILURE_REASONS: Record<string, true> = {
  runner_system_failure: true,
  stuck_or_timeout_failure: true,
  api_failure: true,
  scheduler_failure: true,
  data_integrity_failure: true,
  runner_unsupported: true,
  job_execution_timeout: true,
  archived_failure: true,
  unmet_prerequisites: true,
  stale_schedule: true,
  forward_deployment_failure: true,
  foreign_environment_failure: true,
  integrations_failure: true,
};

/** Pipeline statuses that mean "not settled yet". `manual`/`blocked` are
 *  settled on the running axis: they wait on a human, not on the runner. */
const NON_TERMINAL_PIPELINE_STATUSES: Record<string, true> = {
  created: true,
  pending: true,
  running: true,
  preparing: true,
  waiting_for_resource: true,
  scheduled: true,
};

/** Job statuses that mean the job has not finished (or not started). */
const NON_TERMINAL_JOB_STATUSES: Record<string, true> = {
  created: true,
  pending: true,
  running: true,
  preparing: true,
  waiting_for_resource: true,
  scheduled: true,
};

/** Job statuses that mean "queued behind something", as opposed to actively
 *  executing: a manual job blocks exactly these, never a running one. */
const WAITING_JOB_STATUSES: Record<string, true> = {
  created: true,
  pending: true,
  scheduled: true,
  waiting_for_resource: true,
};

/** Every pipeline status the classifier knows by name. Anything else waits
 *  for the provider to name it rather than guessing a verdict. */
const KNOWN_PIPELINE_STATUSES: Record<string, true> = {
  created: true,
  pending: true,
  running: true,
  preparing: true,
  waiting_for_resource: true,
  scheduled: true,
  success: true,
  skipped: true,
  failed: true,
  canceled: true,
  manual: true,
  blocked: true,
};

/**
 * Classify a default-branch pipeline from its status and full job list.
 * `pipelineStatus` is null when the provider reports no pipeline for the
 * SHA (404 `pipeline_not_found`).
 */
export function classifyMainPipeline(
  pipelineStatus: string | null,
  jobs: readonly MainPipelineJobFact[],
): MainPipelineClassification {
  if (pipelineStatus === null) return { kind: "none" };

  // 1. A blocking failure is a verdict on the pipeline no matter what its
  //    siblings or the aggregate status still say: it cannot recover.
  const blockingFailed = jobs.filter(
    (job) => job.status === "failed" && job.allow_failure !== true,
  );
  if (blockingFailed.length > 0) {
    const failed_jobs = blockingFailed.map((job) => job.name);
    const allInfra = blockingFailed.every(
      (job) => INFRA_FAILURE_REASONS[job.failure_reason ?? ""] === true,
    );
    return allInfra
      ? { kind: "failed_infra", failed_jobs }
      : { kind: "failed_script", failed_jobs };
  }
  if (pipelineStatus === "failed") {
    // Failed with no failed job left to name (an upstream stage failure, a
    // job beyond the listing page): the change is still the suspect.
    return {
      kind: "failed_script",
      failed_jobs: jobs
        .filter((job) => job.status === "failed")
        .map((job) => job.name),
    };
  }

  // 2. Canceled before any blocking failure: no verdict on the change.
  if (pipelineStatus === "canceled") return { kind: "canceled" };

  // 3. Manual action gates completion when a manual job has work queued
  //    behind it that can never start on its own. GitLab's aggregate
  //    `manual` status is no evidence of that: a rules-based `when: manual`
  //    job defaults to allow_failure=false, so a pipeline that deployed and
  //    smoked green still reads `manual` for its trailing optional
  //    deploy:production (Brief, pipeline 5989, 2026-09-30). The status
  //    decides only when there are no jobs to read.
  const manual = jobs.filter((job) => job.status === "manual");
  const waiting = waitingBehindManual(jobs, manual);
  const statusWaitsOnHuman =
    (pipelineStatus === "manual" || pipelineStatus === "blocked") &&
    jobs.length === 0;
  if (statusWaitsOnHuman || waiting.length > 0) {
    return {
      kind: "awaiting_manual",
      manual_jobs: gatingManual(jobs, manual, waiting).map((job) => job.name),
      waiting_jobs: waiting.map((job) => job.name),
    };
  }

  // 4. Work in flight settles on its own; so does a pipeline status the
  //    provider has not named yet. Decide again when either does.
  if (
    KNOWN_PIPELINE_STATUSES[pipelineStatus] !== true ||
    NON_TERMINAL_PIPELINE_STATUSES[pipelineStatus] === true ||
    jobs.some(
      (job) =>
        job.status !== "manual" &&
        NON_TERMINAL_JOB_STATUSES[job.status] === true,
    )
  ) {
    return { kind: "running" };
  }

  return { kind: "success" };
}

/** Stage order: first appearance in `jobs` (callers pass pipeline order). */
function stageOrderOf(
  jobs: readonly MainPipelineJobFact[],
): Map<string, number> {
  const stageOrder = new Map<string, number>();
  for (const job of jobs) {
    const stage = job.stage ?? "";
    if (!stageOrder.has(stage)) stageOrder.set(stage, stageOrder.size);
  }
  return stageOrder;
}

/**
 * Non-manual jobs queued in a stage after some manual job: they cannot start
 * until the operator runs it.
 */
function waitingBehindManual(
  jobs: readonly MainPipelineJobFact[],
  manual: readonly MainPipelineJobFact[],
): MainPipelineJobFact[] {
  if (manual.length === 0) return [];
  const stageOrder = stageOrderOf(jobs);
  return jobs.filter((job) => {
    if (job.status === "manual") return false;
    if (WAITING_JOB_STATUSES[job.status] !== true) return false;
    const jobStage = stageOrder.get(job.stage ?? "");
    if (jobStage === undefined) return false;
    return manual.some((m) => {
      const manualStage = stageOrder.get(m.stage ?? "");
      return manualStage !== undefined && jobStage > manualStage;
    });
  });
}

/**
 * The manual jobs an operator must run: those in a stage before some waiting
 * job. A manual job beside or after the waiting work (an optional
 * deploy:production) is not what holds it. Without waiting jobs to place,
 * every manual job is named.
 */
function gatingManual(
  jobs: readonly MainPipelineJobFact[],
  manual: readonly MainPipelineJobFact[],
  waiting: readonly MainPipelineJobFact[],
): MainPipelineJobFact[] {
  if (waiting.length === 0) return [...manual];
  const stageOrder = stageOrderOf(jobs);
  const lastWaiting = Math.max(
    ...waiting.map((job) => stageOrder.get(job.stage ?? "") ?? -1),
  );
  return manual.filter(
    (m) =>
      (stageOrder.get(m.stage ?? "") ?? Number.POSITIVE_INFINITY) < lastWaiting,
  );
}

/** Title prefix of the repair task the main watch files for a red default
 *  branch; recognizable the way review follow-ups are. */
export const MAIN_PIPELINE_REPAIR_PREFIX = "Main pipeline repair for ";

const MAIN_PIPELINE_REPAIR_TITLE =
  /^Main pipeline repair for ([0-9A-Za-z._-]+):/;

/** The head SHA (short form) a main-pipeline repair task was filed for, or
 *  null for any other task. */
export function mainPipelineRepairOf(task: {
  readonly title: string;
}): string | null {
  return MAIN_PIPELINE_REPAIR_TITLE.exec(task.title)?.[1] ?? null;
}

/** Main-pipeline repair tasks merged without a green pipeline in between
 *  before the watch stops filing and blocks the scope for the operator. */
export const MAX_MAIN_PIPELINE_REPAIRS = 2;
