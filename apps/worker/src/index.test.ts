import { describe, expect, it } from "vitest";
import {
  claimReadyTask,
  readScopeState,
  recordWorkflowEvent,
} from "./activities.js";
import { supervisorWorkflowId } from "./workflows.js";

describe("@colony/worker", () => {
  it("exposes the supervisor workflow id helper", () => {
    expect(supervisorWorkflowId("col-test")).toBe("supervisor-col-test");
  });

  it("rejects invalid activity IDs before touching the database", async () => {
    await expect(readScopeState({ scope_id: "not-a-scope" })).resolves.toEqual({
      scope: null,
      tasks: [],
    });

    await expect(
      recordWorkflowEvent({
        scope_id: "not-a-scope",
        signal_seq: 1,
        signal: "provider_event",
        kind: "provider_event",
        workflow_id: "supervisor-not-a-scope",
        run_id: "run-1",
        payload: {},
      }),
    ).resolves.toEqual({ recorded: false, reason: "invalid_scope_id" });

    await expect(
      claimReadyTask({ scope_id: "not-a-scope", assignee: "agent:dev-1" }),
    ).resolves.toEqual({ claimed: false, reason: "invalid_scope_id" });
  });
});
