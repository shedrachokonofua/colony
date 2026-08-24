import type { TaskCostModelV1 } from "@colony/schemas";
import type { Run } from "./store.js";

/** Mirrors the `developer` ceiling `timeoutMs` in @colony/config; core does
 *  not depend on @colony/config, so the value is pinned here. */
export const DEFAULT_IMPLEMENTER_BUDGET_MS = 900_000;

const MODEL_VERSION = "v1";

export interface TaskCostPrediction {
  predicted_ms: number;
  budget_ms: number;
  files_touched: number;
  model_version: "v1";
  flagged: boolean;
  sample_size: number;
  inputs: { files: string[] };
}

/**
 * Median of `values`; for an even count the mean of the two middle values.
 * Returns 0 for empty input — a zero-history database must never flag.
 */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface MergeGateEvidence {
  reason?: unknown;
  head_sha?: unknown;
  files_changed?: unknown;
}

/**
 * Offline per-task session-cost model from the runs table alone.
 *
 * Two run rows describe one landed attempt and are joined by `task_id`:
 *  - a succeeded `merge_gate` row contributes only its evidence
 *    `files_changed` list (`started_at`/`finished_at` span the deterministic
 *    gate step, never the agent session);
 *  - a succeeded `implement` row with non-null `task_id`/`finished_at`
 *    contributes only the session wall-clock.
 *
 * A sample exists only where both halves meet for the same task. A task that
 * landed after several attempts yields one sample per succeeded implement
 * run — per-attempt cost is exactly what gets predicted.
 */
export function buildTaskCostModel(runs: readonly Run[]): TaskCostModelV1 {
  const filesByTask = new Map<string, number>();
  for (const run of runs) {
    if (run.kind !== "merge_gate" || run.status !== "succeeded") continue;
    if (run.task_id === null) continue;
    let evidence: MergeGateEvidence;
    try {
      evidence = run.evidence_json
        ? (JSON.parse(run.evidence_json) as MergeGateEvidence)
        : {};
    } catch {
      continue;
    }
    if (
      evidence.reason !== "merge_accepted" ||
      !Array.isArray(evidence.files_changed)
    ) {
      continue;
    }
    const files = evidence.files_changed.filter(
      (f): f is string => typeof f === "string",
    ).length;
    // Several succeeded gates can exist per task (re-gating after a moved
    // head); any one of them describes the same change set.
    filesByTask.set(run.task_id, files);
  }

  const ratios: number[] = [];
  for (const run of runs) {
    if (run.kind !== "implement" || run.status !== "succeeded") continue;
    if (run.task_id === null || run.finished_at === null) continue;
    const files = filesByTask.get(run.task_id);
    if (files === undefined) continue;
    const durationMs = Date.parse(run.finished_at) - Date.parse(run.started_at);
    if (!Number.isFinite(durationMs) || durationMs <= 0) continue;
    ratios.push(durationMs / Math.max(1, files));
  }

  return {
    version: MODEL_VERSION,
    sample_size: ratios.length,
    ms_per_file: median(ratios),
  };
}

/**
 * Predict one implementer session from the offline model: wall-clock is
 * linear in the touched-file count extracted from the spec. `flagged` means
 * the prediction exceeds `budgetMs` — a signal to split the task, never a
 * gate; planning proceeds regardless.
 */
export function predictTaskCost(
  model: TaskCostModelV1,
  filePaths: readonly string[],
  budgetMs: number,
): TaskCostPrediction {
  const files = [...new Set(filePaths)];
  const predicted_ms = model.ms_per_file * files.length;
  return {
    predicted_ms,
    budget_ms: budgetMs,
    files_touched: files.length,
    model_version: MODEL_VERSION,
    flagged: predicted_ms > budgetMs,
    sample_size: model.sample_size,
    inputs: { files },
  };
}
