import { describe, expect, it } from "vitest";

import {
  SCOPE_STATES,
  SCOPE_TRANSITIONS,
  TASK_STATES,
  TASK_TRANSITIONS,
  assertScopeTransition,
  assertTaskTransition,
  canTransitionScope,
  canTransitionTask,
  checkScopeTransition,
  checkTaskTransition,
  type ScopeState,
  type TaskState,
} from "./state-machines.js";
import { ROLES } from "./actors.js";

describe("scope state machine", () => {
  it("includes the design.md forward path", () => {
    const path: ReadonlyArray<[ScopeState, ScopeState]> = [
      ["draft", "decomposition_proposed"],
      ["decomposition_proposed", "decomposition_approved"],
      ["decomposition_approved", "active"],
      ["active", "scope_review_requested"],
      ["scope_review_requested", "scope_review_approved"],
      ["scope_review_approved", "closed"],
    ];
    for (const [from, to] of path) {
      expect(canTransitionScope(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it("rejects skipping decomposition approval", () => {
    const r = checkScopeTransition("draft", "active");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("INVALID_SCOPE_TRANSITION");
    expect(r.error?.details).toMatchObject({ from: "draft", to: "active" });
    expect(r.error?.retriable).toBe(false);
  });

  it("rejects transitions out of closed", () => {
    const r = checkScopeTransition("closed", "active");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("TERMINAL_STATE");
  });

  it("rejects unknown source state with structured error", () => {
    const r = checkScopeTransition("nonsense", "draft");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("UNKNOWN_SCOPE_STATE");
    expect(r.error?.message).toContain("nonsense");
  });

  it("allows entering branch states from non-terminal scope states", () => {
    expect(canTransitionScope("active", "blocked")).toBe(true);
    expect(canTransitionScope("draft", "canceled")).toBe(true);
    expect(canTransitionScope("decomposition_proposed", "conflict")).toBe(true);
  });

  it("allows recovery from blocked back to a non-branch state", () => {
    expect(canTransitionScope("blocked", "active")).toBe(true);
    expect(canTransitionScope("conflict", "draft")).toBe(true);
  });

  it("assertScopeTransition throws DomainError on invalid", () => {
    expect(() => assertScopeTransition("draft", "closed")).toThrow();
    try {
      assertScopeTransition("draft", "closed");
    } catch (err) {
      const e = err as {
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
        retriable?: boolean;
      };
      expect(e.code).toBe("INVALID_SCOPE_TRANSITION");
      expect(e.message).toBeTruthy();
      expect(e.details).toMatchObject({ from: "draft", to: "closed" });
      expect(typeof e.retriable).toBe("boolean");
    }
  });

  it("every transition's owner is a known role", () => {
    for (const t of SCOPE_TRANSITIONS) {
      expect(ROLES).toContain(t.owner);
      expect(t.precondition.length).toBeGreaterThan(0);
    }
  });

  it("every transition references known scope states", () => {
    for (const t of SCOPE_TRANSITIONS) {
      expect(SCOPE_STATES).toContain(t.from);
      expect(SCOPE_STATES).toContain(t.to);
    }
  });
});

describe("task state machine", () => {
  it("includes the full happy path from design.md", () => {
    const path: ReadonlyArray<[TaskState, TaskState]> = [
      ["created", "ready"],
      ["ready", "claimed"],
      ["claimed", "in_progress"],
      ["in_progress", "review_requested"],
      ["review_requested", "merge_ready"],
      ["merge_ready", "merged"],
      ["merged", "closed"],
    ];
    for (const [from, to] of path) {
      const r = checkTaskTransition(from, to);
      expect(r.ok, `${from} -> ${to}`).toBe(true);
      expect(r.transition?.owner).toBeTruthy();
      expect(r.transition?.precondition.length).toBeGreaterThan(0);
    }
  });

  it("loops review_requested -> changes_requested -> in_progress", () => {
    expect(canTransitionTask("review_requested", "changes_requested")).toBe(
      true,
    );
    expect(canTransitionTask("changes_requested", "in_progress")).toBe(true);
  });

  it("forbids skipping review on the way to merged", () => {
    const r = checkTaskTransition("in_progress", "merged");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("INVALID_TASK_TRANSITION");
  });

  it("forbids changes_requested -> merge_ready without re-review", () => {
    const r = checkTaskTransition("changes_requested", "merge_ready");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("INVALID_TASK_TRANSITION");
    expect(r.error?.details).toMatchObject({
      from: "changes_requested",
      to: "merge_ready",
    });
  });

  it("forbids transitions out of closed", () => {
    const r = checkTaskTransition("closed", "in_progress");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("TERMINAL_STATE");
  });

  it("forbids transitions out of canceled and failed", () => {
    expect(checkTaskTransition("canceled", "ready").error?.code).toBe(
      "TERMINAL_STATE",
    );
    expect(checkTaskTransition("failed", "in_progress").error?.code).toBe(
      "TERMINAL_STATE",
    );
  });

  it("allows pending_sync from any non-terminal active state", () => {
    expect(canTransitionTask("in_progress", "pending_sync")).toBe(true);
    expect(canTransitionTask("merge_ready", "pending_sync")).toBe(true);
    expect(canTransitionTask("merged", "pending_sync")).toBe(true);
  });

  it("allows recovery from pending_sync but not from terminal failed", () => {
    expect(canTransitionTask("pending_sync", "in_progress")).toBe(true);
    expect(canTransitionTask("failed", "in_progress")).toBe(false);
  });

  it("assertTaskTransition throws structured error on invalid", () => {
    try {
      assertTaskTransition("created", "merged");
      throw new Error("expected throw");
    } catch (err) {
      const e = err as {
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
        retriable?: boolean;
      };
      expect(e.code).toBe("INVALID_TASK_TRANSITION");
      expect(e.details).toMatchObject({ from: "created", to: "merged" });
      expect(typeof e.retriable).toBe("boolean");
    }
  });

  it("every transition's owner is a known role and references known task states", () => {
    for (const t of TASK_TRANSITIONS) {
      expect(ROLES).toContain(t.owner);
      expect(TASK_STATES).toContain(t.from);
      expect(TASK_STATES).toContain(t.to);
      expect(t.precondition.length).toBeGreaterThan(0);
    }
  });
});
