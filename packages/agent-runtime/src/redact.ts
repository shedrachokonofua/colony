/**
 * Redaction for persisted audit strings: commands, cwd, and output tails must
 * never carry provider tokens into the database. The token stays out of logs
 * and the activity feed; the redaction marker is stable so operators can spot
 * where a secret used to be.
 */

export const REDACTED = "[REDACTED]";

/** `glpat-…` GitLab personal/project token. */
const GITLAB_TOKEN = /glpat-[A-Za-z0-9_-]+/g;
/** OpenAI-style `sk-…` secret keys. */
const SK_TOKEN = /sk-[A-Za-z0-9_-]{8,}/g;
/** HTTP Authorization bearer headers. */
const BEARER_TOKEN = /Bearer [A-Za-z0-9._~+/=-]+/g;

/**
 * Replace the well-known token patterns plus any caller-supplied exact
 * secrets (the run's own provider token) with `[REDACTED]`. Never throws:
 * a redaction failure must not break an audit emit.
 */
export function redactText(text: string, secrets?: readonly string[]): string {
  try {
    let redacted = text
      .replaceAll(GITLAB_TOKEN, REDACTED)
      .replaceAll(SK_TOKEN, REDACTED)
      .replaceAll(BEARER_TOKEN, REDACTED);
    if (secrets) {
      for (const secret of secrets) {
        if (secret) redacted = redacted.split(secret).join(REDACTED);
      }
    }
    return redacted;
  } catch {
    return REDACTED;
  }
}

/**
 * Deep redaction: strings at any depth are redacted, objects/arrays are
 * recursed, other scalars pass through untouched. Cycles are left to the
 * JSON.stringify guard in the caller — event details are plain data.
 */
export function redactValue(
  value: unknown,
  secrets?: readonly string[],
): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, secrets));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      copy[key] = redactValue(entry, secrets);
    }
    return copy;
  }
  return value;
}
