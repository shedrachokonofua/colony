export interface CostPrediction {
  predicted_ms: number;
  budget_ms: number;
  files_touched: number;
  model_version: string;
  flagged: boolean;
  sample_size: number;
}

export interface TaskWithCostPrediction {
  cost_prediction_json?: string | null;
}

export function parseCostPrediction(
  task: TaskWithCostPrediction,
): CostPrediction | null;

export function costPredictionLines(prediction: CostPrediction): string[];
