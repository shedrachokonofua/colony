import { DomainStateError, domainError } from "@colony/domain";

export const TASK_STATES = [
  "queued",
  "running",
  "mr_open",
  "merged",
  "blocked",
  "canceled",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const SCOPE_STATUSES = [
  "draft",
  "planning",
  "active",
  "validating",
  "blocked",
  "done",
  "abandoned",
] as const;

export type ScopeStatus = (typeof SCOPE_STATUSES)[number];

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "merged",
  "canceled",
]);

export const TERMINAL_SCOPE_STATUSES: ReadonlySet<ScopeStatus> = new Set([
  "done",
  "abandoned",
]);

/**
 * Exact task transition table. Anything absent throws DomainStateError.
 *
 *   queued   -> running    dispatch; deps all merged, next_retry_at<=now, scope active
 *   running  -> mr_open    implement run succeeded: branch pushed, MR opened by colonyd
 *   running  -> queued     run failed/lease expired, or operator stops a run for retry
 *   running  -> blocked    attempts exhausted, or envelope status='blocked'
 *   mr_open  -> merged     gate passed AND GitLab reports merged at gated SHA
 *   mr_open  -> queued     gate failed -> requeue with evidence; attempt++
 *   mr_open  -> blocked    3 consecutive gate failures on same head SHA, or merge refused 3x
 *   queued/blocked -> merged provider observed a merge after an ambiguous gate timeout
 *   blocked  -> queued     operator unblock; resets attempt=0, next_retry_at=NULL
 *   canceled -> queued     operator restores a permanently canceled task
 *   any nonterminal -> canceled (operator)
 */
const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  queued: ["running", "merged", "canceled"],
  running: ["mr_open", "queued", "blocked", "canceled"],
  mr_open: ["merged", "queued", "blocked", "canceled"],
  merged: [],
  blocked: ["queued", "merged", "canceled"],
  canceled: ["queued"],
};

/**
 * Exact scope transition table.
 *
 *   draft    -> planning   architect run dispatched
 *   planning -> active     plan approved: tasks+deps materialized
 *   planning -> blocked    architect run failed after retries
 *   active   -> done       all tasks merged|canceled, >=1 merged
 *   active   -> blocked    unfinished tasks exist, none runnable, none running
 *   active   -> validating all tasks terminal with >=1 merged
 *   validating -> done     validation pass
 *   validating -> active   repair tasks materialize / canceled task restored
 *   validating -> abandoned (operator)
 *   blocked  -> planning|active (operator retry/unblock)
 *   done     -> active     operator restores a canceled task
 *   any nonterminal -> abandoned (operator)
 */
const SCOPE_TRANSITIONS: Readonly<Record<ScopeStatus, readonly ScopeStatus[]>> =
  {
    draft: ["planning", "abandoned"],
    planning: ["active", "blocked", "abandoned"],
    active: ["done", "blocked", "abandoned", "validating"],
    validating: ["done", "active", "planning", "blocked", "abandoned"],
    blocked: ["planning", "active", "validating", "abandoned"],
    done: ["active"],
    abandoned: [],
  };

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  const allowed = TASK_TRANSITIONS[from];
  if (!allowed) {
    throw new DomainStateError(
      domainError("UNKNOWN_TASK_STATE", `unknown task state: ${from}`, {
        from,
        to,
      }),
    );
  }
  if (!allowed.includes(to)) {
    throw new DomainStateError(
      domainError(
        "INVALID_TASK_TRANSITION",
        `illegal task transition: ${from} -> ${to}`,
        { from, to },
      ),
    );
  }
}

export function assertScopeTransition(
  from: ScopeStatus,
  to: ScopeStatus,
): void {
  const allowed = SCOPE_TRANSITIONS[from];
  if (!allowed) {
    throw new DomainStateError(
      domainError("UNKNOWN_SCOPE_STATE", `unknown scope status: ${from}`, {
        from,
        to,
      }),
    );
  }
  if (!allowed.includes(to)) {
    throw new DomainStateError(
      domainError(
        "INVALID_SCOPE_TRANSITION",
        `illegal scope transition: ${from} -> ${to}`,
        { from, to },
      ),
    );
  }
}

/** Exponential retry backoff: 10s, 20s, 40s, ... capped at 5min. */
export function retryBackoffMs(attempt: number): number {
  return Math.min(10_000 * 2 ** (attempt - 1), 300_000);
}
