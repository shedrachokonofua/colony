import { describe, expect, it } from "vitest";
import {
  RECONCILE_INTERVAL,
  reconcileActivityIdempotencyKey,
  supervisorWorkflowId,
} from "./index.js";

describe("@colony/workflows reconciliation timer helpers", () => {
  it("uses the Phase 3 periodic reconciliation cadence", () => {
    expect(RECONCILE_INTERVAL).toBe("5 minutes");
  });

  it("builds deterministic reconcile activity idempotency keys", () => {
    expect(
      reconcileActivityIdempotencyKey({
        scope_id: "col-phase3",
        workflow_id: supervisorWorkflowId("col-phase3"),
        run_id: "run-1",
        sequence: 7,
      }),
    ).toBe("supervisor-col-phase3:run-1:reconcile:col-phase3:7");
  });
});
