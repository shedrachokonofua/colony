import { describe, expect, it } from "bun:test";
import type { Run } from "@colony/core";
import {
  consecutiveImplementationFailures,
  isDeferredRunFailure,
} from "../src/run-classification.js";

function run(
  overrides: Partial<
    Pick<Run, "kind" | "status" | "error" | "fault_json">
  > = {},
): Run {
  return {
    kind: "implement",
    status: "failed",
    error: null,
    fault_json: null,
    ...overrides,
  } as unknown as Run;
}

const fault = (layer: string, code = "test") => JSON.stringify({ layer, code });

describe("run failure classification", () => {
  it("uses valid structured faults before legacy error text", () => {
    expect(
      isDeferredRunFailure(
        run({
          fault_json: fault("model", "syntax_error"),
          error: "workspace_lost",
        }),
      ),
    ).toBe(false);
    expect(
      isDeferredRunFailure(
        run({
          fault_json: fault("provider", "connection"),
          error: "submission_rejected: invalid envelope",
        }),
      ),
    ).toBe(true);
    for (const layer of ["harness", "sandbox", "colonyd"]) {
      expect(
        isDeferredRunFailure(
          run({
            fault_json: fault(layer),
            error: "model quality failure",
          }),
        ),
      ).toBe(true);
    }
    expect(
      isDeferredRunFailure(
        run({
          fault_json: fault("unknown"),
          error: "lease_expired",
        }),
      ),
    ).toBe(true);
    expect(
      isDeferredRunFailure(
        run({
          fault_json: '{"layer":"model"}',
          error: "provider_protocol_failure: invalid tool protocol",
        }),
      ),
    ).toBe(false);
  });

  it("defers lease expiry and provider connection failures without freeing model failures", () => {
    expect(isDeferredRunFailure(run({ error: "lease_expired" }))).toBe(true);
    expect(
      isDeferredRunFailure(
        run({ error: "provider_connection_failure: upstream unavailable" }),
      ),
    ).toBe(true);
    expect(isDeferredRunFailure(run({ error: "model quality failure" }))).toBe(
      false,
    );
    expect(
      isDeferredRunFailure(run({ error: "provider_protocol_failure: 400" })),
    ).toBe(false);
  });

  it("counts only real implementation failures across a chronological history", () => {
    expect(
      consecutiveImplementationFailures([
        run({ error: "repair_no_change" }),
        run({ error: "sandbox_quota_exhausted: full" }),
        run({ status: "canceled", error: "aborted" }),
        run({ kind: "architect", error: "bad plan" }),
        run({
          fault_json: fault("provider", "connection"),
          error: "provider down",
        }),
        run({ error: "envelope invalid" }),
      ]),
    ).toBe(2);
  });

  it("resets at a successful implementation and does not share state between histories", () => {
    expect(
      consecutiveImplementationFailures([
        run({ error: "first" }),
        run({ status: "succeeded" }),
        run({ error: "second" }),
      ]),
    ).toBe(1);
    expect(consecutiveImplementationFailures([run({ error: "one" })])).toBe(1);
    expect(
      consecutiveImplementationFailures([run({ status: "succeeded" })]),
    ).toBe(0);
  });

  it("preserves quota deferral and ignores canceled or non-failed runs", () => {
    expect(
      isDeferredRunFailure(
        run({ status: "canceled", error: "sandbox_quota_exhausted: full" }),
      ),
    ).toBe(false);
    expect(
      consecutiveImplementationFailures([
        run({ status: "running" }),
        run({ status: "canceled", error: "model failure" }),
        run({ error: "sandbox_quota_exhausted: full" }),
      ]),
    ).toBe(0);
  });
});
