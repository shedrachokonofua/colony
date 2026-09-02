import { formatDuration } from "./duration.js";

/**
 * Task 1 stores JSON.stringify of a snake_case v1 blob in
 * tasks.cost_prediction_json. The console must not depend on @colony/schemas,
 * so the shape is re-validated here field by field; anything that fails is
 * treated as "no prediction" and renders nothing.
 */
/**
 * @param {import("./cost-prediction.d.ts").TaskWithCostPrediction} task
 */
export function parseCostPrediction(task) {
  const raw = task?.cost_prediction_json;
  if (raw == null || typeof raw !== "string" || raw === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const numbersOk = [
    "predicted_ms",
    "budget_ms",
    "files_touched",
    "sample_size",
  ].every(
    (key) => typeof parsed[key] === "number" && Number.isFinite(parsed[key]),
  );
  if (!numbersOk) return null;
  if (typeof parsed.flagged !== "boolean") return null;
  if (
    parsed.model_version !== undefined &&
    typeof parsed.model_version !== "string"
  ) {
    return null;
  }
  return parsed;
}

/**
 * @param {import("./cost-prediction.d.ts").CostPrediction} prediction
 */
export function costPredictionLines(prediction) {
  return [
    `predicted ${formatDuration(prediction.predicted_ms)} · budget ${formatDuration(prediction.budget_ms)}`,
    `${prediction.files_touched} file${prediction.files_touched === 1 ? "" : "s"} touched · model ${prediction.model_version ?? "v1"} · ${prediction.sample_size} samples`,
  ];
}
