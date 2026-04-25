export type RepositoryErrorCode =
  | "STATE_VERSION_MISMATCH"
  | "NOT_FOUND"
  | "INVALID_STATE_TRANSITION"
  | "TERMINAL_STATE"
  | "UNIQUE_VIOLATION";

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
