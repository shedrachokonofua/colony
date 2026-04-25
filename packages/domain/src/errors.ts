export type DomainErrorCode =
  | "INVALID_SCOPE_TRANSITION"
  | "INVALID_TASK_TRANSITION"
  | "UNKNOWN_SCOPE_STATE"
  | "UNKNOWN_TASK_STATE"
  | "TERMINAL_STATE"
  | "STATE_VERSION_MISMATCH";

export type DomainErrorDetails = Readonly<Record<string, unknown>>;

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly details: DomainErrorDetails;
  readonly retriable: boolean;
}

export const domainError = (
  code: DomainErrorCode,
  message: string,
  details: DomainErrorDetails = {},
  retriable = false,
): DomainError => ({ code, message, details, retriable });

export class DomainStateError extends Error implements DomainError {
  readonly code: DomainErrorCode;
  readonly details: DomainErrorDetails;
  readonly retriable: boolean;

  constructor(error: DomainError) {
    super(error.message);
    this.name = "DomainStateError";
    this.code = error.code;
    this.details = error.details;
    this.retriable = error.retriable;
  }
}
