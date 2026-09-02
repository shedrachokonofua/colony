import type { AuditRow } from "@colony/core";
import { isInfraError } from "../run-classification.js";
import type { NotificationEvent } from "./types.js";

export interface ClassifyContext {
  isManualApprovals(scope_id: string): boolean;
  /** Blocked reason for a TASK, read from tasks.blocked_reason by the caller; null when absent. */
  blockedReason(task_id: string): string | null;
}

function parseDetail(detailJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(detailJson);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export function classifyAuditRow(
  row: AuditRow,
  ctx: ClassifyContext,
): NotificationEvent | null {
  const detail = parseDetail(row.detail_json);
  const scopeId =
    row.scope_id ??
    (typeof detail.scope_id === "string" ? detail.scope_id : "");

  switch (row.action) {
    case "scope.plan_proposed": {
      if (!scopeId || !ctx.isManualApprovals(scopeId)) return null;
      return {
        class: "action_needed",
        severity: "critical",
        scope_id: scopeId,
        title: `Plan proposed for ${scopeId}`,
        body: "The plan awaits operator approval.",
        count: 1,
      };
    }

    case "review.approved": {
      if (!scopeId || !ctx.isManualApprovals(scopeId)) return null;
      return {
        class: "action_needed",
        severity: "critical",
        scope_id: scopeId,
        ...(row.task_id ? { task_id: row.task_id } : {}),
        title: row.task_id
          ? `Review approved for ${row.task_id}`
          : `Review approved for ${scopeId}`,
        body: "Merge awaits operator approval.",
        count: 1,
      };
    }

    case "scope.human_required": {
      if (!scopeId || !ctx.isManualApprovals(scopeId)) return null;
      const reason =
        typeof detail.reason === "string"
          ? detail.reason
          : "Human operator intervention required.";
      return {
        class: "action_needed",
        severity: "critical",
        scope_id: scopeId,
        title: `Action needed for ${scopeId}`,
        body: reason,
        count: 1,
      };
    }

    case "task.transition": {
      if (detail.to !== "blocked") return null;
      if (!scopeId) return null;
      const taskReason = row.task_id ? ctx.blockedReason(row.task_id) : null;
      const body = taskReason ?? "Task is blocked.";
      return {
        class: "blocked",
        severity: "critical",
        scope_id: scopeId,
        ...(row.task_id ? { task_id: row.task_id } : {}),
        title: row.task_id
          ? `Task ${row.task_id} blocked`
          : `Task blocked in ${scopeId}`,
        body,
        count: 1,
      };
    }

    case "scope.transition": {
      if (detail.to === "blocked") {
        if (!scopeId) return null;
        const body =
          typeof detail.blocked_reason === "string" &&
          detail.blocked_reason.length > 0
            ? detail.blocked_reason
            : "Scope is blocked.";
        return {
          class: "blocked",
          severity: "critical",
          scope_id: scopeId,
          title: `Scope ${scopeId} blocked`,
          body,
          count: 1,
        };
      }
      if (detail.to === "done") {
        if (!scopeId) return null;
        return {
          class: "progress",
          severity: "info",
          scope_id: scopeId,
          title: `Scope ${scopeId} completed`,
          body: `Scope ${scopeId} transitioned to done.`,
          count: 1,
        };
      }
      return null;
    }

    case "run.finished": {
      if (detail.status === "failed") {
        const error = typeof detail.error === "string" ? detail.error : null;
        if (isInfraError(error)) {
          if (!scopeId) return null;
          return {
            class: "infra",
            severity: "warning",
            scope_id: scopeId,
            ...(row.task_id ? { task_id: row.task_id } : {}),
            title: `Infrastructure failure in ${scopeId}`,
            body: error ?? "Infrastructure error occurred during run.",
            count: 1,
          };
        }
      }
      return null;
    }

    case "mr.merged": {
      if (!scopeId) return null;
      return {
        class: "progress",
        severity: "info",
        scope_id: scopeId,
        ...(row.task_id ? { task_id: row.task_id } : {}),
        title: row.task_id
          ? `MR merged for task ${row.task_id}`
          : `MR merged in ${scopeId}`,
        body: "MR merged successfully.",
        count: 1,
      };
    }

    default:
      return null;
  }
}
