import { describe, expect, it } from "bun:test";
import { costPredictionLines, parseCostPrediction } from "./cost-prediction.js";

const blob = {
  predicted_ms: 185_000,
  budget_ms: 600_000,
  files_touched: 3,
  model_version: "v1",
  flagged: true,
  sample_size: 12,
  inputs: { files: ["packages/console/app.js"] },
};

describe("parseCostPrediction", () => {
  it("returns null when the field is null or missing (pre-feature rows)", () => {
    expect(parseCostPrediction({ cost_prediction_json: null })).toBeNull();
    expect(parseCostPrediction({})).toBeNull();
    expect(parseCostPrediction({ cost_prediction_json: undefined })).toBeNull();
    expect(parseCostPrediction({ cost_prediction_json: "" })).toBeNull();
  });

  it("parses a well-formed v1 blob", () => {
    const prediction = parseCostPrediction({
      cost_prediction_json: JSON.stringify(blob),
    });
    expect(prediction).toEqual(blob);
  });

  it("returns null for malformed JSON", () => {
    expect(
      parseCostPrediction({ cost_prediction_json: "{not json" }),
    ).toBeNull();
  });

  it("rejects non-object JSON payloads", () => {
    expect(parseCostPrediction({ cost_prediction_json: "42" })).toBeNull();
    expect(parseCostPrediction({ cost_prediction_json: '"x"' })).toBeNull();
    expect(parseCostPrediction({ cost_prediction_json: "null" })).toBeNull();
  });

  it("rejects non-finite or wrongly typed numbers", () => {
    expect(
      parseCostPrediction({
        cost_prediction_json: JSON.stringify({ ...blob, files_touched: "3" }),
      }),
    ).toBeNull();
    expect(
      parseCostPrediction({
        cost_prediction_json: JSON.stringify(blob).replace("185000", "1e999"),
      }),
    ).toBeNull();
  });

  it("rejects a non-boolean flagged field", () => {
    expect(
      parseCostPrediction({
        cost_prediction_json: JSON.stringify({ ...blob, flagged: 1 }),
      }),
    ).toBeNull();
  });
});

describe("costPredictionLines", () => {
  it("formats duration via formatDuration and includes budget and file count", () => {
    const lines = costPredictionLines(blob);
    expect(lines.join("\n")).toContain("3m 05s");
    expect(lines.join("\n")).toContain("budget");
    expect(lines.join("\n")).toContain("10m 00s");
    expect(lines.join("\n")).toContain("3 files touched");
  });

  it("renders model version with sample size on the meta line", () => {
    const lines = costPredictionLines(blob);
    expect(lines[1]).toContain("model v1 · 12 samples");
  });

  it("singularizes one file", () => {
    const lines = costPredictionLines({ ...blob, files_touched: 1 });
    expect(lines[1]).toContain("1 file touched");
  });
});
