import { describe, expect, it } from "bun:test";
import {
  classifyMainPipeline,
  mainPipelineRepairOf,
  type MainPipelineJobFact,
} from "./main-pipeline.js";

function job(
  name: string,
  status: string,
  extra: Partial<MainPipelineJobFact> = {},
): MainPipelineJobFact {
  return { name, status, ...extra };
}

describe("classifyMainPipeline", () => {
  it("none: no pipeline for the SHA", () => {
    expect(classifyMainPipeline(null, [])).toEqual({ kind: "none" });
  });

  it("running: a non-terminal pipeline status settles later", () => {
    for (const status of [
      "created",
      "pending",
      "running",
      "preparing",
      "waiting_for_resource",
      "scheduled",
    ]) {
      expect(classifyMainPipeline(status, [job("test", "running")])).toEqual({
        kind: "running",
      });
    }
  });

  it("running: a settled status with a job still in flight", () => {
    expect(
      classifyMainPipeline("success", [
        job("build", "success", { stage: "build" }),
        job("test", "running", { stage: "test" }),
      ]),
    ).toEqual({ kind: "running" });
  });

  it("failed_script: a job failed with script_failure", () => {
    expect(
      classifyMainPipeline("failed", [
        job("build", "success", { stage: "build" }),
        job("unit", "failed", {
          stage: "test",
          failure_reason: "script_failure",
        }),
      ]),
    ).toEqual({ kind: "failed_script", failed_jobs: ["unit"] });
  });

  it("failed_script: a missing or unrecognized failure_reason is the change's fault", () => {
    expect(
      classifyMainPipeline("failed", [
        job("unit", "failed", { stage: "test" }),
        job("lint", "failed", {
          stage: "test",
          failure_reason: "mystery_failure",
        }),
      ]),
    ).toEqual({ kind: "failed_script", failed_jobs: ["unit", "lint"] });
  });

  it("failed_infra: every blocking failure is infrastructure", () => {
    expect(
      classifyMainPipeline("failed", [
        job("unit", "failed", {
          stage: "test",
          failure_reason: "runner_system_failure",
        }),
        job("lint", "failed", {
          stage: "test",
          failure_reason: "stuck_or_timeout_failure",
        }),
      ]),
    ).toEqual({ kind: "failed_infra", failed_jobs: ["unit", "lint"] });
  });

  it("infra + script failures split to failed_script", () => {
    expect(
      classifyMainPipeline("failed", [
        job("unit", "failed", {
          stage: "test",
          failure_reason: "runner_system_failure",
        }),
        job("lint", "failed", {
          stage: "test",
          failure_reason: "script_failure",
        }),
      ]),
    ).toEqual({ kind: "failed_script", failed_jobs: ["unit", "lint"] });
  });

  it("an allowed-failure job does not fail the pipeline", () => {
    expect(
      classifyMainPipeline("success", [
        job("unit", "success", { stage: "test" }),
        job("flake", "failed", {
          stage: "test",
          allow_failure: true,
          failure_reason: "script_failure",
        }),
      ]),
    ).toEqual({ kind: "success" });
  });

  it("failed with no failed job still blames the change", () => {
    expect(classifyMainPipeline("failed", [])).toEqual({
      kind: "failed_script",
      failed_jobs: [],
    });
  });

  it("canceled: the pipeline stopped with no blocking failure", () => {
    expect(
      classifyMainPipeline("canceled", [
        job("unit", "canceled", { stage: "test" }),
        job("flake", "failed", { stage: "test", allow_failure: true }),
      ]),
    ).toEqual({ kind: "canceled" });
  });

  it("a blocking failure outranks a canceled pipeline", () => {
    expect(
      classifyMainPipeline("canceled", [
        job("unit", "failed", {
          stage: "test",
          failure_reason: "script_failure",
        }),
      ]),
    ).toEqual({ kind: "failed_script", failed_jobs: ["unit"] });
  });

  it("awaiting_manual: work waits behind the manual job", () => {
    expect(
      classifyMainPipeline("manual", [
        job("build", "success", { stage: "build" }),
        job("apply", "manual", { stage: "apply", allow_failure: false }),
        job("verify", "created", { stage: "verify" }),
      ]),
    ).toEqual({
      kind: "awaiting_manual",
      manual_jobs: ["apply"],
      waiting_jobs: ["verify"],
    });
  });

  it("success: a blocking trailing manual job with nothing behind it does not gate delivery", () => {
    // Brief pipeline 5989 (2026-09-30): applied, deployed and smoked green;
    // only the optional deploy:production is left. A rules-based manual job
    // defaults to allow_failure=false, so GitLab reports the pipeline
    // `manual` — which must not read as waiting on the operator.
    expect(
      classifyMainPipeline("manual", [
        job("build", "success", { stage: "build" }),
        job("apply", "success", { stage: "apply", allow_failure: false }),
        job("deploy:api", "success", { stage: "deploy" }),
        job("smoke:staging", "success", { stage: "deploy" }),
        job("deploy:production", "manual", {
          stage: "deploy",
          allow_failure: false,
        }),
      ]),
    ).toEqual({ kind: "success" });
  });

  it("awaiting_manual names only the manual job the waiting work sits behind", () => {
    // The same pipeline before its apply: deploy:production sits beside the
    // waiting deploy jobs, so only `apply` is the operator's to run.
    expect(
      classifyMainPipeline("manual", [
        job("build", "success", { stage: "build" }),
        job("apply", "manual", { stage: "apply", allow_failure: false }),
        job("deploy:api", "created", { stage: "deploy" }),
        job("smoke:staging", "created", { stage: "deploy" }),
        job("deploy:production", "manual", {
          stage: "deploy",
          allow_failure: false,
        }),
      ]),
    ).toEqual({
      kind: "awaiting_manual",
      manual_jobs: ["apply"],
      waiting_jobs: ["deploy:api", "smoke:staging"],
    });
  });

  it("awaiting_manual: a manual pipeline whose jobs cannot be read still waits on the operator", () => {
    expect(classifyMainPipeline("manual", [])).toEqual({
      kind: "awaiting_manual",
      manual_jobs: [],
      waiting_jobs: [],
    });
  });

  it("success: trailing manual jobs with nothing waiting do not block", () => {
    expect(
      classifyMainPipeline("success", [
        job("build", "success", { stage: "build" }),
        job("deploy:production", "manual", {
          stage: "deploy",
          allow_failure: true,
        }),
      ]),
    ).toEqual({ kind: "success" });
  });

  it("running: a created job in an earlier stage is in flight, not waiting behind", () => {
    expect(
      classifyMainPipeline("running", [
        job("build", "created", { stage: "build" }),
        job("apply", "manual", { stage: "apply", allow_failure: false }),
      ]),
    ).toEqual({ kind: "running" });
  });

  it("running: a job still executing outranks nothing-waits manual", () => {
    expect(
      classifyMainPipeline("running", [
        job("build", "running", { stage: "build" }),
        job("apply", "manual", { stage: "apply", allow_failure: false }),
      ]),
    ).toEqual({ kind: "running" });
  });

  it("a doomed pipeline is failed while siblings still run", () => {
    expect(
      classifyMainPipeline("running", [
        job("unit", "failed", {
          stage: "test",
          failure_reason: "script_failure",
        }),
        job("lint", "running", { stage: "lint" }),
      ]),
    ).toEqual({ kind: "failed_script", failed_jobs: ["unit"] });
  });

  it("an unnamed pipeline status decides again later", () => {
    expect(
      classifyMainPipeline("unknown", [
        job("unit", "success", { stage: "test" }),
      ]),
    ).toEqual({ kind: "running" });
  });
});

describe("mainPipelineRepairOf", () => {
  it("recognizes a repair title by its head", () => {
    expect(
      mainPipelineRepairOf({
        title: "Main pipeline repair for abc1234: unit, lint",
      }),
    ).toBe("abc1234");
  });

  it("is null for any other task", () => {
    expect(mainPipelineRepairOf({ title: "Add the export endpoint" })).toBe(
      null,
    );
    expect(
      mainPipelineRepairOf({
        title: "Review follow-up for col-x.1: Add the export endpoint",
      }),
    ).toBe(null);
  });
});
