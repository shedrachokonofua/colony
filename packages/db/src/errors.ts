export type RepositoryErrorCode =
  | "STATE_VERSION_MISMATCH"
  | "NOT_FOUND"
  | "INVALID_STATE_TRANSITION"
  | "TERMINAL_STATE"
  | "UNIQUE_VIOLATION"
  | "INVALID_SCOPE_STATE"
  | "STALE_DECOMPOSITION_ENVELOPE"
  | "INVALID_DECOMPOSITION_STATUS"
  | "REVIEW_NOT_APPROVED"
  | "DECOMPOSITION_NOT_APPROVED"
  | "DAG_ALREADY_COMMITTED"
  | "MISSING_TASK_TARGET"
  | "EMPTY_DECOMPOSITION"
  | "DUPLICATE_TASK_ID"
  | "TASK_SCOPE_MISMATCH"
  | "MISSING_ACCEPTANCE_CRITERIA"
  | "UNKNOWN_DEPENDENCY_TASK"
  | "SELF_DEPENDENCY"
  | "UNKNOWN_TARGET_TASK"
  | "INVALID_TASK_STATE";

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: RepositoryErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "RepositoryError";
    this.code = code;
    this.details = details;
  }
}
