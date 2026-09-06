import type { AuditRow, FaultLayer } from "@colony/core";
import { parseFault } from "@colony/core";
import type { NotificationEvent } from "./types.js";

export interface ClassifyContext {
  isManualApprovals(scope_id: string): boolean;
  /** Blocked reason for a TASK, read from tasks.blocked_reason by the caller; null when absent. */
  blockedReason(task_id: string): string | null;
  /** Stored fault_json for a finished run; null when the run is unknown. */
  runFaultJson?(run_id: string): string | null;
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
      if (detail.status !== "failed") return null;
      if (!scopeId) return null;
      const error =
        typeof detail.error === "string" && detail.error.length > 0
          ? detail.error
          : "Run failed.";
      // The producer contract: finishRun echoes the run's fault on the
      // run.finished audit detail. A model fault is the agent's failure;
      // every other layer — and a missing or unreadable fault, resolved
      // through the stored run row before falling back to unknown — is
      // platform noise.
      const layer = runFinishedLayer(detail, row, ctx);
      if (layer === "model") {
        return {
          class: "agent",
          severity: "warning",
          scope_id: scopeId,
          ...(row.task_id ? { task_id: row.task_id } : {}),
          title: `Agent failure in ${scopeId}`,
          body: error,
          count: 1,
        };
      }
      return {
        class: "infra",
        severity: "warning",
        scope_id: scopeId,
        ...(row.task_id ? { task_id: row.task_id } : {}),
        title: `Infrastructure failure in ${scopeId}`,
        body: error,
        count: 1,
      };
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

/**
 * Resolve the fault layer for a failed run.finished audit row: the inline
 * detail.fault first, then the stored run row's fault_json, then unknown.
 */
function runFinishedLayer(
  detail: Record<string, unknown>,
  row: AuditRow,
  ctx: ClassifyContext,
): FaultLayer {
  const inline = detail["fault"];
  if (
    inline !== null &&
    typeof inline === "object" &&
    !Array.isArray(inline) &&
    typeof (inline as Record<string, unknown>)["layer"] === "string"
  ) {
    const layer = (inline as Record<string, unknown>)["layer"] as string;
    if (isFaultLayer(layer)) return layer;
  }
  const runId =
    typeof row.run_id === "string"
      ? row.run_id
      : typeof detail["run_id"] === "string"
        ? (detail["run_id"] as string)
        : null;
  const stored = runId ? (ctx.runFaultJson?.(runId) ?? null) : null;
  return parseFault(stored)?.layer ?? "unknown";
}

function isFaultLayer(value: string): value is FaultLayer {
  return (
    value === "model" ||
    value === "harness" ||
    value === "sandbox" ||
    value === "provider" ||
    value === "colonyd" ||
    value === "unknown"
  );
}
