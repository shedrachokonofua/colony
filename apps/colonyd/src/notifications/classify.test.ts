import { describe, expect, it } from "bun:test";
import type { AuditRow } from "@colony/core";
import { classifyAuditRow, type ClassifyContext } from "./classify.js";

function makeRow(partial: Partial<AuditRow> & { action: string }): AuditRow {
  return {
    id: 1,
    at: new Date().toISOString(),
    actor: "system",
    scope_id: "col-scope-1",
    task_id: "col-scope-1.0",
    run_id: "run-1",
    detail_json: "{}",
    ...partial,
  };
}

const mockCtx: ClassifyContext = {
  isManualApprovals: (scopeId) => scopeId === "col-manual-scope",
  blockedReason: (taskId) =>
    taskId === "col-task-blocked" ? "Dependency failed to install" : null,
};

describe("classifyAuditRow", () => {
  describe("scope.plan_proposed", () => {
    it("returns action_needed when manual approvals enabled", () => {
      const row = makeRow({
        action: "scope.plan_proposed",
        scope_id: "col-manual-scope",
      });
      const res = classifyAuditRow(row, mockCtx);
      expect(res).toEqual({
        class: "action_needed",
        severity: "critical",
        scope_id: "col-manual-scope",
        title: "Plan proposed for col-manual-scope",
        body: "The plan awaits operator approval.",
        count: 1,
      });
    });

    it("returns null when manual approvals disabled", () => {
      const row = makeRow({
        action: "scope.plan_proposed",
        scope_id: "col-auto-scope",
      });
      expect(classifyAuditRow(row, mockCtx)).toBeNull();
    });
  });

  describe("review.approved", () => {
    it("returns action_needed when manual approvals enabled (with task_id)", () => {
      const row = makeRow({
        action: "review.approved",
        scope_id: "col-manual-scope",
        task_id: "col-manual-scope.1",
      });
      const res = classifyAuditRow(row, mockCtx);
      expect(res).toEqual({
        class: "action_needed",
        severity: "critical",
        scope_id: "col-manual-scope",
        task_id: "col-manual-scope.1",
        title: "Review approved for col-manual-scope.1",
        body: "Merge awaits operator approval.",
        count: 1,
      });
    });

    it("returns null when manual approvals disabled", () => {
      const row = makeRow({
        action: "review.approved",
        scope_id: "col-auto-scope",
      });
      expect(classifyAuditRow(row, mockCtx)).toBeNull();
    });
  });

  describe("scope.human_required", () => {
    it("returns action_needed with reason when manual approvals enabled", () => {
      const row = makeRow({
        action: "scope.human_required",
        scope_id: "col-manual-scope",
        detail_json: JSON.stringify({ reason: "Conflict resolution required" }),
      });
      const res = classifyAuditRow(row, mockCtx);
      expect(res).toEqual({
        class: "action_needed",
        severity: "critical",
        scope_id: "col-manual-scope",
        title: "Action needed for col-manual-scope",
        body: "Conflict resolution required",
        count: 1,
      });
    });

    it("returns null when manual approvals disabled", () => {
      const row = makeRow({
        action: "scope.human_required",
        scope_id: "col-auto-scope",
        detail_json: JSON.stringify({ reason: "Conflict" }),
      });
      expect(classifyAuditRow(row, mockCtx)).toBeNull();
    });
  });

  describe("task.transition", () => {
    it("returns blocked event with reason from ctx.blockedReason when to === 'blocked'", () => {
      const row = makeRow({
        action: "task.transition",
        scope_id: "col-any-scope",
        task_id: "col-task-blocked",
        detail_json: JSON.stringify({ from: "running", to: "blocked" }),
      });
      const res = classifyAuditRow(row, mockCtx);
      expect(res).toEqual({
        class: "blocked",
        severity: "critical",
        scope_id: "col-any-scope",
        task_id: "col-task-blocked",
        title: "Task col-task-blocked blocked",
        body: "Dependency failed to install",
        count: 1,
      });
    });

    it("falls back to generic phrase when ctx.blockedReason returns null", () => {
      const row = makeRow({
        action: "task.transition",
        scope_id: "col-any-scope",
        task_id: "col-task-other",
        detail_json: JSON.stringify({ from: "running", to: "blocked" }),
      });
      const res = classifyAuditRow(row, mockCtx);
      expect(res).toEqual({
        class: "blocked",
        severity: "critical",
        scope_id: "col-any-scope",
        task_id: "col-task-other",
        title: "Task col-task-other blocked",
        body: "Task is blocked.",
        count: 1,
      });
    });

    it("returns null when transition is not to blocked", () => {
      const row = makeRow({
        action: "task.transition",
        detail_json: JSON.stringify({ from: "running", to: "done" }),
      });
      expect(classifyAuditRow(row, mockCtx)).toBeNull();
    });
  });

  describe("scope.transition", () => {
    it("returns blocked event with detail.blocked_reason when to === 'blocked'", () => {
      const row = makeRow({
        action: "scope.transition",
        scope_id: "col-scope-1",
        detail_json: JSON.stringify({
          from: "running",
          to: "blocked",
          blocked_reason: "All tasks failed validation",
        }),
      });
      const res = classifyAuditRow(row, mockCtx);
      expect(res).toEqual({
        class: "blocked",
        severity: "critical",
        scope_id: "col-scope-1",
        title: "Scope col-scope-1 blocked",
        body: "All tasks failed validation",
        count: 1,
      });
    });

    it("returns progress event when to === 'done'", () => {
      const row = makeRow({
        action: "scope.transition",
        scope_id: "col-scope-1",
        detail_json: JSON.stringify({ from: "running", to: "done" }),
      });
      const res = classifyAuditRow(row, mockCtx);
      expect(res).toEqual({
        class: "progress",
        severity: "info",
        scope_id: "col-scope-1",
        title: "Scope col-scope-1 completed",
        body: "Scope col-scope-1 transitioned to done.",
        count: 1,
      });
    });
  });

  describe("run.finished", () => {
    it("returns infra event on infra failure", () => {
      const row = makeRow({
        action: "run.finished",
        scope_id: "col-scope-1",
        task_id: "col-scope-1.0",
        detail_json: JSON.stringify({
          status: "failed",
          error: "process_restart",
        }),
      });
      const res = classifyAuditRow(row, mockCtx);
      expect(res).toEqual({
        class: "infra",
        severity: "warning",
        scope_id: "col-scope-1",
        task_id: "col-scope-1.0",
        title: "Infrastructure failure in col-scope-1",
        body: "process_restart",
        count: 1,
      });
    });

    it("returns null on non-infra failure", () => {
      const row = makeRow({
        action: "run.finished",
        scope_id: "col-scope-1",
        detail_json: JSON.stringify({
          status: "failed",
          error: "Assertion failed: expected 1 to be 2",
        }),
      });
      expect(classifyAuditRow(row, mockCtx)).toBeNull();
    });

    it("returns null on successful run", () => {
      const row = makeRow({
        action: "run.finished",
        scope_id: "col-scope-1",
        detail_json: JSON.stringify({ status: "success" }),
      });
      expect(classifyAuditRow(row, mockCtx)).toBeNull();
    });
  });

  describe("mr.merged", () => {
    it("returns progress event", () => {
      const row = makeRow({
        action: "mr.merged",
        scope_id: "col-scope-1",
        task_id: "col-scope-1.0",
      });
      const res = classifyAuditRow(row, mockCtx);
      expect(res).toEqual({
        class: "progress",
        severity: "info",
        scope_id: "col-scope-1",
        task_id: "col-scope-1.0",
        title: "MR merged for task col-scope-1.0",
        body: "MR merged successfully.",
        count: 1,
      });
    });
  });

  describe("other actions", () => {
    it("returns null for unrelated actions", () => {
      for (const action of [
        "scope.created",
        "mr.conflicted",
        "tick.phase_error",
        "scope.unblocked",
      ]) {
        const row = makeRow({ action, scope_id: "col-scope-1" });
        expect(classifyAuditRow(row, mockCtx)).toBeNull();
      }
    });
  });
});
